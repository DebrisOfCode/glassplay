use crate::settings::Proxy;
use std::{
    error::Error as _,
    sync::{LazyLock, RwLock},
    time::Duration,
};
use url::Url;

/// Molti server IPTV rifiutano gli user agent dei browser ma accettano quelli dei player.
const USER_AGENT: &str = "VLC/3.0.20 LibVLC/3.0.20";
/// Alternativa per i server che invece bloccano i player.
pub const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

static CLIENT: LazyLock<RwLock<reqwest::Client>> =
    LazyLock::new(|| RwLock::new(build(None).expect("impossibile inizializzare il client HTTP")));

/// Client HTTP condiviso (connessioni riutilizzate tra lista, playlist e segmenti). Se è
/// attivo un proxy, tutte le richieste passano da lì.
pub fn client() -> reqwest::Client {
    CLIENT.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Indirizzo completo del proxy (con le credenziali), se la configurazione è valida.
/// Con SOCKS5 anche i nomi dei server vengono risolti dal proxy ("socks5h"), così il
/// fornitore di rete non vede nemmeno a quali server ci si collega.
pub fn proxy_url(p: &Proxy) -> Result<Url, String> {
    let mut url = Url::parse(p.url.trim()).map_err(|_| "invalid_proxy".to_string())?;
    if url.scheme() == "socks5" {
        url = Url::parse(&p.url.trim().replacen("socks5", "socks5h", 1)).map_err(|_| "invalid_proxy".to_string())?;
    }
    if !matches!(url.scheme(), "http" | "https" | "socks5h") || url.host_str().is_none() || url.port_or_known_default().is_none() {
        return Err("invalid_proxy".into());
    }
    if !p.username.is_empty() {
        url.set_username(&p.username).map_err(|_| "invalid_proxy".to_string())?;
        url.set_password(Some(&p.password)).map_err(|_| "invalid_proxy".to_string())?;
    }
    Ok(url)
}

fn build(proxy: Option<&Proxy>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().user_agent(USER_AGENT).connect_timeout(Duration::from_secs(15));
    if let Some(p) = proxy.filter(|p| p.enabled) {
        let url = proxy_url(p)?;
        builder = builder.proxy(reqwest::Proxy::all(url.as_str()).map_err(|_| "invalid_proxy".to_string())?);
    }
    builder.build().map_err(|e| format!("invalid_proxy:{e}"))
}

/// Applica (o toglie, se disattivato) il proxy a tutte le richieste successive.
pub fn set_proxy(proxy: &Proxy) -> Result<(), String> {
    let client = build(Some(proxy))?;
    *CLIENT.write().unwrap_or_else(|e| e.into_inner()) = client;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn p(url: &str, user: &str) -> Proxy {
        Proxy { enabled: true, url: url.into(), username: user.into(), password: "pw".into() }
    }

    #[test]
    fn proxy_urls() {
        assert_eq!(proxy_url(&p("socks5://10.0.0.1:1080", "")).unwrap().as_str(), "socks5h://10.0.0.1:1080");
        assert_eq!(proxy_url(&p("http://proxy.lan:3128", "me")).unwrap().as_str(), "http://me:pw@proxy.lan:3128/");
        assert!(proxy_url(&p("https://proxy.example", "")).is_ok());
        assert!(proxy_url(&p("ftp://x:21", "")).is_err());
        assert!(proxy_url(&p("socks5://host-senza-porta", "")).is_err());
        assert!(proxy_url(&p("nonsense", "")).is_err());
        assert!(set_proxy(&p("http://127.0.0.1:9", "")).is_ok());
        assert!(set_proxy(&Proxy::default()).is_ok());
    }
}
