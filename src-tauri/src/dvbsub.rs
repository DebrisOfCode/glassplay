//! Sottotitoli DVB (ETSI EN 300 743): immagini trasmesse dentro lo stream MPEG-TS.
//!
//! I segmenti del lettore principale passano dal proxy; qui si trova la traccia dei
//! sottotitoli nella PMT (qualunque canale la porti), si ricompongono i pacchetti PES e
//! si decodifica ogni "display set" (pagina → regioni → palette → oggetti a pixel
//! compressi). Il risultato è un'immagine RGBA con posizione, PTS e durata.

use std::collections::HashMap;

const TS_PACKET: usize = 188;
const SUBTITLING_DESCRIPTOR: u8 = 0x59;
/// Dimensioni massime accettate per una regione (difesa contro dati corrotti).
const MAX_REGION_SIDE: usize = 4096;

/// Traccia sottotitoli DVB annunciata nella PMT.
#[derive(Clone, Debug, PartialEq)]
pub struct Track {
    pub pid: u16,
    /// Codice ISO 639 (es. "ita").
    pub language: String,
    pub composition_page: u16,
    pub ancillary_page: u16,
}

/// Un display set decodificato: `image` vuota significa "nessun sottotitolo a schermo".
#[derive(Debug)]
pub struct Subtitle {
    /// PTS a 90 kHz.
    pub pts: u64,
    /// Durata massima in secondi (`page_time_out`).
    pub timeout: u8,
    /// Area di riferimento delle coordinate (di solito 720×576 o 1920×1080).
    pub display: (u16, u16),
    pub image: Option<Image>,
}

#[derive(Debug)]
pub struct Image {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

// ---------- Ricerca della traccia (PAT → PMT) ----------

fn pid_of(pkt: &[u8]) -> u16 {
    (u16::from(pkt[1] & 0x1F) << 8) | u16::from(pkt[2])
}

fn payload(pkt: &[u8]) -> Option<&[u8]> {
    let adaptation = (pkt[3] >> 4) & 0x3;
    if adaptation & 0x1 == 0 {
        return None;
    }
    let offset = if adaptation & 0x2 != 0 { 5 + usize::from(pkt[4]) } else { 4 };
    pkt.get(offset..).filter(|p| !p.is_empty())
}

fn section_len(s: &[u8]) -> usize {
    3 + ((usize::from(s[1] & 0x0F) << 8) | usize::from(s[2]))
}

/// Traccia sottotitoli DVB del segmento, se la PMT ne annuncia una.
pub fn find_track(data: &[u8]) -> Option<Track> {
    let mut pmt_pids: Vec<u16> = Vec::new();
    for pkt in data.chunks_exact(TS_PACKET) {
        if pkt[0] != 0x47 {
            break;
        }
        if pkt[1] & 0x40 == 0 {
            continue; // le tabelle cercate iniziano sempre in un pacchetto con PUSI
        }
        let Some(p) = payload(pkt) else { continue };
        let Some(section) = p.get(1 + usize::from(p[0])..).filter(|s| s.len() >= 3) else { continue };
        let pid = pid_of(pkt);
        if pid == 0 && section[0] == 0x00 {
            pmt_pids = pat_programs(section);
        } else if pmt_pids.contains(&pid) && section[0] == 0x02 {
            if let Some(track) = pmt_subtitles(section) {
                return Some(track);
            }
        }
    }
    None
}

fn pat_programs(s: &[u8]) -> Vec<u16> {
    let end = section_len(s).min(s.len()).saturating_sub(4);
    let mut pids = Vec::new();
    let mut i = 8;
    while i + 4 <= end {
        let program = u16::from_be_bytes([s[i], s[i + 1]]);
        if program != 0 {
            pids.push((u16::from(s[i + 2] & 0x1F) << 8) | u16::from(s[i + 3]));
        }
        i += 4;
    }
    pids
}

fn pmt_subtitles(s: &[u8]) -> Option<Track> {
    if s.len() < 12 {
        return None;
    }
    let end = section_len(s).min(s.len()).saturating_sub(4);
    let info_len = (usize::from(s[10] & 0x0F) << 8) | usize::from(s[11]);
    let mut i = 12 + info_len;
    while i + 5 <= end {
        let pid = (u16::from(s[i + 1] & 0x1F) << 8) | u16::from(s[i + 2]);
        let es_len = (usize::from(s[i + 3] & 0x0F) << 8) | usize::from(s[i + 4]);
        let es_end = (i + 5 + es_len).min(end);
        let mut d = i + 5;
        while d + 2 <= es_end {
            let (tag, len) = (s[d], usize::from(s[d + 1]));
            // Prima voce del subtitling_descriptor: lingua, tipo, pagina di composizione e ausiliaria.
            if tag == SUBTITLING_DESCRIPTOR && len >= 8 && d + 10 <= es_end {
                return Some(Track {
                    pid,
                    language: String::from_utf8_lossy(&s[d + 2..d + 5]).into_owned(),
                    composition_page: u16::from_be_bytes([s[d + 6], s[d + 7]]),
                    ancillary_page: u16::from_be_bytes([s[d + 8], s[d + 9]]),
                });
            }
            d += 2 + len;
        }
        i += 5 + es_len;
    }
    None
}

// ---------- Decoder ----------

type Rgba = [u8; 4];

#[derive(Clone)]
struct Clut {
    c2: [Rgba; 4],
    c4: [Rgba; 16],
    c8: [Rgba; 256],
}

impl Default for Clut {
    /// Palette predefinite (EN 300 743, §10), usate se lo stream non ne definisce una.
    fn default() -> Self {
        let level = |on: bool, half: bool| if on { if half { 127 } else { 255 } } else { 0 };
        let c2 = [[0, 0, 0, 0], [255, 255, 255, 255], [0, 0, 0, 255], [127, 127, 127, 255]];
        let mut c4 = [[0u8; 4]; 16];
        for (i, c) in c4.iter_mut().enumerate().skip(1) {
            let half = i & 8 != 0;
            *c = [level(i & 1 != 0, half), level(i & 2 != 0, half), level(i & 4 != 0, half), 255];
        }
        let mut c8 = [[0u8; 4]; 256];
        for (i, c) in c8.iter_mut().enumerate().skip(1) {
            let v = |bit: usize, hi: usize| (if i & bit != 0 { 85 } else { 0 }) + (if i & hi != 0 { 170 } else { 0 });
            *c = [v(1, 16) as u8, v(2, 32) as u8, v(4, 64) as u8, if i & 0x88 == 0x08 { 127 } else { 255 }];
        }
        Clut { c2, c4, c8 }
    }
}

struct Region {
    width: usize,
    height: usize,
    /// 1 = 2 bit, 2 = 4 bit, 3 = 8 bit per pixel.
    depth: u8,
    clut: u8,
    pixels: Vec<u8>,
    /// Oggetti contenuti: (id, x, y) rispetto alla regione.
    objects: Vec<(u16, usize, usize)>,
}

#[derive(Default)]
pub struct Decoder {
    pes: Vec<u8>,
    in_pes: bool,
    display: Option<(u16, u16)>,
    page_timeout: u8,
    /// Regioni visibili nella pagina corrente: (id, x, y).
    page_regions: Vec<(u8, usize, usize)>,
    regions: HashMap<u8, Region>,
    cluts: HashMap<u8, Clut>,
    /// Pagina ricevuta ma non ancora mostrata (per gli encoder che omettono "fine display set").
    pending: bool,
}

impl Decoder {
    /// Elabora un segmento TS e restituisce i display set completati.
    /// I pacchetti PES possono iniziare in un segmento e finire nel successivo.
    pub fn feed(&mut self, data: &[u8], track: &Track) -> Vec<Subtitle> {
        let mut out = Vec::new();
        for pkt in data.chunks_exact(TS_PACKET) {
            if pkt[0] != 0x47 {
                break;
            }
            if pid_of(pkt) != track.pid {
                continue;
            }
            let Some(p) = payload(pkt) else { continue };
            if pkt[1] & 0x40 != 0 {
                self.finish_pes(track, &mut out);
                self.in_pes = true;
            }
            if !self.in_pes {
                continue;
            }
            self.pes.extend_from_slice(p);
            if self.pes.len() >= 6 {
                let declared = usize::from(u16::from_be_bytes([self.pes[4], self.pes[5]]));
                if declared > 0 && self.pes.len() >= 6 + declared {
                    self.finish_pes(track, &mut out);
                }
            }
        }
        out
    }

    fn finish_pes(&mut self, track: &Track, out: &mut Vec<Subtitle>) {
        let pes = std::mem::take(&mut self.pes);
        self.in_pes = false;
        if pes.len() < 14 || pes[..3] != [0, 0, 1] || pes[7] & 0x80 == 0 {
            return; // serve il PTS per sincronizzare
        }
        let pts = read_pts(&pes[9..14]);
        let Some(data) = pes.get(9 + usize::from(pes[8])..) else { return };
        // data_identifier 0x20, subtitle_stream_id 0x00, poi i segmenti (sync byte 0x0F).
        if data.len() < 2 || data[0] != 0x20 {
            return;
        }
        let mut i = 2;
        while i + 6 <= data.len() && data[i] == 0x0F {
            let kind = data[i + 1];
            let page = u16::from_be_bytes([data[i + 2], data[i + 3]]);
            let len = usize::from(u16::from_be_bytes([data[i + 4], data[i + 5]]));
            let Some(body) = data.get(i + 6..i + 6 + len) else { break };
            if page == track.composition_page || page == track.ancillary_page {
                match kind {
                    0x10 => self.page_composition(body),
                    0x11 => self.region_composition(body),
                    0x12 => self.clut_definition(body),
                    0x13 => self.object_data(body),
                    0x14 => self.display_definition(body),
                    0x80 => {
                        out.push(self.render(pts));
                        self.pending = false;
                    }
                    _ => {}
                }
            }
            i += 6 + len;
        }
        if self.pending {
            out.push(self.render(pts));
            self.pending = false;
        }
    }

    fn page_composition(&mut self, b: &[u8]) {
        if b.len() < 2 {
            return;
        }
        self.page_timeout = b[0];
        // "Acquisition point" o "mode change": la pagina riparte da zero.
        if (b[1] >> 2) & 0x3 != 0 {
            self.regions.clear();
        }
        self.page_regions = b[2..]
            .chunks_exact(6)
            .map(|r| (r[0], usize::from(u16::from_be_bytes([r[2], r[3]])), usize::from(u16::from_be_bytes([r[4], r[5]]))))
            .collect();
        self.pending = true;
    }

    fn region_composition(&mut self, b: &[u8]) {
        if b.len() < 10 {
            return;
        }
        let id = b[0];
        let fill = b[1] & 0x08 != 0;
        let width = usize::from(u16::from_be_bytes([b[2], b[3]]));
        let height = usize::from(u16::from_be_bytes([b[4], b[5]]));
        if width == 0 || height == 0 || width > MAX_REGION_SIDE || height > MAX_REGION_SIDE {
            return;
        }
        let depth = ((b[6] >> 2) & 0x7).clamp(1, 3);
        let background = match depth {
            1 => (b[9] >> 2) & 0x3,
            2 => b[9] >> 4,
            _ => b[8],
        };
        let mut objects = Vec::new();
        let mut j = 10;
        while j + 6 <= b.len() {
            let object = u16::from_be_bytes([b[j], b[j + 1]]);
            let kind = b[j + 2] >> 6;
            let x = (usize::from(b[j + 2] & 0x0F) << 8) | usize::from(b[j + 3]);
            let y = (usize::from(b[j + 4] & 0x0F) << 8) | usize::from(b[j + 5]);
            objects.push((object, x, y));
            j += if kind == 1 || kind == 2 { 8 } else { 6 };
        }
        let region = self.regions.entry(id).or_insert_with(|| Region {
            width,
            height,
            depth,
            clut: b[7],
            pixels: vec![background; width * height],
            objects: Vec::new(),
        });
        if region.width != width || region.height != height || region.depth != depth {
            *region = Region { width, height, depth, clut: b[7], pixels: vec![background; width * height], objects: Vec::new() };
        } else if fill {
            region.pixels.fill(background);
        }
        region.clut = b[7];
        region.objects = objects;
        self.pending = true;
    }

    fn clut_definition(&mut self, b: &[u8]) {
        if b.len() < 2 {
            return;
        }
        let clut = self.cluts.entry(b[0]).or_default();
        let mut j = 2;
        while j + 2 <= b.len() {
            let entry = usize::from(b[j]);
            let flags = b[j + 1];
            let (y, cr, cb, t, step) = if flags & 0x01 != 0 {
                let Some(v) = b.get(j + 2..j + 6) else { break };
                (v[0], v[1], v[2], v[3], 6)
            } else {
                let Some(v) = b.get(j + 2..j + 4) else { break };
                let v = u16::from_be_bytes([v[0], v[1]]);
                (((v >> 10) as u8) << 2, (((v >> 6) & 0xF) as u8) << 4, (((v >> 2) & 0xF) as u8) << 4, ((v & 0x3) as u8) << 6, 4)
            };
            let rgba = ycrcb_to_rgba(y, cr, cb, t);
            if flags & 0x80 != 0 && entry < 4 {
                clut.c2[entry] = rgba;
            }
            if flags & 0x40 != 0 && entry < 16 {
                clut.c4[entry] = rgba;
            }
            if flags & 0x20 != 0 {
                clut.c8[entry] = rgba;
            }
            j += step;
        }
        self.pending = true;
    }

    fn object_data(&mut self, b: &[u8]) {
        if b.len() < 7 || (b[2] >> 2) & 0x3 != 0 {
            return; // solo oggetti a pixel (i caratteri non sono usati in pratica)
        }
        let object = u16::from_be_bytes([b[0], b[1]]);
        let top_len = usize::from(u16::from_be_bytes([b[3], b[4]]));
        let bottom_len = usize::from(u16::from_be_bytes([b[5], b[6]]));
        let Some(top) = b.get(7..7 + top_len) else { return };
        // Senza campo inferiore, le righe dispari ripetono quelle pari.
        let bottom = if bottom_len == 0 { top } else { b.get(7 + top_len..7 + top_len + bottom_len).unwrap_or(top) };
        for region in self.regions.values_mut() {
            let places: Vec<(usize, usize)> = region.objects.iter().filter(|o| o.0 == object).map(|o| (o.1, o.2)).collect();
            for (x, y) in places {
                draw_field(region, x, y, top);
                draw_field(region, x, y + 1, bottom);
            }
        }
        self.pending = true;
    }

    fn display_definition(&mut self, b: &[u8]) {
        if b.len() >= 5 {
            let w = u16::from_be_bytes([b[1], b[2]]).saturating_add(1);
            let h = u16::from_be_bytes([b[3], b[4]]).saturating_add(1);
            self.display = Some((w, h));
        }
    }

    /// Compone le regioni della pagina in un'unica immagine ritagliata sui pixel visibili.
    fn render(&self, pts: u64) -> Subtitle {
        let display = self.display.unwrap_or((720, 576));
        let visible: Vec<(&Region, usize, usize)> = self
            .page_regions
            .iter()
            .filter_map(|&(id, x, y)| self.regions.get(&id).map(|r| (r, x, y)))
            .collect();
        let image = compose(&visible, &self.cluts);
        Subtitle { pts, timeout: self.page_timeout, display, image }
    }
}

fn compose(regions: &[(&Region, usize, usize)], cluts: &HashMap<u8, Clut>) -> Option<Image> {
    let right = regions.iter().map(|(r, x, _)| x + r.width).max()?;
    let bottom = regions.iter().map(|(r, _, y)| y + r.height).max()?;
    let left = regions.iter().map(|(_, x, _)| *x).min()?;
    let top = regions.iter().map(|(_, _, y)| *y).min()?;
    let (w, h) = (right - left, bottom - top);
    let mut rgba = vec![0u8; w * h * 4];
    let fallback = Clut::default();
    for (region, rx, ry) in regions {
        let clut = cluts.get(&region.clut).unwrap_or(&fallback);
        for py in 0..region.height {
            for px in 0..region.width {
                let index = region.pixels[py * region.width + px];
                let color = match region.depth {
                    1 => clut.c2[usize::from(index & 0x3)],
                    2 => clut.c4[usize::from(index & 0xF)],
                    _ => clut.c8[usize::from(index)],
                };
                if color[3] == 0 {
                    continue;
                }
                let o = ((ry - top + py) * w + (rx - left + px)) * 4;
                rgba[o..o + 4].copy_from_slice(&color);
            }
        }
    }
    crop(rgba, w, h, left, top)
}

/// Ritaglia l'immagine sui pixel non trasparenti; `None` se è tutta trasparente.
fn crop(rgba: Vec<u8>, w: usize, h: usize, x: usize, y: usize) -> Option<Image> {
    let opaque = |px: usize, py: usize| rgba[(py * w + px) * 4 + 3] != 0;
    let rows: Vec<usize> = (0..h).filter(|&py| (0..w).any(|px| opaque(px, py))).collect();
    let (&y0, &y1) = (rows.first()?, rows.last()?);
    let x0 = (0..w).find(|&px| (y0..=y1).any(|py| opaque(px, py)))?;
    let x1 = (0..w).rev().find(|&px| (y0..=y1).any(|py| opaque(px, py)))?;
    let (cw, ch) = (x1 - x0 + 1, y1 - y0 + 1);
    let mut out = Vec::with_capacity(cw * ch * 4);
    for py in y0..=y1 {
        out.extend_from_slice(&rgba[(py * w + x0) * 4..(py * w + x1 + 1) * 4]);
    }
    Some(Image { x: x + x0, y: y + y0, width: cw, height: ch, rgba: out })
}

fn read_pts(b: &[u8]) -> u64 {
    (u64::from(b[0] & 0x0E) << 29) | (u64::from(b[1]) << 22) | (u64::from(b[2] & 0xFE) << 14) | (u64::from(b[3]) << 7) | (u64::from(b[4]) >> 1)
}

/// Colore della palette: Y = 0 significa trasparenza totale; T è la trasparenza.
fn ycrcb_to_rgba(y: u8, cr: u8, cb: u8, t: u8) -> Rgba {
    if y == 0 {
        return [0, 0, 0, 0];
    }
    let (y, cr, cb) = (f32::from(y), f32::from(cr) - 128.0, f32::from(cb) - 128.0);
    let c = |v: f32| v.round().clamp(0.0, 255.0) as u8;
    [c(y + 1.402 * cr), c(y - 0.344_136 * cb - 0.714_136 * cr), c(y + 1.772 * cb), 255 - t]
}

// ---------- Pixel compressi (EN 300 743, §7.2.5) ----------

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Bits<'_> {
    fn read(&mut self, n: usize) -> usize {
        let mut v = 0;
        for _ in 0..n {
            let byte = self.data.get(self.pos / 8).copied().unwrap_or(0);
            v = (v << 1) | usize::from((byte >> (7 - self.pos % 8)) & 1);
            self.pos += 1;
        }
        v
    }

    fn exhausted(&self) -> bool {
        self.pos >= self.data.len() * 8
    }

    fn bytes_used(&self) -> usize {
        self.pos.div_ceil(8)
    }
}

/// Sequenze (codice, ripetizioni) di una stringa di pixel a 2, 4 o 8 bit.
fn decode_runs(bits: &mut Bits, depth: usize) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    while !bits.exhausted() {
        let code = bits.read(depth);
        if code != 0 {
            runs.push((code, 1));
            continue;
        }
        match depth {
            2 => {
                if bits.read(1) == 1 {
                    let n = bits.read(3) + 3;
                    runs.push((bits.read(2), n));
                } else if bits.read(1) == 1 {
                    runs.push((0, 1));
                } else {
                    match bits.read(2) {
                        0 => break,
                        1 => runs.push((0, 2)),
                        2 => {
                            let n = bits.read(4) + 12;
                            runs.push((bits.read(2), n));
                        }
                        _ => {
                            let n = bits.read(8) + 29;
                            runs.push((bits.read(2), n));
                        }
                    }
                }
            }
            4 => {
                if bits.read(1) == 0 {
                    let n = bits.read(3);
                    if n == 0 {
                        break;
                    }
                    runs.push((0, n + 2));
                } else if bits.read(1) == 0 {
                    let n = bits.read(2) + 4;
                    runs.push((bits.read(4), n));
                } else {
                    match bits.read(2) {
                        0 => runs.push((0, 1)),
                        1 => runs.push((0, 2)),
                        2 => {
                            let n = bits.read(4) + 9;
                            runs.push((bits.read(4), n));
                        }
                        _ => {
                            let n = bits.read(8) + 25;
                            runs.push((bits.read(4), n));
                        }
                    }
                }
            }
            _ => {
                if bits.read(1) == 0 {
                    let n = bits.read(7);
                    if n == 0 {
                        break;
                    }
                    runs.push((0, n));
                } else {
                    let n = bits.read(7);
                    runs.push((bits.read(8), n));
                }
            }
        }
    }
    runs
}

/// Disegna un campo (righe pari o dispari) di un oggetto dentro la regione.
fn draw_field(region: &mut Region, x0: usize, y0: usize, data: &[u8]) {
    let (mut x, mut y) = (x0, y0);
    let mut map_2_4: [u8; 4] = [0, 7, 8, 15];
    let mut map_2_8: [u8; 4] = [0x00, 0x77, 0x88, 0xFF];
    let mut map_4_8: [u8; 16] = std::array::from_fn(|k| (k as u8) * 0x11);
    let mut i = 0;
    while i < data.len() {
        let kind = data[i];
        i += 1;
        let source_depth = match kind {
            0x10 => 2,
            0x11 => 4,
            0x12 => 8,
            0x20 => {
                if let Some(m) = data.get(i..i + 2) {
                    map_2_4 = [m[0] >> 4, m[0] & 0xF, m[1] >> 4, m[1] & 0xF];
                }
                i += 2;
                continue;
            }
            0x21 => {
                if let Some(m) = data.get(i..i + 4) {
                    map_2_8.copy_from_slice(m);
                }
                i += 4;
                continue;
            }
            0x22 => {
                if let Some(m) = data.get(i..i + 16) {
                    map_4_8.copy_from_slice(m);
                }
                i += 16;
                continue;
            }
            0xF0 => {
                x = x0;
                y += 2;
                continue;
            }
            _ => return, // codifica sconosciuta: meglio fermarsi che disegnare spazzatura
        };
        let mut bits = Bits { data: &data[i..], pos: 0 };
        for (code, run) in decode_runs(&mut bits, source_depth) {
            // I codici vanno portati alla profondità della regione.
            let value = match (source_depth, region.depth) {
                (2, 2) => map_2_4[code & 0x3],
                (2, 3) => map_2_8[code & 0x3],
                (4, 3) => map_4_8[code & 0xF],
                (4, 1) | (8, 1) => (code >> (source_depth - 2)) as u8,
                (8, 2) => (code >> 4) as u8,
                _ => code as u8,
            };
            for _ in 0..run {
                if x < region.width && y < region.height {
                    region.pixels[y * region.width + x] = value;
                }
                x += 1;
            }
        }
        i += bits.bytes_used();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACK: Track = Track { pid: 0x102, language: String::new(), composition_page: 1, ancillary_page: 1 };

    fn segment(kind: u8, body: &[u8]) -> Vec<u8> {
        let mut s = vec![0x0F, kind, 0x00, 0x01];
        s.extend_from_slice(&(body.len() as u16).to_be_bytes());
        s.extend_from_slice(body);
        s
    }

    /// Pacchetti TS sul PID dei sottotitoli che trasportano un PES con PTS e i segmenti dati.
    fn pes_packets(pts: u64, segments: &[Vec<u8>]) -> Vec<u8> {
        let mut data = vec![0x20, 0x00];
        for s in segments {
            data.extend_from_slice(s);
        }
        data.push(0xFF);
        let pts_bytes = [
            0x21 | (((pts >> 30) & 0x7) as u8) << 1,
            (pts >> 22) as u8,
            ((((pts >> 15) & 0x7F) as u8) << 1) | 1,
            (pts >> 7) as u8,
            (((pts & 0x7F) as u8) << 1) | 1,
        ];
        let mut pes = vec![0, 0, 1, 0xBD, 0, 0, 0x81, 0x80, 5];
        pes.extend_from_slice(&pts_bytes);
        pes.extend_from_slice(&data);
        let len = (pes.len() - 6) as u16;
        pes[4..6].copy_from_slice(&len.to_be_bytes());
        let mut out = Vec::new();
        for (n, chunk) in pes.chunks(184).enumerate() {
            let mut pkt = vec![0x47, if n == 0 { 0x41 } else { 0x01 }, 0x02, 0x10 | (n as u8 & 0xF)];
            pkt.extend_from_slice(chunk);
            pkt.resize(TS_PACKET, 0xFF);
            out.extend(pkt);
        }
        out
    }

    fn sample_display_set() -> Vec<Vec<u8>> {
        // Pagina con la regione 0 in (100, 500).
        let page = segment(0x10, &[10, 0b0000_0100, 0, 0, 0, 100, 0x01, 0xF4]);
        // Regione 8×4 a 4 bit, palette 1, sfondo 0, con l'oggetto 7 in (2, 1).
        let region = segment(0x11, &[0, 0x08, 0, 8, 0, 4, 0b0000_1000, 1, 0, 0, 0x00, 0x07, 0x00, 0x02, 0x00, 0x01]);
        // Palette 1: voce 1 bianca opaca (gamma completa).
        let clut = segment(0x12, &[1, 0, 1, 0x40 | 0x01, 235, 128, 128, 0]);
        // Oggetto 7: una riga di 3 pixel con codice 1 (stringa a 4 bit), stesso campo sotto.
        let pixels = [0x11, 0x11, 0x10, 0x00, 0xF0];
        let mut object = vec![0x00, 0x07, 0x00];
        object.extend_from_slice(&(pixels.len() as u16).to_be_bytes());
        object.extend_from_slice(&0u16.to_be_bytes());
        object.extend_from_slice(&pixels);
        vec![page, region, clut, segment(0x13, &object), segment(0x80, &[])]
    }

    #[test]
    fn decodes_a_display_set() {
        let mut decoder = Decoder::default();
        let subs = decoder.feed(&pes_packets(900_000, &sample_display_set()), &TRACK);
        assert_eq!(subs.len(), 1);
        let s = &subs[0];
        assert_eq!((s.pts, s.timeout, s.display), (900_000, 10, (720, 576)));
        let img = s.image.as_ref().expect("immagine");
        // Oggetto in (2,1) dentro la regione in (100,500): 3 pixel × 2 righe (campi pari e dispari).
        assert_eq!((img.x, img.y, img.width, img.height), (102, 501, 3, 2));
        assert!(img.rgba.chunks(4).all(|p| p[3] == 255 && p[0] > 200 && p[1] > 200 && p[2] > 200));
    }

    #[test]
    fn empty_page_clears_the_screen() {
        let mut decoder = Decoder::default();
        let page = segment(0x10, &[5, 0b0000_0100]);
        let subs = decoder.feed(&pes_packets(1_000, &[page, segment(0x80, &[])]), &TRACK);
        assert_eq!(subs.len(), 1);
        assert!(subs[0].image.is_none());
    }

    #[test]
    fn pes_split_across_segments() {
        // Un segmento di riempimento (tipo sconosciuto, ignorato) fa occupare al PES più pacchetti.
        let mut set = sample_display_set();
        set.insert(0, segment(0x40, &[0; 300]));
        let packets = pes_packets(42, &set);
        assert!(packets.len() > TS_PACKET);
        let (a, b) = packets.split_at(TS_PACKET);
        let mut decoder = Decoder::default();
        assert!(decoder.feed(a, &TRACK).is_empty());
        let mut next = b.to_vec();
        // Il segmento successivo inizia con un nuovo PES che chiude il precedente.
        next.extend(pes_packets(99, &[segment(0x10, &[5, 0b0000_0100]), segment(0x80, &[])]));
        let subs = decoder.feed(&next, &TRACK);
        assert_eq!(subs.iter().map(|s| s.pts).collect::<Vec<_>>(), vec![42, 99]);
        assert!(subs[0].image.is_some());
    }

    #[test]
    fn finds_track_in_pmt() {
        let mut pat = vec![0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xE1, 0x00];
        pat.extend_from_slice(&[0, 0, 0, 0]);
        pat.resize(TS_PACKET, 0xFF);
        let mut pmt_body = vec![0x00, 0x01, 0xC1, 0x00, 0x00, 0xE1, 0x00, 0xF0, 0x00];
        pmt_body.extend_from_slice(&[0x1B, 0xE1, 0x00, 0xF0, 0x00]); // video
        pmt_body.extend_from_slice(&[0x06, 0xE1, 0x02, 0xF0, 0x0A, 0x59, 0x08, b'i', b't', b'a', 0x10, 0x00, 0x01, 0x00, 0x01]);
        pmt_body.extend_from_slice(&[0, 0, 0, 0]);
        let mut pmt = vec![0x47, 0x41, 0x00, 0x10, 0x00, 0x02, 0xB0, pmt_body.len() as u8];
        pmt.extend_from_slice(&pmt_body);
        pmt.resize(TS_PACKET, 0xFF);
        let mut ts = pat;
        ts.extend(pmt);
        let track = find_track(&ts).expect("traccia");
        assert_eq!((track.pid, track.language.as_str(), track.composition_page), (0x102, "ita", 1));
    }

    /// Prova su un segmento reale: `GLASSPLAY_TS=percorso cargo test real_segment -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_segment() {
        let paths = std::env::var("GLASSPLAY_TS").expect("GLASSPLAY_TS");
        let mut decoder = Decoder::default();
        let mut track = None;
        for path in paths.split(';') {
            let data = std::fs::read(path).expect("segmento");
            track = find_track(&data).or(track);
            let t = track.clone().expect("nessuna traccia DVB");
            for s in decoder.feed(&data, &t) {
                match &s.image {
                    Some(i) => println!("pts {} display {:?} timeout {} -> immagine {}x{} in ({}, {})", s.pts, s.display, s.timeout, i.width, i.height, i.x, i.y),
                    None => println!("pts {} -> schermo vuoto", s.pts),
                }
            }
        }
        println!("traccia: {track:?}");
    }
}
