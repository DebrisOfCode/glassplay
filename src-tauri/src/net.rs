use std::{error::Error as _, sync::LazyLock, time::Duration};

/// Molti server IPTV rifiutano gli user agent dei browser ma accettano quelli dei player.
const USER_AGENT: &str = "VLC/3.0.20 LibVLC/3.0.20";
/// Alternativa per i server che invece bloccano i player.
pub const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/// Client HTTP condiviso (connessioni riutilizzate tra lista, playlist e segmenti).
pub fn client() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("impossibile inizializzare il client HTTP")
    });
    &CLIENT
}

/// Errore nel formato "codice:dettaglio" (il codice lo traduce la UI), senza l'URL
/// che può contenere username e password.
pub fn describe(e: reqwest::Error) -> String {
    let code = if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_body() || e.is_decode() {
        "interrupted"
    } else {
        "network"
    };
    let e = e.without_url();
    let mut details = Vec::new();
    let mut source = e.source();
    while let Some(s) = source {
        details.push(s.to_string());
        source = s.source();
    }
    let message = if details.is_empty() { code.to_string() } else { format!("{code}:{}", details.join(": ")) };
    // Diagnostica (su Android finisce nel log di sistema, logcat): mai con l'URL.
    eprintln!("[glassplay] errore di rete: {message}");
    message
}
