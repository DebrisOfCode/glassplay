//! Guida dei programmi (XMLTV) della lista aperta.
//!
//! I pannelli Xtream la offrono su `xmltv.php`, le M3U la dichiarano con `url-tvg`. Il file
//! (spesso decine di MB, a volte compresso) si legge un elemento alla volta: restano solo i
//! programmi dei canali della lista, da qualche ora fa al giorno dopo, con titoli e descrizioni
//! in un unico buffer di testo. Serve alla ricerca per programma, ai titoli sotto i canali
//! e alla pagina della guida.

use flate2::read::MultiGzDecoder;
use quick_xml::{events::Event, Reader};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
    sync::Mutex,
};

/// Finestra tenuta in memoria attorno al momento della lettura (secondi).
const BEFORE: i64 = 12 * 3600;
const AFTER: i64 = 48 * 3600;
/// Le descrizioni servono solo per i dettagli nella guida: oltre questa lunghezza si tagliano.
const DESC_MAX: usize = 300;

/// Un programma, come lo riceve l'interfaccia.
#[derive(Clone, Serialize)]
pub struct Programme {
    pub start: i64,
    pub end: i64,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub desc: String,
}

struct Prog {
    slot: u32,
    start: i64,
    end: i64,
    title: (u32, u32),
    desc: (u32, u32),
}

pub struct Guide {
    serial: u64,
    text: String,
    /// Ordinati per canale della guida (`slot`) e ora di inizio.
    progs: Vec<Prog>,
    /// Per ogni canale della guida: i suoi programmi in `progs`.
    ranges: Vec<(u32, u32)>,
    /// Per ogni canale della guida: i canali della lista collegati.
    slot_channels: Vec<Vec<u32>>,
    /// Canale della lista -> canale della guida.
    slot_of: HashMap<u32, u32>,
}

/// Ciò che l'interfaccia sa della guida caricata.
#[derive(Serialize)]
pub struct GuideInfo {
    pub channels: usize,
    pub programmes: usize,
}

impl Guide {
    /// Legge il file XMLTV in `path` per i canali `wanted` (identificativo -> posizioni nella
    /// lista), tenendo i programmi attorno a `now`.
    pub fn read(path: &Path, wanted: HashMap<String, Vec<u32>>, now: i64, serial: u64) -> Result<Guide, String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut magic = [0u8; 2];
        let gz = file.read(&mut magic).map_err(|e| e.to_string())? == 2 && magic == [0x1f, 0x8b];
        let file = File::open(path).map_err(|e| e.to_string())?;
        if gz {
            Self::parse(BufReader::with_capacity(64 << 10, MultiGzDecoder::new(file)), wanted, now, serial)
        } else {
            Self::parse(BufReader::with_capacity(64 << 10, file), wanted, now, serial)
        }
    }

    fn parse(input: impl BufRead, wanted: HashMap<String, Vec<u32>>, now: i64, serial: u64) -> Result<Guide, String> {
        // Gli identificativi si confrontano senza distinguere maiuscole ("Rai1.it" / "rai1.it").
        let mut slots: HashMap<String, u32> = HashMap::new();
        let mut slot_channels: Vec<Vec<u32>> = Vec::new();
        for (id, channels) in wanted {
            let key = id.trim().to_lowercase();
            match slots.get(&key) {
                Some(&s) => slot_channels[s as usize].extend(channels),
                None => {
                    slots.insert(key, slot_channels.len() as u32);
                    slot_channels.push(channels);
                }
            }
        }
        let (from, to) = (now - BEFORE, now + AFTER);

        let mut reader = Reader::from_reader(input);
        let mut buf = Vec::new();
        let mut text = String::new();
        let mut progs = Vec::new();
        // Programma in lettura: (canale della guida, inizio, fine).
        let mut current: Option<(u32, i64, i64)> = None;
        let (mut title, mut desc) = (String::new(), String::new());
        // 1 = dentro <title>, 2 = dentro <desc>.
        let mut field = 0u8;
        loop {
            let event = reader.read_event_into(&mut buf).map_err(|e| format!("invalid_guide:{e}"))?;
            match event {
                Event::Start(e) => match e.local_name().as_ref() {
                    "programme" => {
                        current = None;
                        let (mut channel, mut start, mut stop) = (None, None, None);
                        for a in e.attributes().flatten() {
                            let value = a.normalized_value(quick_xml::XmlVersion::Implicit1_0).unwrap_or_default();
                            match a.key.as_ref() {
                                "channel" => channel = slots.get(&value.trim().to_lowercase()).copied(),
                                "start" => start = parse_time(&value),
                                "stop" => stop = parse_time(&value),
                                _ => {}
                            }
                        }
                        if let (Some(slot), Some(start), Some(stop)) = (channel, start, stop) {
                            if stop > from && start < to && stop > start {
                                current = Some((slot, start, stop));
                                title.clear();
                                desc.clear();
                            }
                        }
                    }
                    // Solo il primo titolo e la prima descrizione (le altre sono traduzioni).
                    "title" if current.is_some() && title.is_empty() => field = 1,
                    "desc" if current.is_some() && desc.is_empty() => field = 2,
                    _ => {}
                },
                Event::Text(t) if field > 0 => append(field, &mut title, &mut desc, &t),
                Event::CData(t) if field > 0 => append(field, &mut title, &mut desc, &t.xml10_content()),
                Event::GeneralRef(r) if field > 0 => {
                    let c = r.resolve_char_ref().ok().flatten().map(String::from).unwrap_or_else(|| {
                        match &*r {
                            "amp" => "&",
                            "lt" => "<",
                            "gt" => ">",
                            "quot" => "\"",
                            "apos" => "'",
                            _ => "",
                        }
                        .to_string()
                    });
                    append(field, &mut title, &mut desc, &c);
                }
                Event::End(e) => match e.local_name().as_ref() {
                    "title" | "desc" => field = 0,
                    "programme" => {
                        if let Some((slot, start, end)) = current.take() {
                            let t = title.trim();
                            if !t.is_empty() {
                                let title = push(&mut text, t);
                                let desc = push(&mut text, cut(desc.trim(), DESC_MAX));
                                progs.push(Prog { slot, start, end, title, desc });
                            }
                        }
                        field = 0;
                    }
                    _ => {}
                },
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }

        progs.sort_by_key(|p| (p.slot, p.start));
        // Alcune guide uniscono più fonti per lo stesso canale, con programmi sovrapposti:
        // si tiene una sola sequenza, scartando quelli che iniziano prima della fine del precedente.
        let mut last: Option<(u32, i64)> = None;
        progs.retain(|p| {
            if matches!(last, Some((slot, end)) if slot == p.slot && p.start < end) {
                return false;
            }
            last = Some((p.slot, p.end));
            true
        });
        let mut ranges = vec![(0u32, 0u32); slot_channels.len()];
        let mut i = 0;
        while i < progs.len() {
            let slot = progs[i].slot;
            let start = i;
            while i < progs.len() && progs[i].slot == slot {
                i += 1;
            }
            ranges[slot as usize] = (start as u32, i as u32);
        }
        let mut slot_of = HashMap::new();
        for (slot, channels) in slot_channels.iter().enumerate() {
            if ranges[slot].1 > ranges[slot].0 {
                for &c in channels {
                    slot_of.insert(c, slot as u32);
                }
            }
        }
        text.shrink_to_fit();
        progs.shrink_to_fit();
        Ok(Guide { serial, text, progs, ranges, slot_channels, slot_of })
    }

    pub fn info(&self) -> GuideInfo {
        GuideInfo { channels: self.slot_of.len(), programmes: self.progs.len() }
    }

    fn progs_of(&self, channel: u32) -> &[Prog] {
        match self.slot_of.get(&channel) {
            Some(&slot) => {
                let (a, b) = self.ranges[slot as usize];
                &self.progs[a as usize..b as usize]
            }
            None => &[],
        }
    }

    fn at(&self, channel: u32, t: i64) -> Option<&Prog> {
        let progs = self.progs_of(channel);
        // Ultimo programma iniziato entro `t`, se non è già finito.
        let i = progs.partition_point(|p| p.start <= t);
        progs[..i].last().filter(|p| p.end > t)
    }

    fn str(&self, (start, len): (u32, u32)) -> &str {
        &self.text[start as usize..(start + len) as usize]
    }

    fn out(&self, p: &Prog, with_desc: bool) -> Programme {
        Programme {
            start: p.start,
            end: p.end,
            title: self.str(p.title).to_string(),
            desc: if with_desc { self.str(p.desc).to_string() } else { String::new() },
        }
    }

    /// Programma in onda in questo momento su ciascun canale.
    pub fn now(&self, channels: &[u32], t: i64) -> Vec<Option<Programme>> {
        channels.iter().map(|&c| self.at(c, t).map(|p| self.out(p, false))).collect()
    }

    /// Programmi di ciascun canale che si sovrappongono all'intervallo [from, to).
    pub fn between(&self, channels: &[u32], from: i64, to: i64) -> Vec<Vec<Programme>> {
        channels
            .iter()
            .map(|&c| {
                self.progs_of(c).iter().filter(|p| p.end > from && p.start < to).map(|p| self.out(p, true)).collect()
            })
            .collect()
    }

    /// Canali della lista che hanno almeno un programma, in ordine di lista.
    pub fn channels(&self) -> Vec<u32> {
        let mut out: Vec<u32> = self.slot_of.keys().copied().collect();
        out.sort_unstable();
        out
    }

    /// Canali che in questo momento trasmettono un programma il cui titolo contiene `query`
    /// (già in minuscolo).
    pub fn search_now(&self, query: &str, t: i64) -> Vec<u32> {
        let mut out = Vec::new();
        for (slot, &(a, b)) in self.ranges.iter().enumerate() {
            let progs = &self.progs[a as usize..b as usize];
            let i = progs.partition_point(|p| p.start <= t);
            if let Some(p) = progs[..i].last().filter(|p| p.end > t) {
                if self.str(p.title).to_lowercase().contains(query) {
                    out.extend_from_slice(&self.slot_channels[slot]);
                }
            }
        }
        out
    }
}

fn append(field: u8, title: &mut String, desc: &mut String, s: &str) {
    if field == 1 {
        title.push_str(s);
    } else if desc.len() < DESC_MAX * 4 {
        desc.push_str(s);
    }
}

fn push(text: &mut String, s: &str) -> (u32, u32) {
    let start = text.len() as u32;
    text.push_str(s);
    (start, s.len() as u32)
}

/// I primi `max` caratteri.
fn cut(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// Orario XMLTV: "AAAAMMGGhhmmss +hhmm" (fuso facoltativo) -> secondi Unix.
fn parse_time(s: &str) -> Option<i64> {
    let s = s.trim();
    let digits = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (digits(0, 4)?, digits(4, 6)?, digits(6, 8)?);
    let (h, mi) = (digits(8, 10).unwrap_or(0), digits(10, 12).unwrap_or(0));
    let sec = digits(12, 14).unwrap_or(0);
    // Giorni dal 1970-01-01 (algoritmo dei giorni civili di H. Hinnant).
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut t = days * 86_400 + h * 3600 + mi * 60 + sec;
    if let Some(tz) = s.get(14..).map(str::trim).filter(|z| z.len() >= 5) {
        let sign = if tz.starts_with('-') { -1 } else { 1 };
        let off = tz.get(1..3)?.parse::<i64>().ok()? * 3600 + tz.get(3..5)?.parse::<i64>().ok()? * 60;
        t -= sign * off;
    }
    Some(t)
}

/// La guida della lista aperta (una alla volta, come la lista).
#[derive(Default)]
pub struct Guides(Mutex<Option<Guide>>);

impl Guides {
    pub fn set(&self, guide: Guide) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(guide);
    }

    pub fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Esegue `f` sulla guida della lista `serial`, se è caricata.
    pub fn with<T>(&self, serial: u64, f: impl FnOnce(&Guide) -> T) -> Option<T> {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().filter(|g| g.serial == serial).map(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="Rai1.it"><display-name>Rai 1</display-name></channel>
  <programme start="20261028120000 +0100" stop="20261028130000 +0100" channel="Rai1.it">
    <title lang="it">TG1 &amp; Meteo</title><title lang="en">News</title>
    <desc lang="it">Notizie del giorno.</desc>
  </programme>
  <programme start="20261028123000 +0100" stop="20261028133000 +0100" channel="RAI1.it">
    <title>Doppione da un'altra fonte</title>
  </programme>
  <programme start="20261028130000 +0100" stop="20261028140000 +0100" channel="rai1.it">
    <title><![CDATA[Champions League]]></title>
  </programme>
  <programme start="20261028120000 +0100" stop="20261028130000 +0100" channel="other.it">
    <title>Non nella lista</title>
  </programme>
</tv>"#;

    /// Su dati veri: `GLASSPLAY_LIST=lista.m3u GLASSPLAY_GUIDE=guida.xml cargo test -- --ignored big_guide`.
    #[test]
    #[ignore]
    fn big_guide() {
        let (Ok(list), Ok(guide)) = (std::env::var("GLASSPLAY_LIST"), std::env::var("GLASSPLAY_GUIDE")) else { return };
        let base = url::Url::parse("http://example.com/").unwrap();
        let mut store = crate::store::Store::empty();
        crate::playlist::parse_file(Path::new(&list), &base, |c| store.push(&c)).unwrap();
        let wanted = store.epg_ids();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        let t = std::time::Instant::now();
        let g = Guide::read(Path::new(&guide), wanted.clone(), now, 1).unwrap();
        let info = g.info();
        println!(
            "{} id nella lista, {} canali con programmi, {} programmi, letta in {:?}, testo {} KB",
            wanted.len(),
            info.channels,
            info.programmes,
            t.elapsed(),
            g.text.len() >> 10
        );
        let on_now = g.now(&g.channels(), now).iter().filter(|p| p.is_some()).count();
        println!("canali con un programma in onda adesso: {on_now}");
        let t = std::time::Instant::now();
        let hits = g.search_now("tg", now);
        println!("ricerca \"tg\" nei programmi in onda: {} canali in {:?}", hits.len(), t.elapsed());
    }

    #[test]
    fn times() {
        // 2026-10-28 12:00 a Roma (+01:00) = 11:00 UTC.
        assert_eq!(parse_time("20261028120000 +0100"), Some(1_793_185_200));
        assert_eq!(parse_time("20261028110000"), Some(1_793_185_200));
        assert_eq!(parse_time("19700101000000 -0030"), Some(1800));
        assert_eq!(parse_time("bad"), None);
    }

    #[test]
    fn reads_wanted_channels() {
        let noon = 1_793_185_200;
        let wanted = HashMap::from([("rai1.IT".to_string(), vec![4, 9])]);
        let g = Guide::parse(XML.as_bytes(), wanted, noon, 1).unwrap();
        assert_eq!(g.info().programmes, 2);
        assert_eq!(g.channels(), vec![4, 9]);
        let now = g.now(&[4, 5], noon + 60);
        assert_eq!(now[0].as_ref().unwrap().title, "TG1 & Meteo");
        assert!(now[1].is_none());
        let all = g.between(&[9], noon, noon + 7200);
        assert_eq!(all[0].len(), 2);
        assert_eq!(all[0][0].desc, "Notizie del giorno.");
        assert_eq!(all[0][1].title, "Champions League");
        assert_eq!(g.search_now("champions", noon + 3700), vec![4, 9]);
        assert!(g.search_now("champions", noon + 60).is_empty());
    }
}
