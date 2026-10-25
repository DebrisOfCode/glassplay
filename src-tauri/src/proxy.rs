//! Protocollo `stream://` (su Windows `http://stream.localhost/?u=<url>`).
//!
//! La WebView non può leggere direttamente i flussi della maggior parte dei server IPTV
//! (mancano gli header CORS): le richieste di hls.js passano quindi da qui, vengono eseguite
//! in Rust e restituite con gli header corretti. Le playlist HLS vengono riscritte con URL
//! assoluti, così redirect e percorsi relativi restano risolti correttamente.

use crate::{dvbsub, meta, net, playlist::resolve};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, Emitter, UriSchemeResponder,
};
use url::Url;

/// Intestazione con il titolo del programma letto dallo stream (codificato come URL).
const PROGRAM_HEADER: &str = "x-program";
/// Intestazione che segnala una traccia di sottotitoli DVB ("dvb:<lingua>").
const SUBTITLES_HEADER: &str = "x-subtitles";

pub fn handle(app: AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    tauri::async_runtime::spawn(async move {
        let response = if request.method() == "OPTIONS" {
            preflight()
        } else {
            match forward(&app, &request).await {
                Ok(r) => r,
                Err(e) => error(StatusCode::BAD_GATEWAY, &e),
            }
        };
        responder.respond(response);
    });
}

async fn forward(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
    let uri = Url::parse(&request.uri().to_string()).map_err(|e| e.to_string())?;
    let param = |name: &str| uri.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let target = param("u").ok_or("parametro 'u' mancante")?;
    // Sessione del lettore principale (l'anteprima non la passa): serve per i sottotitoli.
    let session = param("sid");

    let mut req = net::client().get(&target).timeout(Duration::from_secs(30));
    if let Some(range) = request.headers().get(header::RANGE) {
        req = req.header(header::RANGE, range.as_bytes());
    }
    let upstream = req.send().await.map_err(net::describe)?;

    let status = upstream.status().as_u16();
    let final_url = upstream.url().clone();
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let bytes = upstream.bytes().await.map_err(net::describe)?;

    let mut program = None;
    let mut subtitles_language = None;
    let (body, content_type) = if is_playlist(content_type.as_deref(), &bytes) {
        let text = absolutize(&String::from_utf8_lossy(&bytes), &final_url);
        (text.into_bytes(), Some("application/vnd.apple.mpegurl".to_string()))
    } else {
        // Segmenti MPEG-TS: titolo del programma (EIT) e sottotitoli DVB, se lo stream li porta.
        program = meta::eit_title(&bytes);
        if let Some(sid) = session.as_deref().filter(|_| bytes.first() == Some(&0x47)) {
            subtitles_language = subtitles(app, sid, &bytes);
        }
        (bytes.to_vec(), content_type)
    };

    let mut builder = cors(Response::builder().status(status)).header(header::CACHE_CONTROL, "no-store");
    if let Some(title) = program {
        let encoded: String = url::form_urlencoded::byte_serialize(title.as_bytes()).collect();
        builder = builder.header(PROGRAM_HEADER, encoded);
    }
    if let Some(language) = subtitles_language {
        let language: String = language.chars().filter(char::is_ascii_alphanumeric).collect();
        builder = builder.header(SUBTITLES_HEADER, format!("dvb:{language}"));
    }
    if let Some(ct) = content_type {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }
    builder.body(body).map_err(|e| e.to_string())
}

// ---------- Sottotitoli DVB ----------

/// Stato del decoder per il canale aperto (`sid`): i PES possono attraversare più segmenti.
struct SubtitleSession {
    track: Option<dvbsub::Track>,
    decoder: dvbsub::Decoder,
}

static SUBTITLE_SESSIONS: LazyLock<Mutex<HashMap<String, SubtitleSession>>> = LazyLock::new(Default::default);

#[derive(Clone, Serialize)]
struct SubtitleEvent {
    sid: String,
    pts: u64,
    timeout: u8,
    display: (u16, u16),
    image: Option<SubtitleImage>,
}

#[derive(Clone, Serialize)]
struct SubtitleImage {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    /// PNG in base64.
    png: String,
}

/// Decodifica i sottotitoli DVB del segmento e li invia alla UI (evento "subtitle").
/// Restituisce la lingua della traccia se il canale ne ha una.
fn subtitles(app: &AppHandle, sid: &str, data: &[u8]) -> Option<String> {
    let mut sessions = SUBTITLE_SESSIONS.lock().ok()?;
    if !sessions.contains_key(sid) {
        sessions.clear(); // si guarda un canale alla volta: le sessioni precedenti non servono più
    }
    let session = sessions
        .entry(sid.to_string())
        .or_insert_with(|| SubtitleSession { track: None, decoder: dvbsub::Decoder::default() });
    if let Some(track) = dvbsub::find_track(data) {
        if session.track.as_ref() != Some(&track) {
            session.decoder = dvbsub::Decoder::default();
            session.track = Some(track);
        }
    }
    let track = session.track.clone()?;
    for sub in session.decoder.feed(data, &track) {
        let image = sub.image.map(|i| SubtitleImage {
            x: i.x,
            y: i.y,
            width: i.width,
            height: i.height,
            png: STANDARD.encode(encode_png(&i)),
        });
        let event = SubtitleEvent { sid: sid.to_string(), pts: sub.pts, timeout: sub.timeout, display: sub.display, image };
        let _ = app.emit("subtitle", event);
    }
    Some(track.language)
}

fn encode_png(image: &dvbsub::Image) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width as u32, image.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        if let Ok(mut writer) = encoder.write_header() {
            let _ = writer.write_image_data(&image.rgba);
        }
    }
    out
}

fn is_playlist(content_type: Option<&str>, body: &[u8]) -> bool {
    content_type.is_some_and(|c| c.to_ascii_lowercase().contains("mpegurl"))
        || body.trim_ascii_start().starts_with(b"#EXTM3U")
        || body.starts_with(b"\xEF\xBB\xBF#EXTM3U")
}

/// Rende assoluti tutti gli URI di una playlist HLS (righe e attributi `URI="..."`).
fn absolutize(text: &str, base: &Url) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            out.push_str(&rewrite_uri_attrs(line, base));
        } else if !line.is_empty() {
            out.push_str(&resolve(base, line));
        }
        out.push('\n');
    }
    out
}

fn rewrite_uri_attrs(line: &str, base: &Url) -> String {
    const KEY: &str = "URI=\"";
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(pos) = rest.find(KEY) {
        let start = pos + KEY.len();
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(len) = rest.find('"') else { break };
        out.push_str(&resolve(base, &rest[..len]));
        rest = &rest[len..];
    }
    out.push_str(rest);
    out
}

fn cors(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "*")
}

fn preflight() -> Response<Vec<u8>> {
    cors(Response::builder().status(StatusCode::NO_CONTENT))
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .body(Vec::new())
        .unwrap()
}

fn error(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    cors(Response::builder().status(status))
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolutizes_playlist() {
        let base = Url::parse("https://cdn.tv/live/ch1/index.m3u8?t=1").unwrap();
        let src = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:6,\nseg1.ts\n/abs/seg2.ts\n";
        let out = absolutize(src, &base);
        assert!(out.contains("URI=\"https://cdn.tv/live/ch1/key.bin\""));
        assert!(out.contains("\nhttps://cdn.tv/live/ch1/seg1.ts\n"));
        assert!(out.contains("\nhttps://cdn.tv/abs/seg2.ts\n"));
    }
}
