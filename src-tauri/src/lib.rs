mod dvbsub;
mod meta;
mod net;
mod playlist;
mod proxy;
mod settings;

use playlist::Channel;
use serde::Serialize;
use serde_json::Value;
use settings::Source;
use std::time::{Duration, Instant};
#[cfg(desktop)]
use tauri::Manager;
use tauri::{AppHandle, Emitter};
use url::Url;

#[derive(Serialize)]
struct ChannelList {
    channels: Vec<Channel>,
    /// Data dell'ultimo download (secondi Unix).
    updated_at: u64,
}

#[derive(Serialize)]
struct Sources {
    sources: Vec<Source>,
    active: Option<String>,
}

/// Avanzamento del caricamento, mostrato dalla UI al posto del selettore liste.
#[derive(Clone, Serialize)]
struct Progress {
    phase: &'static str,
    bytes: u64,
    total: Option<u64>,
    count: usize,
}

fn progress(app: &AppHandle, phase: &'static str, bytes: u64, total: Option<u64>, count: usize) {
    let _ = app.emit("load-progress", Progress { phase, bytes, total, count });
}

fn check_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    let parsed = Url::parse(url).map_err(|_| "invalid_url".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("unsupported_scheme".into());
    }
    Ok(url.to_string())
}

fn list_name(name: &str, url: &str) -> String {
    let name = name.trim();
    if name.is_empty() { settings::default_name(url) } else { name.to_string() }
}

// ---------- Gestione liste ----------

#[tauri::command]
fn sources(app: AppHandle) -> Sources {
    let s = settings::load(&app);
    Sources { sources: s.sources, active: s.active }
}

/// Lista appena aggiunta, con i canali già letti.
#[derive(Serialize)]
struct Added {
    source: Source,
    list: ChannelList,
}

/// Base fittizia per le liste da file: gli URL relativi non hanno un server a cui riferirsi.
const LOCAL_BASE: &str = "file:///local/";

fn local_base() -> Url {
    Url::parse(LOCAL_BASE).expect("URL costante valido")
}

/// Nome proposto per una lista da file: il nome senza estensione.
fn file_list_name(name: &str, file_name: &str) -> String {
    let name = name.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    std::path::Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("M3U")
        .to_string()
}

/// Salva la copia della lista, la aggiunge all'elenco e la rende attiva.
fn store_new_source(app: &AppHandle, source: &Source, body: &str) -> Result<(), String> {
    settings::write_cache(app, &source.id, body)?;
    let mut s = settings::load(app);
    s.sources.push(source.clone());
    s.active = Some(source.id.clone());
    settings::save(app, &s)
}

/// Aggiunge una lista da URL. Viene salvata solo se si scarica e si legge correttamente:
/// con un formato non supportato (o un server irraggiungibile) l'elenco resta com'era.
#[tauri::command]
async fn add_source(app: AppHandle, name: String, url: String) -> Result<Added, String> {
    let url = check_url(&url)?;
    let parsed = Url::parse(&url).map_err(|_| "invalid_url".to_string())?;
    let (final_url, body) = download(&app, &parsed).await?;
    progress(&app, "parse", body.len() as u64, None, 0);
    let channels = parse(body.clone(), final_url.clone()).await?;
    progress(&app, "ready", 0, None, channels.len());

    let updated_at = settings::now();
    let source = Source {
        id: settings::new_id(),
        name: list_name(&name, &url),
        url,
        file: None,
        base_url: Some(final_url.to_string()),
        updated_at: Some(updated_at),
    };
    store_new_source(&app, &source, &body)?;
    Ok(Added { source, list: ChannelList { channels, updated_at } })
}

/// Aggiunge una lista dal contenuto di un file M3U scelto dall'utente (stesse regole di `add_source`).
#[tauri::command]
async fn add_source_file(app: AppHandle, name: String, file_name: String, content: String) -> Result<Added, String> {
    progress(&app, "parse", content.len() as u64, None, 0);
    let channels = parse(content.clone(), local_base()).await?;
    progress(&app, "ready", 0, None, channels.len());

    let updated_at = settings::now();
    let source = Source {
        id: settings::new_id(),
        name: file_list_name(&name, &file_name),
        url: String::new(),
        file: Some(file_name),
        base_url: Some(LOCAL_BASE.into()),
        updated_at: Some(updated_at),
    };
    store_new_source(&app, &source, &content)?;
    Ok(Added { source, list: ChannelList { channels, updated_at } })
}

/// Sostituisce il contenuto di una lista da file con una nuova versione del file.
#[tauri::command]
async fn replace_source_file(app: AppHandle, id: String, file_name: String, content: String) -> Result<ChannelList, String> {
    if settings::load(&app).get(&id).and_then(|s| s.file.as_ref()).is_none() {
        return Err("source_not_found".into());
    }
    progress(&app, "parse", content.len() as u64, None, 0);
    let channels = parse(content.clone(), local_base()).await?;
    progress(&app, "ready", 0, None, channels.len());

    let updated_at = settings::now();
    settings::write_cache(&app, &id, &content)?;
    let mut s = settings::load(&app);
    if let Some(source) = s.get_mut(&id) {
        source.file = Some(file_name);
        source.updated_at = Some(updated_at);
    }
    settings::save(&app, &s)?;
    Ok(ChannelList { channels, updated_at })
}

/// Rinomina una lista o ne cambia l'URL (in quel caso la copia salvata non vale più).
/// Le liste da file si possono solo rinominare.
#[tauri::command]
fn update_source(app: AppHandle, id: String, name: String, url: String) -> Result<Source, String> {
    let mut s = settings::load(&app);
    let source = s.get_mut(&id).ok_or("source_not_found")?;
    if source.file.is_some() {
        if !name.trim().is_empty() {
            source.name = name.trim().to_string();
        }
    } else {
        let url = check_url(&url)?;
        source.name = list_name(&name, &url);
        if source.url != url {
            source.url = url;
            source.base_url = None;
            source.updated_at = None;
            settings::remove_cache(&app, &id);
        }
    }
    let source = source.clone();
    settings::save(&app, &s)?;
    Ok(source)
}

/// Elimina una lista con i suoi file; restituisce la nuova lista attiva.
#[tauri::command]
fn remove_source(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let mut s = settings::load(&app);
    s.sources.retain(|x| x.id != id);
    if s.active.as_deref() == Some(id.as_str()) {
        s.active = s.sources.first().map(|x| x.id.clone());
    }
    settings::save(&app, &s)?;
    settings::remove_files(&app, &id);
    Ok(s.active)
}

#[tauri::command]
fn set_active(app: AppHandle, id: String) -> Result<(), String> {
    let mut s = settings::load(&app);
    if s.get(&id).is_none() {
        return Err("source_not_found".into());
    }
    s.active = Some(id);
    settings::save(&app, &s)
}

#[tauri::command]
fn load_org(app: AppHandle, id: String) -> Value {
    settings::read_org(&app, &id)
}

#[tauri::command]
fn save_org(app: AppHandle, id: String, org: Value) -> Result<(), String> {
    settings::write_org(&app, &id, &org)
}

// ---------- Canali ----------

/// Copia della lista salvata all'ultimo download, se presente.
#[tauri::command]
async fn cached_channels(app: AppHandle, id: String) -> Result<Option<ChannelList>, String> {
    let s = settings::load(&app);
    let Some(source) = s.get(&id) else { return Ok(None) };
    let (Some(base), Some(updated_at)) = (source.base_url.as_deref(), source.updated_at) else { return Ok(None) };
    let Ok(base) = Url::parse(base) else { return Ok(None) };
    let Some(body) = settings::read_cache(&app, &id) else { return Ok(None) };

    progress(&app, "parse", body.len() as u64, None, 0);
    match parse(body, base).await {
        Ok(channels) => {
            progress(&app, "ready", 0, None, channels.len());
            Ok(Some(ChannelList { channels, updated_at }))
        }
        // Copia illeggibile: la UI riscarica la lista.
        Err(_) => Ok(None),
    }
}

/// Scarica la lista dal server, la interpreta (JSON o M3U) e ne salva una copia.
#[tauri::command]
async fn load_channels(app: AppHandle, id: String) -> Result<ChannelList, String> {
    let url = settings::load(&app).get(&id).ok_or("source_not_found")?.url.clone();
    let parsed = Url::parse(&url).map_err(|_| "invalid_url".to_string())?;

    let (final_url, body) = download(&app, &parsed).await?;
    progress(&app, "parse", body.len() as u64, None, 0);
    let channels = parse(body.clone(), final_url.clone()).await?;
    progress(&app, "ready", 0, None, channels.len());

    let updated_at = settings::now();
    let saved = settings::write_cache(&app, &id, &body).and_then(|_| {
        let mut s = settings::load(&app);
        if let Some(source) = s.get_mut(&id) {
            source.base_url = Some(final_url.to_string());
            source.updated_at = Some(updated_at);
        }
        settings::save(&app, &s)
    });
    if let Err(e) = saved {
        eprintln!("impossibile salvare la lista: {e}");
    }
    Ok(ChannelList { channels, updated_at })
}

/// Programma in onda secondo la guida del pannello (solo canali Xtream Codes).
#[tauri::command]
async fn program_info(stream: String) -> Option<meta::Program> {
    meta::xtream_program(&stream).await
}

/// Chiude l'app. Serve su Android, dove "Indietro" conferma l'uscita dall'interfaccia
/// e la finestra non si può chiudere come su desktop.
#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// Il parsing di liste enormi (centinaia di migliaia di righe) va fuori dal thread asincrono.
async fn parse(body: String, base: Url) -> Result<Vec<Channel>, String> {
    tauri::async_runtime::spawn_blocking(move || playlist::parse(&body, &base))
        .await
        .map_err(|e| e.to_string())?
}

/// Scarica la lista segnalando l'avanzamento. Se il server la rifiuta o la restituisce
/// vuota, riprova con lo user agent di un browser.
async fn download(app: &AppHandle, url: &Url) -> Result<(Url, String), String> {
    let mut last_error = String::new();
    for user_agent in [None, Some(net::BROWSER_USER_AGENT)] {
        // Le liste IPTV possono pesare decine di MB: margine ampio.
        let mut req = net::client().get(url.clone()).timeout(Duration::from_secs(300));
        if let Some(ua) = user_agent {
            req = req.header(reqwest::header::USER_AGENT, ua);
        }
        let mut resp = req.send().await.map_err(net::describe)?;
        let status = resp.status();
        if !status.is_success() {
            last_error = match status.as_u16() {
                401 | 403 => format!("access_denied:{status}"),
                _ => format!("http_status:{status}"),
            };
            continue;
        }
        // Dopo eventuali redirect gli URL relativi vanno risolti sull'indirizzo finale.
        let final_url = resp.url().clone();
        let total = resp.content_length();
        let mut bytes = Vec::with_capacity(total.unwrap_or(0).min(256 << 20) as usize);
        let mut last_report = Instant::now();
        progress(app, "download", 0, total, 0);
        while let Some(chunk) = resp.chunk().await.map_err(net::describe)? {
            bytes.extend_from_slice(&chunk);
            if last_report.elapsed() >= Duration::from_millis(120) {
                last_report = Instant::now();
                progress(app, "download", bytes.len() as u64, total, 0);
            }
        }
        let body = String::from_utf8_lossy(&bytes).into_owned();
        if body.trim().is_empty() {
            last_error = "empty_list".into();
            continue;
        }
        return Ok((final_url, body));
    }
    Err(last_error)
}

/// Punto d'ingresso comune: l'eseguibile desktop (main.rs) e l'app Android.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("stream", |ctx, request, responder| {
            proxy::handle(ctx.app_handle().clone(), request, responder)
        });

    // Solo desktop: dimensione, posizione, ingrandimento e schermo intero dell'ultima sessione
    // (salvati alla chiusura). La finestra parte nascosta e compare già nello stato ripristinato.
    #[cfg(desktop)]
    let builder = builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        });

    builder
        .invoke_handler(tauri::generate_handler![
            sources,
            add_source,
            add_source_file,
            replace_source_file,
            update_source,
            remove_source,
            set_active,
            load_org,
            save_org,
            cached_channels,
            load_channels,
            program_info,
            exit_app
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di GlassPlay");
}
