//! Interpretazione della risposta della sorgente: JSON (formati liberi) o playlist M3U.

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use url::Url;

#[derive(Debug, Clone, Serialize)]
pub struct Channel {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    pub stream: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Identificativo nella guida dei programmi (XMLTV), es. `tvg-id` nelle M3U.
    #[serde(skip)]
    pub epg_id: Option<String>,
}

const NAME_KEYS: &[&str] = &["name", "title", "nome", "titolo", "label", "channel", "canale", "tvg-name"];
const IMAGE_KEYS: &[&str] = &[
    "image", "logo", "icon", "img", "immagine", "thumbnail", "thumb", "poster", "picture", "cover",
    "tvg-logo", "logo_url", "image_url", "icon_url",
];
const STREAM_KEYS: &[&str] = &[
    "stream", "url", "stream_url", "streamurl", "m3u8", "m3u", "hls", "link", "src", "source",
    "file", "href", "uri", "video", "playback_url",
];
const GROUP_KEYS: &[&str] = &["group", "category", "categoria", "gruppo", "genre", "group-title"];
const EPG_KEYS: &[&str] = &["tvg-id", "tvg_id", "epg_id", "epg_channel_id", "xmltv_id"];
const LIST_KEYS: &[&str] = &["channels", "canali", "items", "data", "results", "list", "streams", "entries"];

pub fn parse(body: &str, base: &Url) -> Result<Vec<Channel>, String> {
    let text = body.trim_start_matches('\u{feff}').trim();

    let channels = if text.starts_with('{') || text.starts_with('[') {
        let value: Value =
            serde_json::from_str(text).map_err(|e| format!("invalid_json:{e}"))?;
        from_json(&value, base)
    } else if text.starts_with("#EXTM3U") || text.contains("#EXTINF") {
        let hls_tags = text.contains("#EXT-X-STREAM-INF") || text.contains("#EXT-X-TARGETDURATION");
        if hls_tags && !text.contains("tvg-") {
            // L'URL punta direttamente a un singolo flusso HLS.
            vec![Channel { name: stream_name(base), image: None, stream: base.to_string(), group: None, epg_id: None }]
        } else {
            from_m3u(text, base)
        }
    } else {
        return Err("unknown_format".into());
    };

    if channels.is_empty() {
        Err("no_channels".into())
    } else {
        Ok(channels)
    }
}

/// Risolve un URL eventualmente relativo rispetto all'indirizzo della sorgente.
pub fn resolve(base: &Url, s: &str) -> String {
    base.join(s).map(|u| u.to_string()).unwrap_or_else(|_| s.to_string())
}

/// Come `resolve`, ma per tutti gli URL di una lista. Quasi tutti condividono poche "cartelle"
/// (gli stream di un pannello Xtream, i loghi di uno stesso server): ogni cartella viene
/// risolta una volta sola e il nome finale aggiunto così com'è. Con centinaia di migliaia
/// di righe dimezza il tempo di lettura. I nomi finali che l'analisi degli URL potrebbe
/// modificare (caratteri da codificare, "." e "..", query) seguono la strada normale.
struct Resolver<'a> {
    base: &'a Url,
    /// Cartella → cartella risolta (None se non si presta alla scorciatoia).
    dirs: HashMap<String, Option<String>>,
}

impl<'a> Resolver<'a> {
    fn new(base: &'a Url) -> Self {
        Resolver { base, dirs: HashMap::new() }
    }

    fn resolve(&mut self, s: &str) -> String {
        let (dir, tail) = s.split_at(s.rfind('/').map_or(0, |i| i + 1));
        if dir.is_empty() || dir.contains(['?', '#', '\\']) || !plain_segment(tail) {
            return resolve(self.base, s);
        }
        if !self.dirs.contains_key(dir) {
            // Solo se la "/" chiude davvero una cartella del percorso (non "http://" senza percorso).
            let resolved = (!dir.ends_with("//"))
                .then(|| self.base.join(dir).ok())
                .flatten()
                .map(|u| u.to_string())
                .filter(|r| r.ends_with('/'));
            self.dirs.insert(dir.to_string(), resolved);
        }
        match &self.dirs[dir] {
            Some(r) => [r.as_str(), tail].concat(),
            None => resolve(self.base, s),
        }
    }
}

/// Ultimo segmento di un percorso che l'analisi degli URL lascia invariato.
fn plain_segment(t: &str) -> bool {
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@%".contains(&b)) {
        return false;
    }
    // "." e ".." (anche scritti %2e) sono segmenti speciali.
    let dots = t.len() <= 6 && matches!(t.to_ascii_lowercase().replace("%2e", ".").as_str(), "." | "..");
    !dots
}

fn stream_name(url: &Url) -> String {
    url.host_str().unwrap_or("Stream").to_string()
}

// ---------- JSON ----------

fn from_json(value: &Value, base: &Url) -> Vec<Channel> {
    let Some(items) = find_list(value, 0) else { return Vec::new() };
    let mut urls = Resolver::new(base);
    items
        .iter()
        .filter_map(Value::as_object)
        .enumerate()
        .filter_map(|(i, obj)| {
            let stream = field(obj, STREAM_KEYS)?;
            let name = field(obj, NAME_KEYS).unwrap_or_else(|| format!("#{}", i + 1));
            Some(Channel {
                name,
                image: field(obj, IMAGE_KEYS).map(|s| urls.resolve(&s)),
                stream: urls.resolve(&stream),
                group: field(obj, GROUP_KEYS),
                epg_id: field(obj, EPG_KEYS),
            })
        })
        .collect()
}

/// Cerca l'array di oggetti che contiene i canali, anche se annidato (es. `{"data": {"channels": [...]}}`).
fn find_list(value: &Value, depth: u8) -> Option<&Vec<Value>> {
    match value {
        Value::Array(items) if items.iter().any(Value::is_object) => Some(items),
        Value::Object(obj) if depth < 4 => {
            let preferred = LIST_KEYS
                .iter()
                .filter_map(|k| get_ci(obj, k))
                .find_map(|v| find_list(v, depth + 1));
            preferred.or_else(|| obj.values().find_map(|v| find_list(v, depth + 1)))
        }
        _ => None,
    }
}

fn get_ci<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    obj.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
}

/// Primo valore testuale non vuoto tra le chiavi candidate (accetta anche `{"url": ...}` annidati).
fn field(obj: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().filter_map(|k| get_ci(obj, k)).find_map(|v| match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Object(inner) => ["url", "src", "href"]
            .iter()
            .filter_map(|k| get_ci(inner, k))
            .find_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)),
        _ => None,
    })
}

// ---------- M3U ----------

fn from_m3u(text: &str, base: &Url) -> Vec<Channel> {
    let mut m3u = M3u::new(base);
    text.lines().filter_map(|line| m3u.line(line)).collect()
}

/// Lettura di una playlist M3U una riga alla volta (dal testo intero o da un file).
struct M3u<'a> {
    pending: Option<(String, Option<String>, Option<String>, Option<String>)>,
    group_hint: Option<String>,
    urls: Resolver<'a>,
    count: usize,
}

impl<'a> M3u<'a> {
    fn new(base: &'a Url) -> Self {
        M3u { pending: None, group_hint: None, urls: Resolver::new(base), count: 0 }
    }

    /// Il canale completato da questa riga (quella con l'URL dello stream), se c'è.
    fn line(&mut self, line: &str) -> Option<Channel> {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            return None;
        }
        if let Some(info) = line.strip_prefix("#EXTINF") {
            let name = display_name(info)
                .filter(|n| !n.is_empty())
                .map(String::from)
                .or_else(|| attr(info, "tvg-name"))
                .unwrap_or_else(|| format!("#{}", self.count + 1));
            self.pending = Some((name, attr(info, "tvg-logo"), attr(info, "group-title"), attr(info, "tvg-id")));
            self.group_hint = None;
        } else if let Some(g) = line.strip_prefix("#EXTGRP:") {
            self.group_hint = Some(g.trim().to_string());
        } else if !line.starts_with('#') {
            let (name, image, group, epg_id) = self
                .pending
                .take()
                .unwrap_or_else(|| (format!("#{}", self.count + 1), None, None, None));
            self.count += 1;
            return Some(Channel {
                name,
                image: image.map(|s| self.urls.resolve(&s)),
                stream: self.urls.resolve(line),
                group: group.or_else(|| self.group_hint.take()),
                epg_id,
            });
        }
        None
    }
}

/// Oltre questa dimensione una playlist M3U si legge dal file riga per riga.
const STREAM_FROM: u64 = 4 << 20;

/// Legge una lista salvata su disco e passa i canali a `out`, uno alla volta.
///
/// Le playlist M3U grandi si leggono riga per riga: in memoria non restano né il testo né
/// l'elenco completo dei canali (con 300.000 canali sono circa 210 MB in meno, decisivi su
/// un TV box da 2 GB). JSON e liste piccole passano da `parse`, con le stesse regole.
///
/// Restituisce l'indirizzo della guida dei programmi dichiarato nella lista, se c'è.
pub fn parse_file(path: &Path, base: &Url, out: impl FnMut(Channel)) -> Result<Option<String>, String> {
    parse_file_from(path, base, STREAM_FROM, out)
}

fn parse_file_from(
    path: &Path,
    base: &Url,
    stream_from: u64,
    mut out: impl FnMut(Channel),
) -> Result<Option<String>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = BufReader::with_capacity(64 << 10, file);
    if size > stream_from {
        let head = String::from_utf8_lossy(reader.fill_buf().map_err(|e| e.to_string())?).into_owned();
        let start = head.trim_start_matches('\u{feff}').trim_start();
        if start.starts_with("#EXTM3U") || (!start.starts_with(['{', '[']) && head.contains("#EXTINF")) {
            let mut m3u = M3u::new(base);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                if reader.read_until(b'\n', &mut buf).map_err(|e| e.to_string())? == 0 {
                    break;
                }
                if let Some(ch) = m3u.line(&String::from_utf8_lossy(&buf)) {
                    out(ch);
                }
            }
            return if m3u.count == 0 { Err("no_channels".into()) } else { Ok(guide_url(&head, base)) };
        }
    }
    let mut bytes = Vec::with_capacity(size as usize);
    reader.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    parse(&text, base)?.into_iter().for_each(out);
    Ok(guide_url(&text, base))
}

/// Indirizzo della guida dei programmi (XMLTV) dichiarato nell'intestazione di una M3U
/// (`#EXTM3U url-tvg="…"` o `x-tvg-url`): il primo, se ce ne sono più d'uno.
pub fn guide_url(text: &str, base: &Url) -> Option<String> {
    let first = text.trim_start_matches('﻿').lines().map(str::trim).find(|l| !l.is_empty())?;
    let info = first.strip_prefix("#EXTM3U")?;
    let value = attr(info, "url-tvg").or_else(|| attr(info, "x-tvg-url"))?;
    let url = value.split(',').map(str::trim).find(|s| !s.is_empty())?;
    Some(resolve(base, url))
}

/// Valore di un attributo `chiave="valore"` in una riga `#EXTINF`.
fn attr(info: &str, key: &str) -> Option<String> {
    let pat = format!("{key}=\"");
    let start = info.find(&pat)? + pat.len();
    let len = info[start..].find('"')?;
    let v = info[start..start + len].trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// Il nome del canale è ciò che segue la prima virgola fuori dalle virgolette.
fn display_name(info: &str) -> Option<&str> {
    let mut quoted = false;
    for (i, c) in info.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ',' if !quoted => return Some(info[i + 1..].trim()),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://example.com/lists/tv.json").unwrap()
    }

    #[test]
    fn json_array() {
        let body = r#"[{"name":"Uno","image":"logos/1.png","url":"https://cdn.tv/1.m3u8"},
                       {"title":"Due","logo":"https://x/2.png","stream":"/live/2.m3u8"}]"#;
        let c = parse(body, &base()).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].image.as_deref(), Some("https://example.com/lists/logos/1.png"));
        assert_eq!(c[1].name, "Due");
        assert_eq!(c[1].stream, "https://example.com/live/2.m3u8");
    }

    #[test]
    fn json_nested_object() {
        let body = r#"{"status":"ok","data":{"channels":[{"Nome":"Tre","Link":"http://a/3.m3u8"}]}}"#;
        let c = parse(body, &base()).unwrap();
        assert_eq!(c[0].name, "Tre");
        assert_eq!(c[0].stream, "http://a/3.m3u8");
    }

    #[test]
    fn m3u_playlist() {
        let body = "#EXTM3U\n#EXTINF:-1 tvg-logo=\"http://l/a.png\" group-title=\"News, Italia\",Rai News\nhttp://s/a.m3u8\n#EXTINF:-1,Canale B\nb.m3u8\n";
        let c = parse(body, &base()).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].name, "Rai News");
        assert_eq!(c[0].group.as_deref(), Some("News, Italia"));
        assert_eq!(c[0].image.as_deref(), Some("http://l/a.png"));
        assert_eq!(c[1].stream, "https://example.com/lists/b.m3u8");
    }

    #[test]
    fn xtream_m3u_plus() {
        let base = Url::parse("http://panel.tv:8080/get.php?username=u&password=p&type=m3u_plus").unwrap();
        let body = "\u{feff}#EXTM3U url-tvg=\"http://panel.tv:8080/xmltv.php\"\r\n\
                    #EXTINF:-1 tvg-id=\"rai1.it\" tvg-name=\"IT: Rai 1\" tvg-logo=\"\" group-title=\"ITALIA\",IT: Rai 1\r\n\
                    http://panel.tv:8080/u/p/1234\r\n\
                    #EXTINF:0 tvg-name=\"Film\" group-title=\"VOD\",Film\r\n\
                    http://panel.tv:8080/movie/u/p/99.mp4\r\n";
        let c = parse(body, &base).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].name, "IT: Rai 1");
        assert_eq!(c[0].image, None);
        assert_eq!(c[0].stream, "http://panel.tv:8080/u/p/1234");
        assert_eq!(c[1].group.as_deref(), Some("VOD"));
    }

    /// La scorciatoia per cartella deve dare esattamente lo stesso risultato di `resolve`.
    #[test]
    fn resolver_matches_resolve() {
        let bases = [base(), Url::parse("http://panel.tv:8080/get.php?username=u&password=p").unwrap(), Url::parse(LOCAL).unwrap()];
        let urls = [
            "http://panel.tv:8080/u/p/1234", "http://PANEL.tv:80/u/p/1234.ts", "http://panel.tv/live/u/p/9.m3u8",
            "https://image.tmdb.org/t/p/w600/abc%20d.jpg", "logos/a.png", "/root/b.png", "//cdn.tv/x/y.png",
            "http://a/b/../c/d.png", "http://a/b/./x", "http://a/b/..", "http://a/b/%2e%2E", "http://a/b/c d.png",
            "http://a/b/é.png", "http://example.com", "http://example.com/", "http://a/b?x=1/2", "http://a/b#f/g",
            "http://a/b/c?d", "udp://@239.0.0.1:1234", "rtmp://srv/app/stream", "http://a\\b/c.png", "a.m3u8",
            "http://u:p@h/x/y", "http://h/x/a:b@c", "http://h:99999/x/y", "http://[::1]/x/y",
        ];
        for b in &bases {
            let mut r = Resolver::new(b);
            for _ in 0..2 {
                for u in urls {
                    assert_eq!(r.resolve(u), resolve(b, u), "{u} rispetto a {b}");
                }
            }
        }
    }

    const LOCAL: &str = "file:///local/";

    fn same(a: &[Channel], b: &[Channel]) -> bool {
        a.len() == b.len()
            && a.iter().zip(b).all(|(x, y)| x.name == y.name && x.image == y.image && x.stream == y.stream && x.group == y.group)
    }

    /// Lettura riga per riga dal file: stessi canali della lettura del testo intero.
    #[test]
    fn file_streaming_matches_text() {
        let body = "\u{feff}#EXTM3U url-tvg=\"x\"\r\n#EXTINF:-1 tvg-logo=\"logos/a.png\" group-title=\"News, Italia\",Rai News\r\n\
                    http://s/u/p/1\r\n\r\n#EXTINF:-1,\r\n#EXTGRP:Sport\r\nb.m3u8\r\nnaked.ts\r\n#EXTINF:-1 tvg-name=\"Ψ\",\r\nhttp://s/u/p/9";
        let dir = std::env::temp_dir().join(format!("glassplay-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("list.m3u");
        std::fs::write(&path, body).unwrap();
        let expected = parse(body, &base()).unwrap();
        for stream_from in [0, u64::MAX] {
            let mut got = Vec::new();
            parse_file_from(&path, &base(), stream_from, |c| got.push(c)).unwrap();
            assert!(same(&got, &expected), "stream_from={stream_from}: {got:?}");
        }
        assert_eq!(expected.len(), 4);
        assert_eq!(expected[1].group.as_deref(), Some("Sport"));
        assert_eq!(expected[2].name, "#3");
        assert_eq!(expected[3].name, "Ψ");
        std::fs::write(&path, "#EXTM3U\n#EXTINF:-1,Solo intestazione\n").unwrap();
        assert!(parse_file_from(&path, &base(), 0, |_| ()).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Su una lista vera: `GLASSPLAY_LIST=percorso.m3u cargo test -- --ignored big_list_streaming`.
    #[test]
    #[ignore]
    fn big_list_streaming() {
        let Ok(path) = std::env::var("GLASSPLAY_LIST") else { return };
        let base = Url::parse("http://example.com/lists/tv.m3u").unwrap();
        let expected = parse(&std::fs::read_to_string(&path).unwrap(), &base).unwrap();
        let t = std::time::Instant::now();
        let mut got = Vec::new();
        parse_file(Path::new(&path), &base, |c| got.push(c)).unwrap();
        println!("{} canali letti riga per riga in {:?}", got.len(), t.elapsed());
        assert!(same(&got, &expected));
    }

    /// Su una lista vera: `GLASSPLAY_LIST=percorso.m3u cargo test -- --ignored big_list_urls`.
    #[test]
    #[ignore]
    fn big_list_urls() {
        let Ok(path) = std::env::var("GLASSPLAY_LIST") else { return };
        let body = std::fs::read_to_string(path).unwrap();
        let base = Url::parse("http://example.com/lists/tv.m3u").unwrap();
        let mut r = Resolver::new(&base);
        let mut n = 0;
        for line in body.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let raw = match line.strip_prefix("#EXTINF") {
                Some(info) => attr(info, "tvg-logo"),
                None if !line.starts_with('#') => Some(line.to_string()),
                None => None,
            };
            if let Some(raw) = raw {
                assert_eq!(r.resolve(&raw), resolve(&base, &raw));
                n += 1;
            }
        }
        println!("{n} URL identici");
    }

    #[test]
    fn single_hls_stream() {
        let body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n";
        let c = parse(body, &base()).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].stream, base().to_string());
    }

    #[test]
    fn rejects_unknown() {
        assert!(parse("<html></html>", &base()).is_err());
        assert!(parse("[]", &base()).is_err());
    }
}
