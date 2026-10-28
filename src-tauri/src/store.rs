//! Lista attiva, tenuta in memoria in forma compatta.
//!
//! Con centinaia di migliaia di canali, passare l'intera lista alla WebView (decine di MB di
//! JSON e un oggetto JavaScript per canale) costa centinaia di MB: troppi per i dispositivi
//! con poca memoria (TV box da 2 GB). La lista resta qui e l'interfaccia chiede solo ciò che
//! le serve: le righe visibili, i risultati della ricerca, la posizione dei canali salvati.
//!
//! I testi stanno in pochi buffer contigui invece che in milioni di stringhe separate; gli URL
//! sono divisi in "cartella" (condivisa da molti canali, es. `http://server/utente/password/`)
//! e nome finale, così le parti ripetute sono memorizzate una volta sola.

use crate::playlist::Channel;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Nessun valore (canale senza logo o senza gruppo).
const NONE: u32 = u32::MAX;

/// Molte stringhe concatenate in un unico buffer.
#[derive(Default)]
struct Texts {
    buf: String,
    ends: Vec<u32>,
}

impl Texts {
    fn push(&mut self, s: &str) {
        self.buf.push_str(s);
        self.ends.push(self.buf.len() as u32);
    }

    fn get(&self, i: usize) -> &str {
        let start = if i == 0 { 0 } else { self.ends[i - 1] as usize };
        &self.buf[start..self.ends[i] as usize]
    }

    fn shrink(&mut self) {
        self.buf.shrink_to_fit();
        self.ends.shrink_to_fit();
    }
}

/// Valori ripetuti (cartelle degli URL, gruppi) memorizzati una volta sola.
#[derive(Default)]
struct Pool {
    values: Vec<Arc<str>>,
    ids: HashMap<Arc<str>, u32>,
}

impl Pool {
    fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.ids.get(s) {
            return id;
        }
        let v: Arc<str> = Arc::from(s);
        let id = self.values.len() as u32;
        self.values.push(v.clone());
        self.ids.insert(v, id);
        id
    }

    fn get(&self, id: u32) -> Option<&str> {
        (id != NONE).then(|| &*self.values[id as usize])
    }
}

/// URL divisi all'ultima "/": cartella in comune e nome finale.
#[derive(Default)]
struct Urls {
    dirs: Pool,
    dir: Vec<u32>,
    tails: Texts,
}

fn split_url(url: &str) -> (&str, &str) {
    url.split_at(url.rfind('/').map_or(0, |i| i + 1))
}

impl Urls {
    fn push(&mut self, url: Option<&str>) {
        match url {
            Some(u) => {
                let (dir, tail) = split_url(u);
                self.dir.push(self.dirs.intern(dir));
                self.tails.push(tail);
            }
            None => {
                self.dir.push(NONE);
                self.tails.push("");
            }
        }
    }

    fn get(&self, i: usize) -> Option<String> {
        let dir = self.dirs.get(self.dir[i])?;
        Some([dir, self.tails.get(i)].concat())
    }

    fn shrink(&mut self) {
        self.dir.shrink_to_fit();
        self.tails.shrink();
    }
}

/// Numero progressivo della lista caricata: le richieste fatte per una lista
/// precedente (cambiata nel frattempo) vengono riconosciute e scartate.
static SERIAL: AtomicU64 = AtomicU64::new(0);

pub struct Store {
    serial: u64,
    names: Texts,
    groups: Pool,
    group: Vec<u32>,
    images: Urls,
    streams: Urls,
    /// Per la ricerca: nome e gruppo in minuscolo, un canale per riga.
    search: Texts,
    /// Identificativo nella guida dei programmi (vuoto se manca).
    epg: Texts,
    /// Guida dei programmi dichiarata dalla lista (`url-tvg`), se c'è.
    pub guide_url: Option<String>,
    #[cfg(feature = "adult-filter")]
    adult: crate::adult::Filter,
}

/// Ciò che l'interfaccia sa della lista aperta.
#[derive(Clone, Copy, Serialize)]
pub struct Info {
    pub serial: u64,
    pub count: usize,
}

impl Store {
    pub fn new(channels: Vec<Channel>) -> Store {
        let mut s = Store::empty();
        // `into_iter`: ogni canale viene liberato appena copiato, così il picco di memoria resta basso.
        for ch in channels {
            s.push(&ch);
        }
        s.finish();
        s
    }

    /// Lista vuota da riempire con `push` (lettura riga per riga, vedi `playlist::parse_file`).
    pub fn empty() -> Store {
        Store {
            serial: SERIAL.fetch_add(1, Ordering::Relaxed) + 1,
            names: Texts::default(),
            groups: Pool::default(),
            group: Vec::new(),
            images: Urls::default(),
            streams: Urls::default(),
            search: Texts::default(),
            epg: Texts::default(),
            guide_url: None,
            #[cfg(feature = "adult-filter")]
            adult: crate::adult::Filter::default(),
        }
    }

    pub fn push(&mut self, ch: &Channel) {
        let group_id = ch.group.as_deref().map_or(NONE, |g| self.groups.intern(g));
        let name = ch.name.to_lowercase();
        let group = ch.group.as_deref().map(str::to_lowercase).unwrap_or_default();
        // Versione legacy: i canali per adulti non entrano nella lista (né nella ricerca).
        #[cfg(feature = "adult-filter")]
        if self.adult.hides(&name, (group_id != NONE).then_some((group_id, group.as_str()))) {
            return;
        }
        self.names.push(&ch.name);
        self.group.push(group_id);
        self.images.push(ch.image.as_deref());
        self.streams.push(Some(&ch.stream));
        self.search.push(&[&name, "\n", &group, "\0"].concat());
        self.epg.push(ch.epg_id.as_deref().unwrap_or(""));
    }

    /// Restituisce la memoria in più riservata durante il riempimento.
    pub fn finish(&mut self) {
        self.names.shrink();
        self.group.shrink_to_fit();
        self.images.shrink();
        self.streams.shrink();
        self.search.shrink();
        self.epg.shrink();
    }

    /// Canali per identificativo della guida (solo quelli che ne hanno uno).
    pub fn epg_ids(&self) -> HashMap<String, Vec<u32>> {
        let mut ids: HashMap<String, Vec<u32>> = HashMap::new();
        for i in 0..self.group.len() {
            let id = self.epg.get(i);
            if !id.is_empty() {
                ids.entry(id.to_string()).or_default().push(i as u32);
            }
        }
        ids
    }

    pub fn info(&self) -> Info {
        Info { serial: self.serial, count: self.group.len() }
    }

    fn channel(&self, i: usize) -> Channel {
        Channel {
            name: self.names.get(i).to_string(),
            image: self.images.get(i),
            stream: self.streams.get(i).unwrap_or_default(),
            group: self.groups.get(self.group[i]).map(String::from),
            epg_id: None,
        }
    }

    /// I canali alle posizioni richieste, nello stesso ordine (None per quelle fuori dalla lista).
    pub fn channels(&self, indices: &[u32]) -> Vec<Option<Channel>> {
        indices
            .iter()
            .map(|&i| i as usize)
            .map(|i| (i < self.group.len()).then(|| self.channel(i)))
            .collect()
    }

    /// Posizioni dei canali il cui nome o gruppo contiene `query` (senza distinguere maiuscole).
    pub fn search(&self, query: &str) -> Vec<u32> {
        let q = query.trim().to_lowercase();
        let mut out = Vec::new();
        if q.is_empty() || q.contains(['\n', '\0']) {
            return out;
        }
        let hay = &self.search.buf;
        let ends = &self.search.ends;
        let mut i = 0usize;
        let mut from = 0usize;
        while let Some(off) = hay[from..].find(&q) {
            let pos = from + off;
            // Canale a cui appartiene la corrispondenza (le posizioni crescono: basta avanzare).
            while ends[i] as usize <= pos {
                i += 1;
            }
            out.push(i as u32);
            // Un canale compare una volta sola: si riparte dal canale successivo.
            from = ends[i] as usize;
            i += 1;
            if i >= ends.len() {
                break;
            }
        }
        out
    }

    /// Posizione del primo canale con ciascuno degli stream indicati (-1 se non c'è).
    pub fn find(&self, streams: &[String]) -> Vec<i64> {
        let mut out = vec![-1i64; streams.len()];
        let mut wanted: HashMap<(u32, &str), Vec<usize>> = HashMap::new();
        for (k, s) in streams.iter().enumerate() {
            let (dir, tail) = split_url(s);
            if let Some(&d) = self.streams.dirs.ids.get(dir) {
                wanted.entry((d, tail)).or_default().push(k);
            }
        }
        if wanted.is_empty() {
            return out;
        }
        for i in 0..self.group.len() {
            if let Some(ks) = wanted.remove(&(self.streams.dir[i], self.streams.tails.get(i))) {
                for k in ks {
                    out[k] = i as i64;
                }
                if wanted.is_empty() {
                    break;
                }
            }
        }
        out
    }
}

/// La lista aperta nell'interfaccia (una alla volta).
#[derive(Default)]
pub struct Active(Mutex<Option<Store>>);

impl Active {
    pub fn set(&self, store: Store) -> Info {
        let info = store.info();
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(store);
        info
    }

    pub fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Esegue `f` sulla lista aperta, se è ancora quella indicata da `serial`.
    pub fn with<T>(&self, serial: u64, f: impl FnOnce(&Store) -> T) -> Result<T, String> {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(store) if store.serial == serial => Ok(f(store)),
            _ => Err("stale_list".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(name: &str, group: Option<&str>, stream: &str, image: Option<&str>) -> Channel {
        Channel {
            name: name.into(),
            image: image.map(String::from),
            stream: stream.into(),
            group: group.map(String::from),
            epg_id: None,
        }
    }

    fn sample() -> Store {
        Store::new(vec![
            ch("Rai 1", Some("Italia"), "http://p.tv/u/p/1", Some("http://l.tv/a.png")),
            ch("Rai 2", Some("Italia"), "http://p.tv/u/p/2", None),
            ch("CNN", Some("News"), "http://p.tv/u/p/3", Some("http://l.tv/b.png")),
            ch("Ελληνικά", None, "https://x.gr/live.m3u8", None),
            ch("Rai 1 HD", Some("Italia"), "http://p.tv/u/p/1", None),
        ])
    }

    #[test]
    fn round_trip() {
        let s = sample();
        assert_eq!(s.info().count, 5);
        let c = s.channels(&[2, 3, 99, 0]);
        assert_eq!(c.len(), 4);
        assert!(c[2].is_none());
        let c: Vec<Channel> = c.into_iter().flatten().collect();
        assert_eq!(c[0].name, "CNN");
        assert_eq!(c[0].image.as_deref(), Some("http://l.tv/b.png"));
        assert_eq!(c[0].group.as_deref(), Some("News"));
        assert_eq!(c[1].stream, "https://x.gr/live.m3u8");
        assert_eq!(c[1].group, None);
        assert_eq!(c[2].stream, "http://p.tv/u/p/1");
        // Le cartelle degli URL sono condivise.
        assert_eq!(s.streams.dirs.values.len(), 2);
    }

    #[test]
    fn search_names_and_groups() {
        let s = sample();
        assert_eq!(s.search("rai"), vec![0, 1, 4]);
        assert_eq!(s.search("  ITALIA "), vec![0, 1, 4]);
        assert_eq!(s.search("news"), vec![2]);
        assert_eq!(s.search("ελλη"), vec![3]);
        // "i" compare più volte in "rai 1 / italia": il canale va riportato una volta sola
        // (e la iota greca di "Ελληνικά" non è una "i").
        assert_eq!(s.search("i"), vec![0, 1, 4]);
        assert!(s.search("zzz").is_empty());
        assert!(s.search("").is_empty());
        // Nome e gruppo non si "toccano": "2ital" non deve trovare Rai 2 / Italia.
        assert!(s.search("2ital").is_empty());
    }

    #[test]
    fn find_first_position() {
        let s = sample();
        let q = ["http://p.tv/u/p/1", "https://x.gr/live.m3u8", "http://p.tv/u/p/9", "nope"].map(String::from);
        assert_eq!(s.find(&q), vec![0, 3, -1, -1]);
    }

    /// Tempi su una lista vera: `GLASSPLAY_LIST=percorso.m3u cargo test -- --ignored --nocapture big_list`.
    #[test]
    #[ignore]
    fn big_list() {
        let Ok(path) = std::env::var("GLASSPLAY_LIST") else { return };
        let body = std::fs::read_to_string(path).unwrap();
        let base = url::Url::parse("http://example.com/").unwrap();
        let t = std::time::Instant::now();
        let channels = crate::playlist::parse(&body, &base).unwrap();
        let parsed = t.elapsed();
        drop(body);
        let t = std::time::Instant::now();
        let s = Store::new(channels);
        let built = t.elapsed();
        let bytes = s.names.buf.len() + s.search.buf.len() + s.images.tails.buf.len() + s.streams.tails.buf.len()
            + (s.names.ends.len() + s.search.ends.len() + s.images.tails.ends.len() + s.streams.tails.ends.len()) * 4
            + (s.group.len() + s.images.dir.len() + s.streams.dir.len()) * 4;
        println!(
            "{} canali: lettura {parsed:?}, compattazione {built:?}, ~{} MB, cartelle URL {} + {}",
            s.info().count,
            bytes >> 20,
            s.images.dirs.values.len(),
            s.streams.dirs.values.len()
        );
        for q in ["a", "rai", "sport", "zzzz"] {
            let t = std::time::Instant::now();
            let n = s.search(q).len();
            println!("ricerca {q:?}: {n} risultati in {:?}", t.elapsed());
        }
        #[cfg(feature = "adult-filter")]
        {
            let mut hidden = std::collections::BTreeMap::new();
            let mut by_name = 0;
            let t = std::time::Instant::now();
            let base = url::Url::parse("http://example.com/").unwrap();
            let body = std::fs::read_to_string(std::env::var("GLASSPLAY_LIST").unwrap()).unwrap();
            let all = crate::playlist::parse(&body, &base).unwrap();
            println!("filtro adulti: {} canali tenuti su {} (lista compattata col filtro)", s.info().count, all.len());
            let mut ids = std::collections::HashMap::new();
            let input: Vec<(String, u32, String)> = all
                .iter()
                .map(|ch| {
                    let g = ch.group.clone().unwrap_or_default();
                    let next = ids.len() as u32;
                    let id = *ids.entry(g.clone()).or_insert(next);
                    (ch.name.to_lowercase(), id, g.to_lowercase())
                })
                .collect();
            let _ = t;
            let t = std::time::Instant::now();
            let mut f = crate::adult::Filter::default();
            let verdicts: Vec<bool> = input.iter().map(|(n, id, g)| f.hides(n, Some((*id, g)))).collect();
            println!("filtro su {} canali: {:?}", input.len(), t.elapsed());
            for (k, hide) in verdicts.iter().enumerate() {
                if !hide {
                    continue;
                }
                let g = &input[k].2;
                if crate::adult::Filter::default().hides("", Some((0, g))) {
                    *hidden.entry(g.clone()).or_insert(0) += 1;
                } else {
                    by_name += 1;
                    println!("  per nome: {:?} (gruppo {:?})", all[k].name, all[k].group);
                }
            }
            println!("gruppi nascosti: {}, canali nascosti per nome fuori da quei gruppi: {by_name}", hidden.len());
        }
        let probe: Vec<String> = s.channels(&[0, 1000, 200_000]).into_iter().flatten().map(|c| c.stream).collect();
        let t = std::time::Instant::now();
        let found = s.find(&probe);
        println!("find {found:?} in {:?}", t.elapsed());
    }

    #[test]
    fn stale_serial() {
        let active = Active::default();
        let info = active.set(sample());
        assert!(active.with(info.serial, |s| s.info().count).is_ok());
        assert!(active.with(info.serial + 1, |_| ()).is_err());
        active.set(sample());
        assert!(active.with(info.serial, |_| ()).is_err());
    }
}
