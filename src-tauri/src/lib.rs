#[cfg(feature = "adult-filter")]
mod adult;
mod dvbsub;
mod epg;
mod meta;
mod net;
mod playlist;
mod proxy;
mod settings;
mod store;

use playlist::Channel;
use serde::Serialize;
use serde_json::Value;
use settings::Source;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use epg::{GuideInfo, Guides, Programme};
use store::{Active, Store};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

/// La lista aperta: i canali restano in Rust (vedi store.rs), l'interfaccia riceve solo
/// quanti sono e il numero che identifica questa apertura.
#[derive(Serialize)]
struct ListInfo {
    #[serde(flatten)]
    info: store::Info,
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

/// Lista appena aggiunta, già letta e aperta.
#[derive(Serialize)]
struct Added {
    source: Source,
    list: ListInfo,
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

/// Aggiunge la lista all'elenco e la rende attiva (la sua copia è già salvata).
fn register_source(app: &AppHandle, source: &Source) -> Result<(), String> {
    let mut s = settings::load(app);
    s.sources.push(source.clone());
    s.active = Some(source.id.clone());
    settings::save(app, &s)
}

/// Salva la copia della lista, la aggiunge all'elenco e la rende attiva.
fn store_new_source(app: &AppHandle, source: &Source, body: &str) -> Result<(), String> {
    settings::write_cache(app, &source.id, body)?;
    register_source(app, source)
}

/// Aggiunge una lista da URL. Viene salvata solo se si scarica e si legge correttamente:
/// con un formato non supportato (o un server irraggiungibile) l'elenco resta com'era.
#[tauri::command]
async fn add_source(app: AppHandle, active: State<'_, Active>, name: String, url: String) -> Result<Added, String> {
    let url = check_url(&url)?;
    let parsed = Url::parse(&url).map_err(|_| "invalid_url".to_string())?;
    let id = settings::new_id();
    let part = settings::part_path(&app, &id)?;
    let result = async {
        let final_url = download(&app, &parsed, &part).await?;
        let updated_at = settings::now();
        let source = Source {
            id: id.clone(),
            name: list_name(&name, &url),
            url: url.clone(),
            file: None,
            base_url: Some(final_url.to_string()),
            updated_at: Some(updated_at),
        };
        let (a, s) = (app.clone(), source.clone());
        let save = move || {
            settings::commit_part(&a, &s.id)?;
            register_source(&a, &s)
        };
        let store = prepare_file(&app, part.clone(), final_url, save).await?;
        Ok(Added { source, list: ListInfo { info: active.set(store), updated_at } })
    }
    .await;
    if result.is_err() {
        settings::remove_part(&app, &id);
    }
    result
}

/// Aggiunge una lista dal contenuto di un file M3U scelto dall'utente (stesse regole di `add_source`).
#[tauri::command]
async fn add_source_file(
    app: AppHandle,
    active: State<'_, Active>,
    name: String,
    file_name: String,
    content: String,
) -> Result<Added, String> {
    let updated_at = settings::now();
    let source = Source {
        id: settings::new_id(),
        name: file_list_name(&name, &file_name),
        url: String::new(),
        file: Some(file_name),
        base_url: Some(LOCAL_BASE.into()),
        updated_at: Some(updated_at),
    };
    let (a, s) = (app.clone(), source.clone());
    let store = prepare(&app, content, local_base(), move |body| store_new_source(&a, &s, body)).await?;
    Ok(Added { source, list: ListInfo { info: active.set(store), updated_at } })
}

/// Sostituisce il contenuto di una lista da file con una nuova versione del file.
#[tauri::command]
async fn replace_source_file(
    app: AppHandle,
    active: State<'_, Active>,
    id: String,
    file_name: String,
    content: String,
) -> Result<ListInfo, String> {
    if settings::load(&app).get(&id).and_then(|s| s.file.as_ref()).is_none() {
        return Err("source_not_found".into());
    }
    let updated_at = settings::now();
    let a = app.clone();
    let save = move |body: &str| {
        settings::write_cache(&a, &id, body)?;
        let mut s = settings::load(&a);
        if let Some(source) = s.get_mut(&id) {
            source.file = Some(file_name);
            source.updated_at = Some(updated_at);
        }
        settings::save(&a, &s)
    };
    let store = prepare(&app, content, local_base(), save).await?;
    Ok(ListInfo { info: active.set(store), updated_at })
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

/// Apre la copia della lista salvata all'ultimo download, se presente.
#[tauri::command]
async fn open_list(app: AppHandle, active: State<'_, Active>, id: String) -> Result<Option<ListInfo>, String> {
    let s = settings::load(&app);
    let Some(source) = s.get(&id) else { return Ok(None) };
    let (Some(base), Some(updated_at)) = (source.base_url.as_deref(), source.updated_at) else { return Ok(None) };
    let Ok(base) = Url::parse(base) else { return Ok(None) };
    let Some(path) = settings::cache_path(&app, &id).filter(|p| p.exists()) else { return Ok(None) };

    match prepare_file(&app, path, base, || Ok(())).await {
        Ok(store) => Ok(Some(ListInfo { info: active.set(store), updated_at })),
        // Copia illeggibile: la UI riscarica la lista.
        Err(_) => Ok(None),
    }
}

/// Scarica la lista dal server, la interpreta (JSON o M3U), ne salva una copia e la apre.
/// Se il download o la lettura non riescono, la copia salvata in precedenza resta com'era.
#[tauri::command]
async fn load_channels(app: AppHandle, active: State<'_, Active>, id: String) -> Result<ListInfo, String> {
    let url = settings::load(&app).get(&id).ok_or("source_not_found")?.url.clone();
    let parsed = Url::parse(&url).map_err(|_| "invalid_url".to_string())?;
    let part = settings::part_path(&app, &id)?;
    let result = async {
        let final_url = download(&app, &parsed, &part).await?;
        let updated_at = settings::now();
        let (a, i, base) = (app.clone(), id.clone(), final_url.to_string());
        let save = move || {
            let saved = settings::commit_part(&a, &i).and_then(|_| {
                let mut s = settings::load(&a);
                if let Some(source) = s.get_mut(&i) {
                    source.base_url = Some(base);
                    source.updated_at = Some(updated_at);
                }
                settings::save(&a, &s)
            });
            // La lista si apre comunque: al prossimo avvio verrà riscaricata.
            if let Err(e) = saved {
                eprintln!("impossibile salvare la lista: {e}");
            }
            Ok(())
        };
        let store = prepare_file(&app, part.clone(), final_url, save).await?;
        Ok(ListInfo { info: active.set(store), updated_at })
    }
    .await;
    if result.is_err() {
        settings::remove_part(&app, &id);
    }
    result
}

/// Libera la lista aperta (quando non ne resta nessuna).
#[tauri::command]
fn close_list(active: State<'_, Active>, guides: State<'_, Guides>) {
    active.clear();
    guides.clear();
}

/// I canali alle posizioni indicate: l'interfaccia li chiede man mano che diventano visibili.
#[tauri::command]
async fn channels(active: State<'_, Active>, serial: u64, indices: Vec<u32>) -> Result<Vec<Option<Channel>>, String> {
    active.with(serial, |s| s.channels(&indices))
}

/// Posizioni in binario (u32 little endian): con centinaia di migliaia di valori è molto
/// più leggero di un array JSON.
fn positions(list: &[u32]) -> Response {
    Response::new(list.iter().flat_map(|i| i.to_le_bytes()).collect::<Vec<u8>>())
}

/// Posizioni dei canali che corrispondono alla ricerca: per nome o gruppo e, se la guida è
/// caricata, per il programma in onda in questo momento.
#[tauri::command]
async fn search(active: State<'_, Active>, guides: State<'_, Guides>, serial: u64, query: String) -> Result<Response, String> {
    let mut hits = active.with(serial, |s| s.search(&query))?;
    let q = query.trim().to_lowercase();
    if let Some(airing) = guides.with(serial, |g| g.search_now(&q, settings::now() as i64)).filter(|a| !a.is_empty()) {
        hits.extend(airing);
        hits.sort_unstable();
        hits.dedup();
    }
    Ok(positions(&hits))
}

// ---------- Guida dei programmi ----------

/// Dopo questo tempo la copia della guida si riscarica.
const GUIDE_MAX_AGE: Duration = Duration::from_secs(6 * 3600);

/// Carica la guida dei programmi della lista aperta: quella del pannello Xtream o quella
/// dichiarata dalla lista. La copia scaricata vale qualche ora; se il server non risponde
/// si usa quella vecchia.
#[tauri::command]
async fn load_guide(
    app: AppHandle,
    active: State<'_, Active>,
    guides: State<'_, Guides>,
    id: String,
    serial: u64,
) -> Result<GuideInfo, String> {
    let list_url = settings::load(&app).get(&id).ok_or("source_not_found")?.url.clone();
    let (wanted, declared) = active.with(serial, |s| (s.epg_ids(), s.guide_url.clone()))?;
    let url = meta::xtream_guide_url(&list_url).or(declared).ok_or("no_guide")?;
    if wanted.is_empty() {
        return Err("no_guide".into());
    }
    let path = settings::guide_path(&app, &id)?;
    let age = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
    if age.is_none_or(|a| a > GUIDE_MAX_AGE) {
        let part = path.with_extension("epg.part");
        let fetched = match Url::parse(&url) {
            Ok(u) => download(&app, &u, &part).await,
            Err(_) => Err("no_guide".into()),
        };
        match fetched {
            Ok(_) => std::fs::rename(&part, &path).map_err(|e| e.to_string())?,
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                if age.is_none() {
                    return Err(e);
                }
            }
        }
    }
    let now = settings::now() as i64;
    let guide = tauri::async_runtime::spawn_blocking(move || epg::Guide::read(&path, wanted, now, serial))
        .await
        .map_err(|e| e.to_string())??;
    let info = guide.info();
    guides.set(guide);
    Ok(info)
}

/// Programma in onda su ciascun canale (per le righe della lista).
#[tauri::command]
async fn guide_now(guides: State<'_, Guides>, serial: u64, indices: Vec<u32>) -> Result<Vec<Option<Programme>>, String> {
    guides.with(serial, |g| g.now(&indices, settings::now() as i64)).ok_or_else(|| "no_guide".into())
}

/// Canali della lista che hanno programmi nella guida.
#[tauri::command]
async fn guide_channels(guides: State<'_, Guides>, serial: u64) -> Result<Response, String> {
    guides.with(serial, |g| positions(&g.channels())).ok_or_else(|| "no_guide".into())
}

/// Programmi di ciascun canale tra `from` e `to` (secondi Unix), per la pagina della guida.
#[tauri::command]
async fn guide_programmes(
    guides: State<'_, Guides>,
    serial: u64,
    indices: Vec<u32>,
    from: i64,
    to: i64,
) -> Result<Vec<Vec<Programme>>, String> {
    guides.with(serial, |g| g.between(&indices, from, to)).ok_or_else(|| "no_guide".into())
}

// ---------- Proxy ----------

#[tauri::command]
fn get_proxy(app: AppHandle) -> settings::Proxy {
    settings::load(&app).proxy
}

/// Salva e applica il proxy (se attivo, tutte le richieste dell'app passano da lì).
#[tauri::command]
fn set_proxy(app: AppHandle, proxy: settings::Proxy) -> Result<(), String> {
    net::set_proxy(&proxy)?;
    let mut s = settings::load(&app);
    s.proxy = proxy;
    settings::save(&app, &s)
}

/// Indirizzo IP con cui l'app si presenta ai server (attraverso il proxy, se attivo).
#[tauri::command]
async fn test_proxy() -> Result<String, String> {
    let resp = net::client()
        .get("https://api.ipify.org")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(net::describe)?;
    let ip = resp.text().await.map_err(net::describe)?;
    Ok(ip.trim().chars().take(64).collect())
}

// ---------- Liste pubbliche ----------

/// Paesi del catalogo iptv-org (nome, codice, bandiera), per la pagina delle liste pubbliche.
#[tauri::command]
async fn public_countries() -> Result<Value, String> {
    let resp = net::client()
        .get("https://iptv-org.github.io/api/countries.json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(net::describe)?;
    if !resp.status().is_success() {
        return Err(format!("http_status:{}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(net::describe)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("invalid_json:{e}"))
}

/// Posizione dei canali salvati (cartelle, fissati, ultimo canale), identificati dallo stream.
#[tauri::command]
async fn find_streams(active: State<'_, Active>, serial: u64, streams: Vec<String>) -> Result<Vec<i64>, String> {
    active.with(serial, |s| s.find(&streams))
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

/// Legge la lista (JSON o M3U) e la prepara per l'interfaccia, fuori dal thread asincrono:
/// con centinaia di migliaia di righe richiede qualche secondo. Solo se la lettura riesce,
/// `save` riceve il testo (per salvarne la copia); il testo viene poi liberato prima di
/// compattare i canali, così il picco di memoria resta contenuto.
async fn prepare<F>(app: &AppHandle, body: String, base: Url, save: F) -> Result<Store, String>
where
    F: FnOnce(&str) -> Result<(), String> + Send + 'static,
{
    progress(app, "parse", body.len() as u64, None, 0);
    let store = tauri::async_runtime::spawn_blocking(move || {
        let channels = playlist::parse(&body, &base)?;
        save(&body)?;
        let guide_url = playlist::guide_url(&body, &base);
        drop(body);
        let mut store = Store::new(channels);
        store.guide_url = guide_url;
        Ok::<_, String>(store)
    })
    .await
    .map_err(|e| e.to_string())??;
    progress(app, "ready", 0, None, store.info().count);
    Ok(store)
}

/// Come `prepare`, per una lista su disco: le M3U grandi si leggono riga per riga direttamente
/// nella forma compatta (vedi `playlist::parse_file`). `save` viene chiamata solo se la
/// lettura riesce.
async fn prepare_file<F>(app: &AppHandle, path: PathBuf, base: Url, save: F) -> Result<Store, String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    progress(app, "parse", std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0), None, 0);
    let store = tauri::async_runtime::spawn_blocking(move || {
        let mut store = Store::empty();
        store.guide_url = playlist::parse_file(&path, &base, |ch| store.push(&ch))?;
        save()?;
        store.finish();
        Ok::<_, String>(store)
    })
    .await
    .map_err(|e| e.to_string())??;
    progress(app, "ready", 0, None, store.info().count);
    Ok(store)
}

/// Scarica la lista nel file `dest` segnalando l'avanzamento: anche una lista da decine di MB
/// non passa dalla memoria. Se il server la rifiuta o la restituisce vuota, riprova con lo
/// user agent di un browser.
async fn download(app: &AppHandle, url: &Url, dest: &Path) -> Result<Url, String> {
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
        let mut file = BufWriter::new(File::create(dest).map_err(|e| e.to_string())?);
        let (mut bytes, mut blank) = (0u64, true);
        let mut last_report = Instant::now();
        progress(app, "download", 0, total, 0);
        while let Some(chunk) = resp.chunk().await.map_err(net::describe)? {
            blank &= chunk.iter().all(u8::is_ascii_whitespace);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            bytes += chunk.len() as u64;
            if last_report.elapsed() >= Duration::from_millis(120) {
                last_report = Instant::now();
                progress(app, "download", bytes, total, 0);
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        if blank {
            last_error = "empty_list".into();
            continue;
        }
        return Ok(final_url);
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
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
            .build(),
    );

    builder
        .setup(|app| {
            // Il proxy salvato vale fin dalla prima richiesta.
            let proxy = settings::load(app.handle()).proxy;
            if let Err(e) = net::set_proxy(&proxy) {
                eprintln!("[glassplay] proxy non applicato: {e}");
            }
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .manage(Active::default())
        .manage(Guides::default())
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
            open_list,
            load_channels,
            close_list,
            channels,
            search,
            find_streams,
            load_guide,
            guide_now,
            guide_channels,
            guide_programmes,
            get_proxy,
            set_proxy,
            test_proxy,
            public_countries,
            program_info,
            exit_app
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di GlassPlay");
}
