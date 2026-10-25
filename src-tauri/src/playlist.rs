//! Interpretazione della risposta della sorgente: JSON (formati liberi) o playlist M3U.

use serde::Serialize;
use serde_json::{Map, Value};
use url::Url;

#[derive(Debug, Clone, Serialize)]
pub struct Channel {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    pub stream: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
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
            vec![Channel { name: stream_name(base), image: None, stream: base.to_string(), group: None }]
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

fn stream_name(url: &Url) -> String {
    url.host_str().unwrap_or("Stream").to_string()
}

// ---------- JSON ----------

fn from_json(value: &Value, base: &Url) -> Vec<Channel> {
    let Some(items) = find_list(value, 0) else { return Vec::new() };
    items
        .iter()
        .filter_map(Value::as_object)
        .enumerate()
        .filter_map(|(i, obj)| {
            let stream = field(obj, STREAM_KEYS)?;
            let name = field(obj, NAME_KEYS).unwrap_or_else(|| format!("#{}", i + 1));
            Some(Channel {
                name,
                image: field(obj, IMAGE_KEYS).map(|s| resolve(base, &s)),
                stream: resolve(base, &stream),
                group: field(obj, GROUP_KEYS),
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
    let mut channels = Vec::new();
    let mut pending: Option<(String, Option<String>, Option<String>)> = None;
    let mut group_hint: Option<String> = None;

    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(info) = line.strip_prefix("#EXTINF") {
            let name = display_name(info)
                .filter(|n| !n.is_empty())
                .map(String::from)
                .or_else(|| attr(info, "tvg-name"))
                .unwrap_or_else(|| format!("#{}", channels.len() + 1));
            pending = Some((name, attr(info, "tvg-logo"), attr(info, "group-title")));
            group_hint = None;
        } else if let Some(g) = line.strip_prefix("#EXTGRP:") {
            group_hint = Some(g.trim().to_string());
        } else if !line.starts_with('#') {
            let (name, image, group) = pending
                .take()
                .unwrap_or_else(|| (format!("#{}", channels.len() + 1), None, None));
            channels.push(Channel {
                name,
                image: image.map(|s| resolve(base, &s)),
                stream: resolve(base, line),
                group: group.or_else(|| group_hint.take()),
            });
        }
    }
    channels
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
