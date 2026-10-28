use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use url::Url;

/// Una lista canali salvata dall'utente.
#[derive(Clone, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    /// Vuoto per le liste caricate da file.
    pub url: String,
    /// Nome del file, per le liste caricate dal disco anziché da un URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// URL finale dopo i redirect: serve a risolvere i percorsi relativi della copia salvata.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Momento dell'ultimo download riuscito (secondi Unix).
    #[serde(default)]
    pub updated_at: Option<u64>,
}

/// Server proxy attraverso cui passa tutto il traffico dell'app (liste, guida, video, loghi).
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Proxy {
    pub enabled: bool,
    /// "socks5://host:porta", "http://host:porta" o "https://host:porta".
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub sources: Vec<Source>,
    /// Lista selezionata nell'ultima sessione.
    pub active: Option<String>,
    pub proxy: Proxy,

    // Formato precedente (una sola lista): letto solo per la migrazione.
    #[serde(skip_serializing)]
    source: Option<String>,
    #[serde(skip_serializing)]
    base_url: Option<String>,
    #[serde(skip_serializing)]
    updated_at: Option<u64>,
}

impl Settings {
    pub fn get(&self, id: &str) -> Option<&Source> {
        self.sources.iter().find(|s| s.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Source> {
        self.sources.iter_mut().find(|s| s.id == id)
    }
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos:x}")
}

/// Nome proposto per una lista: l'host dell'URL, senza "www.".
pub fn default_name(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_else(|| url.to_string())
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

/// File di una lista (copia scaricata o organizzazione). Gli id arrivano dalla UI:
/// si accettano solo quelli generati da `new_id`, così non possono uscire dalla cartella.
fn list_file(app: &AppHandle, id: &str, ext: &str) -> Option<PathBuf> {
    let valid = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric());
    valid.then(|| data_dir(app)).flatten().map(|d| d.join("lists").join(format!("{id}.{ext}")))
}

pub fn load(app: &AppHandle) -> Settings {
    let mut s: Settings = config_file(app)
        .and_then(|p| fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();

    // Migrazione dalla versione con una sola lista: diventa la prima lista salvata.
    if let Some(url) = s.source.take() {
        if s.sources.is_empty() {
            let id = new_id();
            if let (Some(old), Some(new)) = (data_dir(app).map(|d| d.join("playlist.cache")), list_file(app, &id, "cache")) {
                if old.exists() {
                    let _ = new.parent().map(fs::create_dir_all);
                    let _ = fs::rename(old, new);
                }
            }
            s.sources.push(Source {
                id: id.clone(),
                name: default_name(&url),
                url,
                file: None,
                base_url: s.base_url.take(),
                updated_at: s.updated_at.take(),
            });
            s.active = Some(id);
            let _ = save(app, &s);
        }
    }
    s
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let p = config_file(app).ok_or("cartella di configurazione non disponibile")?;
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    write(p, &json)
}

/// Copia della lista scaricata, così all'avvio non va riscaricata.
pub fn cache_path(app: &AppHandle, id: &str) -> Option<PathBuf> {
    list_file(app, id, "cache")
}

/// Lista in arrivo: si scarica qui e diventa la copia salvata solo se si legge senza errori.
pub fn part_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let p = list_file(app, id, "part").ok_or("id lista non valido")?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(p)
}

/// La lista appena scaricata (e letta) sostituisce la copia salvata.
pub fn commit_part(app: &AppHandle, id: &str) -> Result<(), String> {
    let cache = cache_path(app, id).ok_or("id lista non valido")?;
    fs::rename(part_path(app, id)?, cache).map_err(|e| e.to_string())
}

pub fn remove_part(app: &AppHandle, id: &str) {
    if let Ok(p) = part_path(app, id) {
        let _ = fs::remove_file(p);
    }
}

/// Copia della guida dei programmi della lista (come scaricata, anche compressa).
pub fn guide_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let p = list_file(app, id, "epg").ok_or("id lista non valido")?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(p)
}

pub fn write_cache(app: &AppHandle, id: &str, body: &str) -> Result<(), String> {
    write(list_file(app, id, "cache").ok_or("id lista non valido")?, body.as_bytes())
}

/// Cartelle e canali fissati di una lista (struttura gestita dalla UI).
pub fn read_org(app: &AppHandle, id: &str) -> Value {
    list_file(app, id, "org.json")
        .and_then(|p| fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

pub fn write_org(app: &AppHandle, id: &str, org: &Value) -> Result<(), String> {
    let json = serde_json::to_vec(org).map_err(|e| e.to_string())?;
    write(list_file(app, id, "org.json").ok_or("id lista non valido")?, &json)
}

pub fn remove_cache(app: &AppHandle, id: &str) {
    if let Some(p) = list_file(app, id, "cache") {
        let _ = fs::remove_file(p);
    }
}

pub fn remove_files(app: &AppHandle, id: &str) {
    remove_cache(app, id);
    remove_part(app, id);
    if let Ok(p) = guide_path(app, id) {
        let _ = fs::remove_file(p);
    }
    if let Some(p) = list_file(app, id, "org.json") {
        let _ = fs::remove_file(p);
    }
}

fn write(path: PathBuf, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, bytes).map_err(|e| e.to_string())
}
