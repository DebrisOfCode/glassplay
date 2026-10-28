//! Titolo del programma in onda.
//!
//! Due fonti: le tabelle EIT dei flussi MPEG-TS (lo standard DVB le trasmette dentro lo
//! stream stesso) e, per i pannelli Xtream Codes, la loro guida (`get_short_epg`).

use crate::{net, settings};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use url::Url;

const TS_PACKET: usize = 188;
const EIT_PID: u16 = 0x12;
/// EIT "present/following" del flusso attuale.
const EIT_PF_ACTUAL: u8 = 0x4E;
const SHORT_EVENT_DESCRIPTOR: u8 = 0x4D;

#[derive(Debug, Serialize)]
pub struct Program {
    pub title: String,
    /// Inizio e fine (secondi Unix), quando la guida li fornisce.
    pub start: Option<i64>,
    pub end: Option<i64>,
}

// ---------- EIT dentro lo stream ----------

/// Nome dell'evento in corso, se il segmento MPEG-TS contiene la tabella EIT.
pub fn eit_title(data: &[u8]) -> Option<String> {
    if data.first() != Some(&0x47) {
        return None;
    }
    let mut section: Vec<u8> = Vec::new();
    let mut collecting = false;
    for pkt in data.chunks_exact(TS_PACKET) {
        if pkt[0] != 0x47 {
            break;
        }
        let pid = (u16::from(pkt[1] & 0x1F) << 8) | u16::from(pkt[2]);
        if pid != EIT_PID {
            continue;
        }
        let adaptation = (pkt[3] >> 4) & 0x3;
        if adaptation & 0x1 == 0 {
            continue; // pacchetto senza payload
        }
        let offset = if adaptation & 0x2 != 0 { 5 + usize::from(pkt[4]) } else { 4 };
        if offset >= TS_PACKET {
            continue;
        }
        let mut payload = &pkt[offset..];

        if pkt[1] & 0x40 != 0 {
            // Inizio di una nuova sezione: prima del puntatore c'è la coda della precedente.
            let pointer = usize::from(payload[0]);
            if collecting {
                if let Some(tail) = payload.get(1..1 + pointer) {
                    section.extend_from_slice(tail);
                    if let Some(title) = drain_sections(&mut section) {
                        return Some(title);
                    }
                }
            }
            match payload.get(1 + pointer..) {
                Some(rest) if !rest.is_empty() => payload = rest,
                _ => {
                    collecting = false;
                    continue;
                }
            }
            section.clear();
            collecting = true;
        } else if !collecting {
            continue;
        }
        section.extend_from_slice(payload);
        if let Some(title) = drain_sections(&mut section) {
            return Some(title);
        }
    }
    None
}

/// Esamina le sezioni complete presenti nel buffer e le rimuove.
fn drain_sections(buf: &mut Vec<u8>) -> Option<String> {
    while buf.len() >= 3 && buf[0] != 0xFF {
        let len = 3 + ((usize::from(buf[1] & 0x0F) << 8) | usize::from(buf[2]));
        if buf.len() < len {
            return None;
        }
        let found = present_event_title(&buf[..len]);
        buf.drain(..len);
        if found.is_some() {
            return found;
        }
    }
    if buf.first() == Some(&0xFF) {
        buf.clear(); // riempimento fino alla fine del pacchetto
    }
    None
}

fn present_event_title(s: &[u8]) -> Option<String> {
    // Sezione 0 = evento in corso (la 1 è il successivo).
    if s.len() < 18 || s[0] != EIT_PF_ACTUAL || s[6] != 0 {
        return None;
    }
    let end = s.len() - 4; // CRC finale
    let mut i = 14; // inizio del ciclo eventi
    while i + 12 <= end {
        let loop_len = (usize::from(s[i + 10] & 0x0F) << 8) | usize::from(s[i + 11]);
        let loop_end = (i + 12 + loop_len).min(end);
        let mut d = i + 12;
        while d + 2 <= loop_end {
            let (tag, len) = (s[d], usize::from(s[d + 1]));
            // short_event_descriptor: lingua (3 byte), lunghezza nome, nome, …
            if tag == SHORT_EVENT_DESCRIPTOR && len >= 4 && d + 2 + len <= loop_end {
                let name_len = usize::from(s[d + 5]);
                if let Some(name) = s.get(d + 6..d + 6 + name_len) {
                    let title = dvb_text(name);
                    if !title.is_empty() {
                        return Some(title);
                    }
                }
            }
            d += 2 + len;
        }
        i += 12 + loop_len;
    }
    None
}

/// Testo DVB: il primo byte può indicare la codifica (EN 300 468, allegato A).
fn dvb_text(bytes: &[u8]) -> String {
    let text = match bytes.first() {
        Some(0x15) => String::from_utf8_lossy(&bytes[1..]).into_owned(),
        Some(0x11) => {
            let units: Vec<u16> = bytes[1..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            String::from_utf16_lossy(&units)
        }
        Some(0x10) if bytes.len() >= 3 => latin(&bytes[3..]),
        Some(&c) if c < 0x20 => latin(&bytes[1..]),
        // Senza indicazione molti encoder IPTV scrivono comunque UTF-8.
        _ => std::str::from_utf8(bytes).map(str::to_owned).unwrap_or_else(|_| latin(bytes)),
    };
    // I codici 0x80–0x9F (enfasi, a capo) diventano caratteri di controllo: si scartano.
    text.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string()
}

fn latin(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

// ---------- Guida dei pannelli Xtream Codes ----------

/// Indirizzo `player_api.php` della guida per un canale Xtream
/// ("/live/user/pass/123.ts" oppure "/user/pass/123").
fn xtream_epg_url(stream: &str) -> Option<Url> {
    let url = Url::parse(stream).ok()?;
    let parts: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let (user, pass, file) = match parts.as_slice() {
        ["live", user, pass, file] | [user, pass, file] => (*user, *pass, *file),
        _ => return None,
    };
    let id = file.split('.').next()?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut api = url.clone();
    api.set_path("/player_api.php");
    // Utente e password restano nella forma già codificata del percorso.
    api.set_query(Some(&format!("username={user}&password={pass}&action=get_short_epg&stream_id={id}&limit=4")));
    Some(api)
}

/// Guida completa (XMLTV) di un pannello Xtream, dall'indirizzo della lista
/// (".../get.php?username=…&password=…" -> ".../xmltv.php?username=…&password=…").
pub fn xtream_guide_url(list: &str) -> Option<String> {
    let url = Url::parse(list).ok()?;
    if !url.path().ends_with("/get.php") {
        return None;
    }
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let (user, pass) = (param("username")?, param("password")?);
    let mut guide = url.clone();
    guide.set_path(&url.path().replace("/get.php", "/xmltv.php"));
    guide.query_pairs_mut().clear().append_pair("username", &user).append_pair("password", &pass);
    Some(guide.to_string())
}

pub async fn xtream_program(stream: &str) -> Option<Program> {
    let api = xtream_epg_url(stream)?;
    let resp = net::client().get(api).timeout(Duration::from_secs(8)).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&resp.bytes().await.ok()?).ok()?;
    let listings = value.get("epg_listings")?.as_array()?;
    let now = settings::now() as i64;
    let timestamp = |l: &Value, key: &str| -> Option<i64> {
        match l.get(key)? {
            Value::String(s) => s.parse().ok(),
            Value::Number(n) => n.as_i64(),
            _ => None,
        }
    };
    // Il programma in corso; in mancanza, il primo che non è ancora finito.
    let current = listings
        .iter()
        .find(|l| matches!((timestamp(l, "start_timestamp"), timestamp(l, "stop_timestamp")), (Some(s), Some(e)) if s <= now && now < e))
        .or_else(|| listings.iter().find(|l| timestamp(l, "stop_timestamp").is_some_and(|e| e > now)))?;
    let raw = current.get("title")?.as_str()?;
    // I titoli della guida Xtream sono in base64.
    let title = STANDARD
        .decode(raw)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| raw.to_string());
    let title = title.trim().to_string();
    (!title.is_empty()).then(|| Program {
        title,
        start: timestamp(current, "start_timestamp"),
        end: timestamp(current, "stop_timestamp"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pacchetto TS sul PID EIT con una sezione "present" che contiene `name`.
    fn eit_packet(name: &[u8]) -> Vec<u8> {
        let mut descriptor = vec![SHORT_EVENT_DESCRIPTOR, 0, b'i', b't', b'a', name.len() as u8];
        descriptor.extend_from_slice(name);
        descriptor.push(0); // testo descrittivo vuoto
        descriptor[1] = (descriptor.len() - 2) as u8;

        let mut event = vec![0, 1, 0xE7, 0x4A, 0x20, 0x30, 0x00, 0x01, 0x30, 0x00];
        event.push(0x80 | ((descriptor.len() >> 8) as u8 & 0x0F)); // running_status = 4
        event.push(descriptor.len() as u8);
        event.extend_from_slice(&descriptor);

        let mut body = vec![0x00, 0x01, 0xC1, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x4E];
        body.extend_from_slice(&event);
        body.extend_from_slice(&[0, 0, 0, 0]); // CRC (non verificato)
        let mut section = vec![EIT_PF_ACTUAL, 0xF0 | ((body.len() >> 8) as u8), body.len() as u8];
        section.extend_from_slice(&body);

        let mut pkt = vec![0x47, 0x40, 0x12, 0x10, 0x00];
        pkt.extend_from_slice(&section);
        pkt.resize(TS_PACKET, 0xFF);
        pkt
    }

    #[test]
    fn reads_present_event_from_eit() {
        let mut ts = vec![0x47, 0x01, 0x00, 0x10];
        ts.resize(TS_PACKET, 0); // pacchetto video qualunque
        ts.extend(eit_packet(b"Telegiornale"));
        assert_eq!(eit_title(&ts).as_deref(), Some("Telegiornale"));
    }

    #[test]
    fn decodes_dvb_charsets() {
        assert_eq!(eit_title(&eit_packet("\u{15}Notizie è sera".as_bytes())).as_deref(), Some("Notizie è sera"));
        assert_eq!(eit_title(&eit_packet(b"Film\x8aStasera")).as_deref(), Some("FilmStasera"));
        assert_eq!(eit_title(&eit_packet(&[0x05, b'C', 0xE9, b'l', b'i', b'n'])).as_deref(), Some("Célin"));
    }

    #[test]
    fn ignores_streams_without_eit() {
        let mut ts = vec![0x47, 0x01, 0x00, 0x10];
        ts.resize(TS_PACKET * 3, 0);
        assert_eq!(eit_title(&ts), None);
        assert_eq!(eit_title(b"#EXTM3U"), None);
    }

    #[test]
    fn builds_xtream_epg_url() {
        let a = xtream_epg_url("http://host:8080/live/user/pa%40ss/1234.m3u8").unwrap();
        assert_eq!(a.as_str(), "http://host:8080/player_api.php?username=user&password=pa%40ss&action=get_short_epg&stream_id=1234&limit=4");
        assert!(xtream_epg_url("http://host/user/pass/99").is_some());
        assert!(xtream_epg_url("https://cdn.tv/hls/channel/index.m3u8").is_none());
    }
}
