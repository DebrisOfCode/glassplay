(() => {
  'use strict';

  const { invoke } = window.__TAURI__.core;
  const appWindow = window.__TAURI__.window.getCurrentWindow();

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const video = $('video');
  const els = {
    stage: $('stage'), list: $('list'), rows: $('rows'), listEmpty: $('listEmpty'), hl: $('hl'), count: $('count'), title: $('title'),
    srcBtn: $('srcBtn'), srcName: $('srcName'), srcHost: $('srcHost'), optionsBtn: $('optionsBtn'),
    empty: $('empty'), emptyForm: $('emptyForm'), emptyInput: $('emptyInput'), searchInput: $('searchInput'),
    card: $('card'), cardLogo: $('cardLogo'), cardName: $('cardName'),
    spinner: $('spinner'), controls: $('controls'), nowLogo: $('nowLogo'), nowName: $('nowName'), nowProgram: $('nowProgram'),
    muteBtn: $('muteBtn'), volume: $('volume'), fsBtn: $('fsBtn'), subsBtn: $('subsBtn'), subCanvas: $('subCanvas'),
    sidebar: $('sidebar'), sbToggle: $('sbToggle'), toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'),
    refreshBtn: $('refreshBtn'), updatedAt: $('updatedAt'), statusTexts: document.querySelectorAll('.status-text'),
    fileInput: $('fileInput'), emptyFile: $('emptyFile'),
    menu: $('menu'),
    preview: $('preview'), pvVideo: $('pvVideo'), pvName: $('pvName'), pvMsg: $('pvMsg'), pvProg: $('pvProg'),
    videoWrap: $('videoWrap'), topBtn: $('topBtn'), pageUp: $('pageUp'), pageDown: $('pageDown'),
    publicLists: $('publicLists'), browseClose: $('browseClose'), guideBtn: $('guideBtn'),
    guide: $('guide'), gBody: $('gBody'), gCanvas: $('gCanvas'), gRuler: $('gRuler'), gNow: $('gNow'),
    gClock: $('gClock'), gClose: $('gClose'), gEmpty: $('gEmpty'), gDay: $('gDay'),
    gPrev: $('gPrev'), gNowBtn: $('gNowBtn'), gNext: $('gNext'),
    gFootLogo: $('gFootLogo'), gFootName: $('gFootName'), gFootProg: $('gFootProg'),
    dialog: $('dialog'), dialogScrim: $('dialogScrim'), dialogForm: $('dialogForm'), dialogIcon: $('dialogIcon'),
    dialogTitle: $('dialogTitle'), dialogText: $('dialogText'), dialogFields: $('dialogFields'),
    dialogCancel: $('dialogCancel'), dialogConfirm: $('dialogConfirm'),
  };

  // Le richieste di hls.js passano dal proxy Rust (protocollo "stream") per evitare i blocchi CORS.
  // L'indirizzo dipende dalla piattaforma (http://stream.localhost/ su Windows e Android): lo calcola Tauri.
  const PROXY = window.__TAURI__.core.convertFileSrc('', 'stream');

  // Telefoni e schermi touch: niente passaggio del mouse, niente finestra da gestire.
  const touch = matchMedia('(hover: none)').matches;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  // Android TV: si naviga con il telecomando. Sui televisori l'app Android aggiunge "GlassPlayTV"
  // allo user agent (MainActivity.kt); in mancanza conta l'assenza di touch screen. Le sole media
  // query non bastano: molti box (es. Xiaomi Mi Box S) dichiarano il telecomando come puntatore,
  // e l'app si comportava come sul computer (pannello che spariva e ricompariva a ogni tasto).
  // localStorage "glassplay.tv" = "true" forza la modalità (per provarla su altri dispositivi).
  let forcedTv = false;
  try { forcedTv = localStorage.getItem('glassplay.tv') === 'true'; } catch { /* storage non disponibile */ }
  const tv = forcedTv || /GlassPlayTV/.test(navigator.userAgent)
    || (mobile && (navigator.maxTouchPoints === 0 || matchMedia('(pointer: none)').matches));
  // Versione "legacy" per dispositivi poco potenti (cartella legacy/, la attiva legacy/lite.js):
  // niente anteprime video, effetti grafici ridotti, buffer del lettore più piccoli.
  const lite = window.GLASSPLAY_LITE === true;
  // Versione legacy su Android: il video lo riproduce ExoPlayer (MainActivity.kt) sotto la
  // pagina, con i decoder hardware del box; hls.js non regge l'alta definizione su quei processori.
  const nativePlayer = lite && window.GlassPlayNative ? window.GlassPlayNative : null;
  const narrow = () => matchMedia('(max-width: 720px)').matches;
  // macOS: la finestra usa i pulsanti nativi (semaforo) al posto di quelli disegnati dall'app.
  const mac = !mobile && /Macintosh|Mac OS X/i.test(navigator.userAgent);
  document.body.classList.toggle('mac', mac);
  document.body.classList.toggle('touch', touch || tv);
  document.body.classList.toggle('mobile', mobile);
  document.body.classList.toggle('tv', tv);
  document.body.classList.toggle('lite', lite);
  // La versione legacy non ha l'anteprima al passaggio: via anche il suo secondo lettore video.
  if (lite) {
    els.preview.remove();
    els.preview = null;
  }
  const proxify = (url) => (url.startsWith(PROXY) ? url : `${PROXY}?u=${encodeURIComponent(url)}`);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(`glassplay.${key}`);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`glassplay.${key}`, JSON.stringify(value)); } catch { /* storage non disponibile */ }
    },
  };

  const state = {
    sources: [],   // liste salvate
    active: null,  // id della lista attiva
    serial: 0,     // lista aperta in Rust (0 = nessuna), vedi "Canali"
    total: 0,      // numero di canali della lista aperta
    updatedAt: 0,  // ultimo download della lista attiva (secondi Unix)
    current: -1,   // indice del canale in riproduzione
    playing: null, // canale in riproduzione: { name, image, stream, group }
    hls: null,
    token: 0,
    hasPlayed: false,
    volume: store.get('volume', 0.8),
    muted: store.get('muted', false),
    previewOn: !lite && store.get('preview', true),
    // Proxy per tutto il traffico (configurazione salvata in Rust).
    proxy: { enabled: false, url: '', username: '', password: '' },
    // Guida dei programmi caricata per la lista aperta: { serial, channels, programmes, at }.
    guide: null,
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  /** Crea un elemento con classe e testo opzionali. */
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // ---------- Lingua ----------

  const LANGS = Object.keys(I18N.names);
  let langPref = store.get('lang', 'auto'); // 'auto' = lingua di sistema
  let lang = 'en';

  function systemLang() {
    for (const l of navigator.languages || [navigator.language]) {
      const code = String(l).slice(0, 2).toLowerCase();
      if (LANGS.includes(code)) return code;
    }
    return 'en';
  }

  /** Testo tradotto; i segnaposto {nome} vengono sostituiti con `params`. */
  function tr(key, params = {}) {
    const text = I18N[lang][key] ?? I18N.en[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
  }

  const DETAIL_ERRORS = new Set(['timeout', 'connect', 'interrupted', 'network', 'invalid_json']);

  /** Gli errori di Rust arrivano come "codice:dettaglio"; tutto il resto passa invariato. */
  function errText(err) {
    const m = /^([a-z_]+)(?::([\s\S]*))?$/.exec(String(err));
    if (!m || !(`err.${m[1]}` in I18N.en)) return String(err);
    const detail = m[2] || '';
    const text = tr(`err.${m[1]}`, { detail });
    return DETAIL_ERRORS.has(m[1]) && detail ? `${text} (${detail})` : text;
  }

  /** Aggiorna i testi statici della pagina (attributi data-i18n*). */
  function applyLanguage() {
    lang = langPref === 'auto' ? systemLang() : langPref;
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = tr(el.dataset.i18nTitle);
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = tr(el.dataset.i18nPlaceholder);
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', tr(el.dataset.i18nAria));
  }

  function setLanguage(pref) {
    langPref = pref;
    store.set('lang', pref);
    applyLanguage();
    // Testi generati dal codice.
    renderSourceButton();
    if (state.updatedAt) els.updatedAt.textContent = formatUpdated(state.updatedAt);
    renderProgram();
    rebuild({ keepScroll: true });
    if (publicVisible()) renderPublicLists();
    if (gv.open) refreshGuide();
  }

  // ---------- Icone ----------

  const svg = (paths, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24">${paths}</svg>`;
  const FOLDER_PATH = '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>';
  const ICONS = {
    mute: svg('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>'),
    vol0: svg('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/>'),
    vol1: svg('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>'),
    vol2: svg('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18.3 6.8a7.5 7.5 0 0 1 0 10.4"/>'),
    pin: svg('<path d="M9 3.5h6l-1 5.5 3.5 3.5v2h-11v-2L10 9z"/><path d="M12 14.5v6"/>'),
    more: svg('<g fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></g>'),
    folder: svg(FOLDER_PATH),
    folderPlus: svg(`${FOLDER_PATH}<path d="M12 11v5M9.5 13.5h5"/>`),
    chev: svg('<path d="M7 10l5 5 5-5"/>', 'chev'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    trash: svg('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
    down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
    out: svg('<path d="M14 5h5v14h-5M10 8l-4 4 4 4M6 12h10"/>'),
    eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
    file: svg('<path d="M6.5 3.5h7.5l4 4v13h-11.5z"/><path d="M14 3.5v4h4M9.5 12.5h5M9.5 16h5"/>'),
    globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>'),
    shield: svg('<path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>'),
    reload: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>'),
  };

  // ---------- Logo / iniziali ----------

  function hue(text) {
    let v = 0;
    for (const c of text) v = (v * 31 + c.codePointAt(0)) % 360;
    return v;
  }

  function initials(name) {
    const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '•';
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  }

  /** Riempie `el` con il logo del canale, oppure con le iniziali su sfondo colorato. */
  function fillLogo(el, ch) {
    const fallback = () => {
      el.replaceChildren();
      el.classList.add('initials');
      el.style.setProperty('--h', hue(ch.name));
      el.textContent = initials(ch.name);
    };
    el.classList.remove('initials');
    el.textContent = '';
    if (!ch.image) return fallback();
    const img = new Image();
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = fallback;
    // Con il proxy attivo anche i loghi passano da lì (attraverso Rust).
    img.src = state.proxy.enabled ? proxify(ch.image) : ch.image;
    el.append(img);
  }

  // ---------- Organizzazione: cartelle e canali fissati ----------
  //
  // Salvata per lista (in Rust, accanto alla copia della lista). I canali sono identificati
  // dal loro URL di stream, che resta stabile anche quando la lista viene riscaricata.
  // Ogni canale sta in un solo posto: in una cartella, tra i fissati o nella lista principale.

  const PIN = '\u0001pin';
  const org = {
    data: { folders: [], pinned: [] },
    where: new Map(), // stream -> id cartella | PIN
    idx: new Map(),   // stream -> posizione del canale nella lista aperta (-1 se non c'è)
    pending: null,    // salvataggio in attesa { id, timer }
  };

  function normalizeOrg(raw) {
    const strings = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string') : []);
    const folders = Array.isArray(raw?.folders)
      ? raw.folders.filter((f) => f && typeof f.id === 'string').map((f) => ({
        id: f.id, name: String(f.name || tr('folder.default')), open: f.open !== false, items: strings(f.items),
      }))
      : [];
    return { folders, pinned: strings(raw?.pinned) };
  }

  function indexOrg() {
    org.where.clear();
    for (const f of org.data.folders) for (const s of f.items) org.where.set(s, f.id);
    for (const s of org.data.pinned) org.where.set(s, PIN);
    // Canali già in una cartella o tra i fissati: non si ripetono nella lista principale.
    list.filed = new Uint8Array(state.total);
    for (const s of org.where.keys()) {
      const i = org.idx.get(s);
      if (i >= 0) list.filed[i] = 1;
    }
  }

  const inList = (stream) => org.idx.get(stream) >= 0;

  function saveOrg() {
    if (org.pending) clearTimeout(org.pending.timer);
    const id = state.active;
    org.pending = { id, timer: setTimeout(flushOrg, 300) };
  }

  function flushOrg() {
    if (!org.pending) return;
    clearTimeout(org.pending.timer);
    const { id } = org.pending;
    org.pending = null;
    invoke('save_org', { id, org: org.data })
      .catch((err) => toast(tr('toast.saveOrgFail', { error: errText(err) }), { kind: 'error' }));
  }

  function orgChanged() {
    indexOrg();
    saveOrg();
    rebuild({ keepScroll: true });
  }

  const folderById = (id) => org.data.folders.find((f) => f.id === id);

  /** Toglie il canale dalla cartella o dai fissati. */
  function detach(stream) {
    const at = org.where.get(stream);
    if (at === PIN) org.data.pinned = org.data.pinned.filter((s) => s !== stream);
    else if (at) {
      const f = folderById(at);
      if (f) f.items = f.items.filter((s) => s !== stream);
    }
  }

  function togglePin(stream) {
    const wasPinned = org.where.get(stream) === PIN;
    detach(stream);
    if (!wasPinned) org.data.pinned.push(stream);
    orgChanged();
    toast(tr(wasPinned ? 'toast.unpinned' : 'toast.pinned'));
  }

  function moveToFolder(stream, folderId) {
    const f = folderById(folderId);
    if (!f || org.where.get(stream) === f.id) return;
    detach(stream);
    f.items.push(stream);
    orgChanged();
    toast(tr('toast.moved', { folder: f.name }));
  }

  function unfile(stream) {
    if (!org.where.has(stream)) return;
    detach(stream);
    orgChanged();
  }

  async function createFolder(stream) {
    const v = await dialog({
      title: tr('dlg.newFolder'),
      fields: [{ name: 'name', label: tr('dlg.name'), placeholder: tr('dlg.folderPh'), required: true }],
      confirm: tr('dlg.create'),
    });
    if (!v) return;
    const f = { id: `f${Date.now().toString(36)}`, name: v.name || tr('folder.default'), open: true, items: [] };
    org.data.folders.push(f);
    if (stream) {
      detach(stream);
      f.items.push(stream);
    }
    orgChanged();
  }

  async function renameFolder(f) {
    const v = await dialog({
      title: tr('dlg.renameFolder'),
      fields: [{ name: 'name', label: tr('dlg.name'), value: f.name, required: true }],
      confirm: tr('dlg.save'),
    });
    if (!v || !v.name) return;
    f.name = v.name;
    orgChanged();
  }

  /** Sposta la cartella nella posizione di `target` (prima o dopo, secondo la direzione). */
  function placeFolder(f, target) {
    const a = org.data.folders;
    const to = a.indexOf(target);
    a.splice(a.indexOf(f), 1);
    a.splice(to, 0, f);
    orgChanged();
  }

  function moveFolder(f, dir) {
    const a = org.data.folders;
    const target = a[a.indexOf(f) + dir];
    if (target) placeFolder(f, target);
  }

  async function deleteFolder(f) {
    const ok = await dialog({
      title: tr('dlg.deleteFolder', { name: f.name }),
      text: tr('dlg.deleteFolderText'),
      confirm: tr('dlg.delete'),
      danger: true,
    });
    if (!ok) return;
    org.data.folders = org.data.folders.filter((x) => x !== f);
    orgChanged();
  }

  function toggleFolder(f) {
    f.open = !f.open;
    orgChanged();
  }

  // ---------- Canali (tenuti in Rust) ----------
  //
  // La lista vive in Rust (store.rs) in forma compatta: la WebView riceve solo i canali che
  // le servono (righe visibili, canale in riproduzione) e li tiene qui finché restano utili.
  // Con 300.000 canali la memoria della WebView passa da centinaia di MB a pochi MB.

  const chans = new Map(); // indice -> { name, image, stream, group }
  const asked = new Set(); // indici chiesti a Rust e non ancora arrivati
  const KEEP_CHANNELS = 3000;

  /** Chiede a Rust i canali `indices` della lista aperta. */
  async function fetchChannels(indices) {
    const serial = state.serial;
    for (const i of indices) asked.add(i);
    try {
      const got = await invoke('channels', { serial, indices });
      if (serial !== state.serial) return; // nel frattempo è stata aperta un'altra lista
      // Con la guida caricata, anche il programma in onda (mostrato sotto il nome).
      const now = state.guide?.serial === serial ? await invoke('guide_now', { serial, indices }).catch(() => null) : null;
      if (serial !== state.serial) return;
      indices.forEach((i, k) => {
        if (!got[k]) return;
        got[k].now = now?.[k] || null;
        chans.set(i, got[k]);
      });
    } finally {
      if (serial === state.serial) for (const i of indices) asked.delete(i);
    }
  }

  /** Il canale `i`, chiedendolo a Rust se non è già qui. */
  async function getChannel(i) {
    if (!chans.has(i)) await fetchChannels([i]).catch(() => {});
    return chans.get(i);
  }

  /** Stream del canale `i` (visibile), ricordandone la posizione per cartelle e fissati. */
  function streamAt(i) {
    const s = chans.get(Number(i)).stream;
    if (!inList(s)) org.idx.set(s, Number(i));
    return s;
  }

  /** Lista appena aperta in Rust: i canali della precedente non valgono più. */
  function resetChannels(serial, total) {
    state.serial = serial;
    state.total = total;
    chans.clear();
    asked.clear();
    list.hits = null;
    list.query = '';
  }

  /** Tiene in memoria solo i canali vicini alla parte visibile (e quello in riproduzione). */
  function trimChannels(from, to) {
    const keep = new Set();
    for (let p = Math.max(0, from); p < Math.min(list.n, to); p++) if (list.kind[p] === K_CH) keep.add(list.ref[p]);
    for (const i of chans.keys()) if (!keep.has(i) && i !== state.current) chans.delete(i);
  }

  // ---------- Lista canali (virtuale) ----------
  //
  // Anche con centinaia di migliaia di canali il DOM contiene solo le righe visibili.
  // La vista è un elenco di righe di tre tipi (sezione, cartella, canale) con altezze
  // diverse: `top` contiene la posizione di ogni riga, così la ricerca della prima riga
  // visibile è una ricerca binaria. I dati dei canali arrivano da Rust man mano che
  // le righe diventano visibili (con un margine sopra e sotto, chiesto in anticipo).

  const K_CH = 0;
  const K_FOLDER = 1;
  const K_SEC = 2;
  const HEIGHT = [60, 50, 30]; // deve coincidere con .ch, .folder e .sec in style.css
  const OVERSCAN_PX = lite ? 180 : 360;
  const PREFETCH = 40; // righe chieste in anticipo, sopra e sotto quelle visibili

  const list = {
    kind: new Uint8Array(0),
    ref: new Int32Array(0),    // indice canale | indice cartella | indice sezione
    nested: new Uint8Array(0), // 1 se il canale è dentro una cartella aperta
    top: new Float64Array(1),
    n: 0,
    posOf: new Int32Array(0),  // indice canale -> posizione nella vista (-1 se assente)
    filed: new Uint8Array(0),  // 1 se il canale sta in una cartella o tra i fissati
    secs: [],
    matches: 0,
    query: '',                 // ricerca a cui si riferiscono `hits`
    hits: null,                // risultati della ricerca (Uint32Array), null senza ricerca
    rows: new Map(),           // posizione -> riga nel DOM
    loading: null,             // richiesta in corso dei canali visibili
    animate: false,
    frame: 0,
  };

  function buildView() {
    const q = list.hits ? list.query : '';
    const total = state.total;
    const { folders, pinned } = org.data;
    const cap = total + folders.length + 3;
    const kind = new Uint8Array(cap);
    const ref = new Int32Array(cap);
    const nested = new Uint8Array(cap);
    const secs = [];
    let n = 0;
    let matches = 0;
    const push = (k, r, nest = 0) => { kind[n] = k; ref[n] = r; nested[n] = nest; n++; };
    const section = (label, drop) => { secs.push({ label, drop }); push(K_SEC, secs.length - 1); };
    const pushStream = (s, nest) => {
      const i = org.idx.get(s);
      if (i >= 0) push(K_CH, i, nest);
    };

    if (q) {
      // Ricerca (fatta in Rust): risultati in un'unica lista, ovunque si trovino.
      for (const i of list.hits) push(K_CH, i);
      matches = n;
    } else {
      if (folders.length) {
        section(tr('sec.folders'), null);
        folders.forEach((f, fi) => {
          push(K_FOLDER, fi);
          if (f.open) for (const s of f.items) pushStream(s, 1);
        });
      }
      if (pinned.length) {
        section(tr('sec.pinned'), 'pin');
        for (const s of pinned) pushStream(s, 0);
      }
      if (folders.length || pinned.length) section(tr('sec.all'), 'all');
      const { filed } = list;
      for (let i = 0; i < total; i++) if (!filed[i]) push(K_CH, i);
    }

    const top = new Float64Array(n + 1);
    for (let p = 0; p < n; p++) top[p + 1] = top[p] + HEIGHT[kind[p]];
    const posOf = new Int32Array(total).fill(-1);
    for (let p = 0; p < n; p++) if (kind[p] === K_CH) posOf[ref[p]] = p;
    Object.assign(list, { kind, ref, nested, top, n, posOf, secs, matches, query: q });
  }

  function channelRow(i, pos) {
    const ch = chans.get(i);
    const pinned = org.where.get(ch.stream) === PIN;
    const row = h('div', 'ch');
    row.classList.toggle('active', i === state.current);
    row.classList.toggle('nested', list.nested[pos] === 1);
    row.classList.toggle('pinned', pinned);
    row.dataset.i = i;
    row.draggable = true;
    row.tabIndex = -1; // raggiungibile con il telecomando

    const logo = h('div', 'logo');
    fillLogo(logo, ch);
    const meta = h('div', 'meta');
    // Sotto il nome: il programma in onda (dalla guida) o, in mancanza, il gruppo.
    meta.append(h('span', 'name', ch.name), ch.now ? h('span', 'group prog', ch.now.title) : h('span', 'group', ch.group || ''));
    const eq = h('span', 'eq');
    eq.innerHTML = '<i></i><i></i><i></i>';
    const acts = h('div', 'acts');
    acts.innerHTML = `<button class="act reload" data-act="reload" type="button">${ICONS.reload}</button>`
      + `<button class="act pin" data-act="pin" type="button">${ICONS.pin}</button>`
      + `<button class="act more" data-act="more" type="button">${ICONS.more}</button>`;
    const [reload, pin, more] = acts.children;
    reload.title = tr('ch.reload');
    pin.title = tr(pinned ? 'act.unpin' : 'act.pin');
    more.title = tr('act.more');
    row.append(logo, meta, eq, acts);
    return row;
  }

  function folderRow(fi) {
    const f = org.data.folders[fi];
    const row = h('div', f.open ? 'folder open' : 'folder');
    row.dataset.f = fi;
    row.draggable = true;
    row.tabIndex = -1;
    const count = f.items.reduce((n, s) => n + (inList(s) ? 1 : 0), 0);
    row.innerHTML = `${ICONS.chev}<span class="f-icon">${ICONS.folder}</span>`;
    row.append(h('span', 'f-name', f.name), h('span', 'f-count', fmtInt(count)));
    const acts = h('div', 'acts');
    acts.innerHTML = `<button class="act more" data-act="fmore" type="button">${ICONS.more}</button>`;
    acts.firstChild.title = tr('act.folderOptions');
    row.append(acts);
    return row;
  }

  function sectionRow(si) {
    const { label, drop } = list.secs[si];
    const row = h('div', 'sec', label);
    if (drop) row.dataset.drop = drop;
    return row;
  }

  function buildRow(pos) {
    const k = list.kind[pos];
    const r = list.ref[pos];
    const row = k === K_CH ? channelRow(r, pos) : k === K_FOLDER ? folderRow(r) : sectionRow(r);
    row.style.top = `${list.top[pos]}px`;
    return row;
  }

  /** Prima riga la cui parte inferiore supera `y`. */
  function posAt(y) {
    let lo = 0;
    let hi = list.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list.top[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Allinea le righe nel DOM con la porzione di lista attualmente visibile. */
  function renderRows() {
    list.frame = 0;
    const top = els.list.scrollTop;
    const start = posAt(Math.max(0, top - OVERSCAN_PX));
    // Mai più di una schermata: se un problema di impaginazione allungasse il pannello quanto
    // la lista, verrebbero create tutte le righe (centinaia di migliaia) e la pagina si bloccherebbe.
    const height = Math.min(els.list.clientHeight, innerHeight);
    const end = Math.min(list.n, posAt(top + height + OVERSCAN_PX) + 1);

    for (const [pos, row] of list.rows) {
      if (pos < start || pos >= end) {
        row.remove();
        list.rows.delete(pos);
      }
    }
    const frag = document.createDocumentFragment();
    let missing = false;
    for (let pos = start; pos < end; pos++) {
      if (list.rows.has(pos)) continue;
      // Canale non ancora arrivato da Rust: la riga compare appena c'è.
      if (list.kind[pos] === K_CH && !chans.has(list.ref[pos])) { missing = true; continue; }
      const row = buildRow(pos);
      if (list.animate) {
        row.classList.add('enter');
        row.style.setProperty('--d', `${(pos - start) * 24}ms`);
      }
      list.rows.set(pos, row);
      frag.append(row);
    }
    els.rows.append(frag);
    if (!missing) list.animate = false;
    requestRows(start, end);
    if (chans.size > KEEP_CHANNELS) trimChannels(start - PREFETCH * 2, end + PREFETCH * 2);
  }

  /** Chiede a Rust i canali delle righe tra `start` e `end` (più un margine) che mancano. */
  function requestRows(start, end) {
    const need = [];
    for (let p = Math.max(0, start - PREFETCH); p < Math.min(list.n, end + PREFETCH); p++) {
      if (list.kind[p] !== K_CH) continue;
      const i = list.ref[p];
      if (!chans.has(i) && !asked.has(i)) need.push(i);
    }
    if (!need.length) return;
    const loading = fetchChannels(need).then(() => {
      if (list.loading === loading) list.loading = null;
      scheduleRows();
    }, () => {});
    list.loading = loading;
  }

  /** Disegna subito le righe visibili, aspettando i canali che mancano (apertura di una lista). */
  async function renderNow() {
    renderRows();
    if (list.loading) await list.loading;
    renderRows();
  }

  function scheduleRows() {
    if (!list.frame) list.frame = requestAnimationFrame(renderRows);
  }

  function clearRows() {
    for (const row of list.rows.values()) row.remove();
    list.rows.clear();
  }

  /** Ricostruisce la vista (dopo ricerca, cambio lista o modifiche a cartelle e fissati). */
  function rebuild({ keepScroll = false } = {}) {
    const scroll = els.list.scrollTop;
    // Se il fuoco (telecomando) era su una riga, dopo la ricostruzione torna sulla stessa.
    const focusedRow = document.activeElement?.closest?.('#rows > .ch, #rows > .folder');
    const refocus = focusedRow ? (focusedRow.dataset.i !== undefined ? `[data-i="${focusedRow.dataset.i}"]` : `[data-f="${focusedRow.dataset.f}"]`) : null;
    buildView();
    const total = state.total;
    els.rows.style.height = `${list.top[list.n]}px`;
    els.listEmpty.hidden = list.n > 0 || total === 0;
    els.count.textContent = !total ? ''
      : list.query ? `${fmtInt(list.matches)}/${fmtInt(total)}`
      : fmtInt(total);
    clearRows();
    els.list.scrollTop = keepScroll ? scroll : 0;
    renderRows();
    moveHighlight(true);
    if (refocus) els.rows.querySelector(refocus)?.focus({ preventScroll: true });
  }

  const currentPos = () => (state.current >= 0 && state.current < list.posOf.length ? list.posOf[state.current] : -1);

  function moveHighlight(instant = false) {
    const hl = els.hl;
    const pos = currentPos();
    if (pos < 0) { hl.classList.remove('on'); return; }
    if (instant || !hl.classList.contains('on')) hl.classList.add('instant');
    hl.style.height = `${HEIGHT[K_CH]}px`;
    hl.style.transform = `translateY(${list.top[pos]}px)`;
    hl.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => hl.classList.remove('instant')));
  }

  function scrollToCurrent(instant) {
    const pos = currentPos();
    if (pos < 0) return;
    const y = list.top[pos];
    const rowH = HEIGHT[K_CH];
    const top = els.list.scrollTop;
    const height = els.list.clientHeight;
    let target;
    if (y < top) target = y - rowH;
    else if (y + rowH > top + height) target = y + rowH * 2 - height;
    else return;
    // Salti lunghi senza animazione: scorrere migliaia di righe in "smooth" sarebbe lento.
    const smooth = !instant && !lite && Math.abs(target - top) < 3000;
    els.list.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
  }

  function markActive(instant = false) {
    for (const row of list.rows.values()) {
      if (row.classList.contains('ch')) row.classList.toggle('active', Number(row.dataset.i) === state.current);
    }
    scrollToCurrent(instant);
    moveHighlight(instant);
  }

  /** Canale precedente/successivo nella vista (salta sezioni e cartelle). */
  function step(dir) {
    const { n, kind, ref } = list;
    let p = currentPos();
    for (let k = 0; k < n; k++) {
      p = p < 0 ? (dir > 0 ? 0 : n - 1) : (p + dir + n) % n;
      if (kind[p] === K_CH) return play(ref[p]);
    }
  }

  // ---------- Liste (sorgenti) ----------

  const fmtInt = (n) => n.toLocaleString(lang);
  const fmtMB = (bytes) => `${(bytes / 1048576).toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
  const activeSource = () => state.sources.find((s) => s.id === state.active);

  /** Testo mostrato al posto del selettore liste durante il caricamento. */
  function setStatus(text) {
    for (const el of els.statusTexts) el.textContent = text;
  }

  window.__TAURI__.event.listen('load-progress', ({ payload: p }) => {
    if (!body.classList.contains('busy')) return;
    if (p.phase === 'download') {
      setStatus(p.total
        ? tr('status.downloadOf', { done: fmtMB(p.bytes), total: fmtMB(p.total) })
        : tr('status.download', { done: fmtMB(p.bytes) }));
    } else if (p.phase === 'parse') {
      setStatus(tr('status.parse', { size: fmtMB(p.bytes) }));
    } else if (p.phase === 'ready') {
      setStatus(tr('status.ready', { count: fmtInt(p.count) }));
    }
  });

  function formatUpdated(secs) {
    const d = new Date(secs * 1000);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    const day = d.toDateString() === now.toDateString() ? tr('day.today')
      : d.toDateString() === yesterday.toDateString() ? tr('day.yesterday')
      : tr('day.date', { date: d.toLocaleDateString(lang, { day: 'numeric', month: 'short' }) });
    return tr('updated', { day, time });
  }

  /** Sottotitolo di una lista: il server, oppure il nome del file per le liste da disco. */
  const sourceDetail = (s) => s.file || hostOf(s.url);

  function renderSourceButton() {
    const s = activeSource();
    els.srcName.textContent = s ? s.name : tr('menu.noList');
    els.srcHost.textContent = s ? sourceDetail(s) : '';
    // Per una lista da file "Aggiorna" chiede di scegliere di nuovo il file.
    els.refreshBtn.title = tr(s?.file ? 'sb.refreshFileTitle' : 'sb.refreshTitle');
  }

  async function refreshSources() {
    const r = await invoke('sources');
    state.sources = r.sources;
    state.active = r.active;
    renderSourceButton();
    return r;
  }

  /** Mostra la lista appena aperta in Rust ({ serial, count, updated_at }). */
  async function applyChannels({ serial, count, updated_at: updatedAt }, rawOrg) {
    const playing = state.playing?.stream;
    resetChannels(serial, count);
    state.updatedAt = updatedAt;
    org.data = normalizeOrg(rawOrg);
    // Posizione nella lista dei canali salvati, dell'ultimo visto e di quello in riproduzione.
    const streams = new Set(org.data.pinned);
    for (const f of org.data.folders) for (const s of f.items) streams.add(s);
    for (const s of [playing, store.get('last', null)]) if (typeof s === 'string') streams.add(s);
    const wanted = [...streams];
    const found = wanted.length ? await invoke('find_streams', { serial, streams: wanted }).catch(() => []) : [];
    if (serial !== state.serial) return;
    org.idx = new Map(wanted.map((s, k) => [s, found[k]]));
    state.current = playing && inList(playing) ? org.idx.get(playing) : -1;
    indexOrg();
    els.updatedAt.textContent = formatUpdated(updatedAt);
    body.classList.add('has-source');
    list.animate = !lite;
    rebuild();
    markActive(true);
    await renderNow();
    // Lista riscaricata con una ricerca in corso: i risultati vanno ricalcolati.
    if (els.searchInput.value.trim()) runSearch();
    loadGuide();
  }

  // ---------- Guida dei programmi (dati) ----------
  //
  // Si carica in sottofondo dopo la lista (Rust la scarica al massimo ogni 6 ore): da lì
  // vengono il programma in onda sotto ogni canale, la ricerca per programma e la pagina guida.

  const GUIDE_REFRESH = 3 * 3600e3;

  async function loadGuide() {
    const { serial, active: id } = state;
    if (!serial || !id) return;
    let info = null;
    try { info = await invoke('load_guide', { id, serial }); } catch { /* lista senza guida */ }
    if (serial !== state.serial) return;
    state.guide = info && info.channels ? { serial, at: Date.now(), ...info } : null;
    body.classList.toggle('has-guide', !!state.guide);
    if (state.guide) refreshNow();
  }

  /** Aggiorna i programmi in onda nelle righe (e i risultati di una ricerca per programma). */
  function refreshNow() {
    chans.clear();
    asked.clear();
    rebuild({ keepScroll: true });
    if (list.query) runSearch();
    if (gv.open) refreshGuide();
  }

  // Ogni 5 minuti i programmi in onda cambiano; ogni 3 ore si ricarica la guida.
  setInterval(() => {
    if (!state.guide || document.hidden) return;
    if (Date.now() - state.guide.at > GUIDE_REFRESH) loadGuide();
    else refreshNow();
  }, 5 * 60e3);

  /** Nessuna lista: torna alla schermata di benvenuto. */
  function clearChannels() {
    state.token++;
    teardown();
    setLoading(false);
    resetChannels(0, 0);
    invoke('close_list').catch(() => {});
    state.guide = null;
    body.classList.remove('has-guide');
    closeGuide();
    state.updatedAt = 0;
    state.current = -1;
    state.playing = null;
    org.data = normalizeOrg(null);
    org.idx = new Map();
    indexOrg();
    body.classList.remove('has-source', 'has-channel', 'is-playing', 'switching');
    resetProgram();
    resetSubs();
    rebuild();
  }

  function resumeLast() {
    if (state.current >= 0) return;
    const last = store.get('last', null);
    if (inList(last)) play(org.idx.get(last));
  }

  /** Esegue `task` mostrando la riga di stato; gli errori finiscono in un toast. */
  async function busy(text, task) {
    if (body.classList.contains('busy')) return;
    body.classList.add('busy');
    setStatus(text);
    try {
      await task();
    } catch (err) {
      toast(errText(err), { kind: 'error' });
    } finally {
      body.classList.remove('busy');
    }
  }

  /** Riscarica dal server la lista attiva, mantenendo cartelle e fissati. */
  function downloadActive(rawOrg = org.data) {
    const id = state.active;
    if (!id) return Promise.resolve();
    return busy(tr('status.connecting'), async () => {
      const result = await invoke('load_channels', { id });
      if (state.active !== id) return;
      await applyChannels(result, rawOrg);
      toast(tr('toast.listUpdated', { count: fmtInt(result.count) }), { kind: 'success' });
    });
  }

  /** Apre una lista: dalla copia salvata se c'è, altrimenti la scarica. */
  async function openSource(id, { forceDownload = false } = {}) {
    flushOrg();
    hidePreview();
    els.searchInput.value = '';
    const rawOrg = await invoke('load_org', { id }).catch(() => null);
    let loaded = false;
    if (!forceDownload) {
      await busy(tr('status.opening'), async () => {
        const opened = await invoke('open_list', { id });
        if (opened && state.active === id) {
          await applyChannels(opened, rawOrg);
          loaded = true;
        }
      });
    }
    if (!loaded) await downloadActive(rawOrg);
    resumeLast();
  }

  async function switchSource(id) {
    if (id === state.active) return;
    try {
      await invoke('set_active', { id });
      await refreshSources();
      await openSource(id);
    } catch (err) {
      toast(errText(err), { kind: 'error' });
    }
  }

  async function addSource() {
    const v = await dialog({
      title: tr('dlg.addList'),
      fields: [
        { name: 'name', label: tr('dlg.name'), placeholder: tr('dlg.listNamePh') },
        { name: 'url', label: tr('dlg.url'), type: 'url', placeholder: 'https://…', required: true },
      ],
      confirm: tr('dlg.add'),
    });
    if (v) await createSource(v.name, v.url);
  }

  /**
   * Aggiunge una lista da URL. Rust la salva solo se la scarica e la legge senza errori:
   * con un formato non supportato compare l'errore e l'elenco delle liste resta invariato.
   */
  function createSource(name, url) {
    return busy(tr('status.connecting'), async () => {
      await showAdded(await invoke('add_source', { name, url }));
    });
  }

  /** Mostra la lista appena aggiunta (già letta da Rust, senza scaricarla di nuovo). */
  async function showAdded({ list: added }) {
    flushOrg();
    hidePreview();
    els.searchInput.value = '';
    await refreshSources();
    await applyChannels(added, null);
    if (narrow() || tv) setSidebar(true); // si vedono subito i canali della nuova lista
    toast(tr('toast.listAdded', { count: fmtInt(added.count) }), { kind: 'success' });
  }

  // ---------- Liste da file M3U ----------

  let fileTarget = null; // null = nuova lista, altrimenti id della lista da file da aggiornare

  function pickFile(target = null) {
    fileTarget = target;
    els.fileInput.value = '';
    els.fileInput.click();
  }

  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files[0];
    const target = fileTarget;
    fileTarget = null;
    if (!file) return;
    busy(tr('status.reading'), async () => {
      const content = await file.text();
      if (!target) {
        await showAdded(await invoke('add_source_file', { name: '', fileName: file.name, content }));
        return;
      }
      const opened = await invoke('replace_source_file', { id: target, fileName: file.name, content });
      await refreshSources();
      if (state.active !== target) return;
      await applyChannels(opened, org.data);
      toast(tr('toast.listUpdated', { count: fmtInt(opened.count) }), { kind: 'success' });
    });
  });

  async function editSource(s) {
    // Le liste da file hanno solo il nome: il contenuto si cambia con "Aggiorna".
    const fields = [{ name: 'name', label: tr('dlg.name'), value: s.name }];
    if (!s.file) fields.push({ name: 'url', label: tr('dlg.url'), type: 'url', value: s.url, required: true });
    const v = await dialog({ title: tr('dlg.editList'), fields, confirm: tr('dlg.save') });
    if (!v) return;
    try {
      const updated = await invoke('update_source', { id: s.id, name: v.name, url: v.url ?? '' });
      await refreshSources();
      if (!s.file && s.id === state.active && updated.url !== s.url) await openSource(s.id, { forceDownload: true });
    } catch (err) {
      toast(errText(err), { kind: 'error' });
    }
  }

  async function removeSource(s) {
    const ok = await dialog({
      title: tr('dlg.deleteList', { name: s.name }),
      text: tr('dlg.deleteListText'),
      confirm: tr('dlg.delete'),
      danger: true,
    });
    if (!ok) return;
    const wasActive = s.id === state.active;
    try {
      if (wasActive && org.pending) { clearTimeout(org.pending.timer); org.pending = null; }
      const next = await invoke('remove_source', { id: s.id });
      await refreshSources();
      if (!wasActive) return;
      if (next) await openSource(next);
      else clearChannels();
    } catch (err) {
      toast(errText(err), { kind: 'error' });
    }
  }

  function sourcesMenu() {
    const items = [{ header: tr('menu.lists') }];
    for (const s of state.sources) {
      items.push({
        label: s.name,
        sub: sourceDetail(s),
        check: s.id === state.active,
        action: () => switchSource(s.id),
        extras: [
          { icon: ICONS.edit, title: tr('menu.edit'), action: () => editSource(s) },
          { icon: ICONS.trash, title: tr('menu.delete'), action: () => removeSource(s) },
        ],
      });
    }
    items.push(
      '-',
      { label: tr('menu.addList'), icon: ICONS.plus, action: addSource },
      { label: tr('menu.addFile'), icon: ICONS.file, action: () => pickFile() },
      { label: tr('menu.discover'), icon: ICONS.globe, action: openBrowse },
    );
    openMenu(items, els.srcBtn.getBoundingClientRect(), { minWidth: els.srcBtn.offsetWidth, anchor: els.srcBtn });
  }

  // ---------- Opzioni ----------

  /** Interruttore di un menu: inverte il valore, lo salva e aggiorna la voce. */
  const toggleItem = (key, prop, after) => (btn) => {
    state[prop] = !state[prop];
    store.set(key, state[prop]);
    btn.querySelector('.switch').classList.toggle('on', state[prop]);
    after?.();
  };

  function optionsMenu() {
    const current = langPref === 'auto' ? tr('opt.langAuto') : I18N.names[langPref];
    // L'anteprima al passaggio richiede un mouse: su telefono e TV l'opzione non serve
    // (e la versione legacy non ce l'ha).
    const preview = touch || tv || !els.preview ? [] : [{
      label: tr('opt.preview'), sub: tr('opt.previewSub'), icon: ICONS.eye, toggle: state.previewOn, keepOpen: true,
      action: toggleItem('preview', 'previewOn', () => { if (!state.previewOn) hidePreview(); }),
    }];
    openMenu([
      { header: tr('opt.title') },
      ...preview,
      { label: tr('opt.language'), sub: current, icon: ICONS.globe, action: languageMenu },
      '-',
      { label: tr('opt.proxy'), sub: proxyLabel(), icon: ICONS.shield, toggle: state.proxy.enabled, action: toggleProxy },
      { label: tr('opt.proxySettings'), icon: ICONS.edit, action: proxyDialog },
    ], els.optionsBtn.getBoundingClientRect(), { align: 'end', anchor: els.optionsBtn });
  }

  // ---------- Proxy ----------
  //
  // Con il proxy attivo tutto il traffico dell'app (liste, guida, video, loghi) esce dal
  // server indicato: i siti vedono il suo indirizzo IP invece di quello di casa.

  function proxyLabel() {
    if (!state.proxy.enabled) return tr('opt.proxyOff');
    try { return new URL(state.proxy.url).host; } catch { return state.proxy.url; }
  }

  async function applyProxy(config, test) {
    try {
      await invoke('set_proxy', { proxy: config });
      state.proxy = config;
      nativeProxy();
      // I loghi già a schermo vanno richiesti di nuovo per la nuova strada.
      clearRows();
      renderRows();
      if (state.current >= 0 && nativePlayer) reloadChannel();
      if (!config.enabled) { toast(tr('toast.proxyOff')); return; }
      if (test) {
        toast(tr('toast.proxyTesting'));
        const ip = await invoke('test_proxy');
        toast(tr('toast.proxyOk', { ip }), { kind: 'success' });
      }
    } catch (err) {
      toast(tr('toast.proxyFail', { error: errText(err) }), { kind: 'error' });
    }
  }

  async function proxyDialog() {
    const p = state.proxy;
    const v = await dialog({
      title: tr('dlg.proxy'),
      text: tr('dlg.proxyText'),
      fields: [
        { name: 'url', label: tr('dlg.proxyUrl'), placeholder: 'socks5://192.168.1.10:1080', value: p.url, required: true },
        { name: 'username', label: tr('dlg.proxyUser'), value: p.username },
        { name: 'password', label: tr('dlg.proxyPass'), type: 'password', value: p.password },
      ],
      confirm: tr('dlg.proxySave'),
    });
    if (v) await applyProxy({ enabled: true, url: v.url, username: v.username, password: v.password }, true);
  }

  function toggleProxy() {
    if (!state.proxy.enabled && !state.proxy.url) return proxyDialog();
    return applyProxy({ ...state.proxy, enabled: !state.proxy.enabled }, !state.proxy.enabled);
  }

  /** Il lettore nativo ha una sua connessione: gli si passa lo stesso proxy. */
  function nativeProxy() {
    if (!nativePlayer) return;
    const p = state.proxy;
    let type = '';
    let host = '';
    let port = 0;
    if (p.enabled) {
      try {
        const u = new URL(p.url);
        type = /^socks/.test(u.protocol) ? 'socks' : 'http';
        host = u.hostname;
        port = Number(u.port) || 80;
      } catch { /* indirizzo non valido: Rust l'ha già rifiutato */ }
    }
    nativePlayer.setProxy(type, host, port, p.username || '', p.password || '');
  }

  /** Il lettore nativo non sa parlare con i proxy https://: in quel caso si usa hls.js. */
  const useNative = () => !!nativePlayer && !(state.proxy.enabled && /^https:/i.test(state.proxy.url));

  // ---------- Liste pubbliche ----------
  //
  // Senza liste (e dal menu delle liste) si possono aggiungere liste libere e legali raccolte
  // da volontari: iptv-org (per paese e per categoria) e Free-TV.

  const IPTV_ORG = 'https://iptv-org.github.io/iptv';
  const CATEGORIES = [
    ['news', '📰'], ['sports', '⚽'], ['movies', '🎬'], ['series', '🎞'], ['kids', '🧸'], ['music', '🎵'],
    ['documentary', '🌍'], ['entertainment', '🎭'], ['culture', '🏛'], ['comedy', '😄'], ['religious', '🕊'], ['weather', '⛅'],
  ];
  // Paese predefinito per lingua, se il sistema non indica la regione.
  const LANG_COUNTRY = { it: 'IT', en: 'US', es: 'ES', fr: 'FR', de: 'DE', ro: 'RO', pl: 'PL', ru: 'RU', uk: 'UA', tr: 'TR', zh: 'CN', ja: 'JP', ko: 'KR' };
  let countries = null; // [{ name, code }] dal catalogo iptv-org
  let countriesAsked = false;

  function homeCountry() {
    for (const l of navigator.languages || [navigator.language]) {
      const m = /^[a-z]{2,3}[-_]([a-z]{2})$/i.exec(String(l));
      if (m) return m[1].toUpperCase();
    }
    return LANG_COUNTRY[lang] || 'US';
  }

  /** Nome del paese nella lingua dell'interfaccia (se la WebView lo sa fare), altrimenti in inglese. */
  function countryName(code, fallback) {
    try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) || fallback; } catch { return fallback; }
  }

  function publicCard(badge, label, sub, url, listName) {
    const b = h('button', 'pub-card');
    b.type = 'button';
    b.append(h('span', 'pub-badge', badge));
    const text = h('span', 'pub-text');
    text.append(h('span', 'pub-label', label), h('span', 'pub-sub', sub));
    b.append(text);
    b.addEventListener('click', () => {
      closeBrowse();
      createSource(listName, url);
    });
    return b;
  }

  function publicSection(title, cards, cls = '') {
    const sec = h('section', `pub-sec ${cls}`);
    sec.append(h('h3', null, title));
    const grid = h('div', 'pub-grid');
    grid.append(...cards);
    sec.append(grid);
    return sec;
  }

  function renderPublicLists() {
    const home = homeCountry();
    const homeInfo = countries && countries.find((c) => c.code === home);
    const homeName = countryName(home, homeInfo ? homeInfo.name : home);
    const countryUrl = (code) => `${IPTV_ORG}/countries/${code.toLowerCase()}.m3u`;
    const out = [h('p', 'pub-note', tr('pub.note'))];
    out.push(publicSection(tr('pub.yours'), [
      publicCard(home, homeName, tr('pub.countrySub'), countryUrl(home), `${homeName} · iptv-org`),
    ]));
    out.push(publicSection(tr('pub.categories'), CATEGORIES.map(([id, icon]) => {
      const name = tr(`cat.${id}`);
      return publicCard(icon, name, 'iptv-org', `${IPTV_ORG}/categories/${id}.m3u`, `${name} · iptv-org`);
    })));
    out.push(publicSection(tr('pub.collections'), [
      publicCard('🌐', tr('pub.all'), tr('pub.allSub'), `${IPTV_ORG}/index.m3u`, 'iptv-org'),
      publicCard('📺', 'Free-TV', tr('pub.freetvSub'), 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', 'Free-TV'),
    ]));
    if (countries) {
      const sorted = countries
        .map((c) => ({ code: c.code, name: countryName(c.code, c.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, lang));
      out.push(publicSection(tr('pub.countries'), sorted.map((c) => publicCard(c.code, c.name, 'iptv-org', countryUrl(c.code), `${c.name} · iptv-org`)), 'countries'));
    } else {
      out.push(h('p', 'pub-note', tr('pub.loading')));
    }
    els.publicLists.replaceChildren(...out);
    if (!countriesAsked) {
      countriesAsked = true;
      invoke('public_countries')
        .then((all) => {
          countries = (Array.isArray(all) ? all : []).filter((c) => c && /^[A-Z]{2}$/.test(c.code)).map((c) => ({ code: c.code, name: String(c.name || c.code) }));
          if (publicVisible()) renderPublicLists();
        })
        .catch(() => { countriesAsked = false; });
    }
  }

  const browsing = () => body.classList.contains('browsing');
  const publicVisible = () => browsing() || !body.classList.contains('has-source');

  function openBrowse() {
    rememberFocus();
    body.classList.add('browsing');
    renderPublicLists();
    els.empty.scrollTop = 0;
    if (tv) setTimeout(() => { const first = els.publicLists.querySelector('.pub-card'); if (first) focusItem(first); }, 60);
  }

  function closeBrowse() {
    if (!browsing()) return;
    body.classList.remove('browsing');
    restoreFocus();
  }

  function languageMenu() {
    const items = [
      { header: tr('opt.language') },
      { label: tr('opt.langAuto'), sub: I18N.names[systemLang()], check: langPref === 'auto', action: () => setLanguage('auto') },
      '-',
    ];
    for (const code of LANGS) {
      items.push({ label: I18N.names[code], check: langPref === code, action: () => setLanguage(code) });
    }
    openMenu(items, els.optionsBtn.getBoundingClientRect(), { align: 'end', anchor: els.optionsBtn });
  }

  // ---------- Menu contestuale ----------

  const menu = { open: false, anchor: null };

  /**
   * Apre il menu sotto (o sopra) `rect`. Voci: '-' separatore, { header } titolo,
   * oppure { label, sub, icon, check, toggle, danger, disabled, extras, keepOpen, action }.
   */
  function openMenu(items, rect, { align = 'start', minWidth = 0, anchor = null } = {}) {
    rememberFocus();
    hidePreview();
    menu.anchor?.setAttribute('aria-expanded', 'false');
    const m = els.menu;
    const content = h('div', 'menu-body');
    m.replaceChildren(content);
    for (const it of items) {
      if (it === '-') { content.append(h('div', 'ms')); continue; }
      if (it.header) { content.append(h('div', 'mh', it.header)); continue; }
      const b = h('button', it.danger ? 'mi danger' : 'mi');
      b.classList.toggle('has-sub', !!it.sub);
      b.type = 'button';
      b.disabled = !!it.disabled;
      if (it.check !== undefined) b.insertAdjacentHTML('beforeend', `<span class="check">${it.check ? ICONS.check : ''}</span>`);
      else if (it.icon) b.insertAdjacentHTML('beforeend', it.icon);
      const text = h('span', 'mi-text');
      text.append(h('span', 'mi-label', it.label));
      if (it.sub) text.append(h('span', 'mi-sub', it.sub));
      b.append(text);
      for (const x of it.extras || []) {
        const a = h('span', 'act');
        a.title = x.title;
        a.innerHTML = x.icon;
        a.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); x.action(); });
        b.append(a);
      }
      if (it.toggle !== undefined) b.append(h('span', it.toggle ? 'switch on' : 'switch'));
      b.addEventListener('click', () => {
        if (it.keepOpen) return it.action(b);
        closeMenu();
        it.action?.();
      });
      content.append(b);
    }

    m.style.minWidth = minWidth ? `${minWidth}px` : '';
    m.style.left = '0px';
    m.style.top = '0px';
    const w = m.offsetWidth;
    const hgt = m.offsetHeight;
    let left = align === 'end' ? rect.right - w : rect.left;
    let top = rect.bottom + 6;
    if (top + hgt > innerHeight - 8) top = Math.max(8, rect.top - hgt - 6);
    left = clamp(left, 8, innerWidth - w - 8);
    // Pixel interi: con coordinate frazionarie icone e testi si allineano diversamente a ogni apertura.
    m.style.left = `${Math.round(left)}px`;
    m.style.top = `${Math.round(top)}px`;
    m.classList.remove('open');
    void m.offsetWidth;
    m.classList.add('open');
    menu.open = true;
    menu.anchor = anchor;
    anchor?.setAttribute('aria-expanded', 'true');
    // Telecomando: si parte dalla prima voce del menu.
    if (tv) content.querySelector('.mi:not(:disabled)')?.focus({ preventScroll: true });
  }

  function closeMenu() {
    if (!menu.open) return;
    els.menu.classList.remove('open');
    menu.anchor?.setAttribute('aria-expanded', 'false');
    menu.open = false;
    menu.anchor = null;
    restoreFocus();
  }

  /** Apre il menu legato a `anchor`, o lo chiude se è già aperto. */
  const toggleMenu = (anchor, open) => () => (menu.open && menu.anchor === anchor ? closeMenu() : open());

  document.addEventListener('mousedown', (e) => {
    if (menu.open && !els.menu.contains(e.target) && !menu.anchor?.contains(e.target)) closeMenu();
  });
  window.addEventListener('blur', closeMenu);

  function channelMenu(i, rect) {
    const ch = chans.get(i);
    if (!ch) return;
    const stream = streamAt(i);
    const at = org.where.get(stream);
    const items = [
      { header: ch.name },
      { label: tr(at === PIN ? 'act.unpin' : 'act.pin'), icon: ICONS.pin, action: () => togglePin(stream) },
    ];
    if (at && at !== PIN) items.push({ label: tr('menu.unfile'), icon: ICONS.out, action: () => unfile(stream) });
    items.push('-', { header: tr('menu.moveTo') });
    for (const f of org.data.folders) {
      items.push({ label: f.name, icon: ICONS.folder, disabled: at === f.id, action: () => moveToFolder(stream, f.id) });
    }
    items.push({ label: tr('menu.newFolder'), icon: ICONS.folderPlus, action: () => createFolder(stream) });
    openMenu(items, rect, { align: 'end' });
  }

  function folderMenu(f, rect) {
    const i = org.data.folders.indexOf(f);
    openMenu([
      { header: f.name },
      { label: tr('menu.rename'), icon: ICONS.edit, action: () => renameFolder(f) },
      { label: tr('menu.moveUp'), icon: ICONS.up, disabled: i === 0, action: () => moveFolder(f, -1) },
      { label: tr('menu.moveDown'), icon: ICONS.down, disabled: i === org.data.folders.length - 1, action: () => moveFolder(f, 1) },
      '-',
      { label: tr('menu.deleteFolder'), icon: ICONS.trash, danger: true, action: () => deleteFolder(f) },
    ], rect, { align: 'end' });
  }

  // ---------- Dialogo generico ----------

  let dialogResolve = null;
  const dialogOpen = () => els.dialog.classList.contains('open');

  /**
   * Mostra un dialogo modale. Senza campi restituisce true/null; con i campi
   * restituisce { nome: valore } oppure null se annullato.
   */
  function dialog({ title, text = '', fields = [], confirm = 'OK', cancel = tr('dlg.cancel'), danger = false, icon = false }) {
    if (dialogResolve) closeDialog(null);
    closeMenu();
    hidePreview();
    rememberFocus();
    els.dialogTitle.textContent = title;
    els.dialogText.textContent = text;
    els.dialogIcon.hidden = !icon;
    els.dialogFields.replaceChildren(...fields.map((f) => {
      const label = h('label', null, f.label);
      const wrap = h('span', 'field');
      const input = h('input');
      Object.assign(input, {
        name: f.name, type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '',
        required: !!f.required, spellcheck: false, autocomplete: 'off',
      });
      wrap.append(input);
      label.append(wrap);
      return label;
    }));
    els.dialogCancel.textContent = cancel;
    els.dialogConfirm.textContent = confirm;
    els.dialogConfirm.className = danger ? 'btn danger' : 'btn primary';
    els.dialog.classList.add('open');
    const first = els.dialogFields.querySelector('input');
    requestAnimationFrame(() => {
      (first || els.dialogConfirm).focus();
      first?.select();
    });
    return new Promise((resolve) => { dialogResolve = resolve; });
  }

  function closeDialog(result) {
    els.dialog.classList.remove('open');
    if (els.dialog.contains(document.activeElement)) document.activeElement.blur();
    const resolve = dialogResolve;
    dialogResolve = null;
    resolve?.(result);
    // Dopo l'azione confermata (che può ridisegnare la lista) il fuoco torna al suo posto.
    setTimeout(restoreFocus, 0);
  }

  els.dialogForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const inputs = els.dialogFields.querySelectorAll('input');
    if (!inputs.length) return closeDialog(true);
    const values = {};
    for (const input of inputs) values[input.name] = input.value.trim();
    closeDialog(values);
  });
  els.dialogCancel.addEventListener('click', () => closeDialog(null));
  els.dialogScrim.addEventListener('click', () => closeDialog(null));

  async function confirmQuit() {
    const ok = await dialog({
      title: tr('dlg.quit'), text: tr('dlg.quitText'), confirm: tr('dlg.quitConfirm'), danger: true, icon: true,
    });
    if (ok) {
      flushOrg();
      // Su Android la finestra non si chiude come su desktop: chiude l'app Rust.
      if (mobile) invoke('exit_app');
      else appWindow.close();
    }
  }

  // ---------- Anteprima al passaggio del mouse ----------
  //
  // Dopo 1 s sullo stesso canale parte un secondo lettore, muto e alla qualità più bassa.

  const PREVIEW_DELAY = 1000;
  const pv = { timer: 0, row: null, hls: null, token: 0, shown: false };

  function schedulePreview(row) {
    clearTimeout(pv.timer);
    if (pv.shown) hidePreview();
    pv.row = row;
    if (row) pv.timer = setTimeout(() => showPreview(row), PREVIEW_DELAY);
  }

  function showPreview(row) {
    if (touch || !state.previewOn || menu.open || dialogOpen() || drag || !row.isConnected || !sidebarOpen()) return;
    const i = Number(row.dataset.i);
    const ch = chans.get(i);
    if (i === state.current || !ch) return;
    const token = ++pv.token;
    pv.shown = true;

    const p = els.preview;
    els.pvName.textContent = ch.name;
    els.pvMsg.textContent = '';
    els.pvProg.textContent = '';
    previewProgram(ch, token);
    p.classList.remove('playing', 'failed');
    const r = row.getBoundingClientRect();
    const sb = els.sidebar.getBoundingClientRect();
    const hgt = p.offsetHeight;
    p.style.left = `${sb.right + 12}px`;
    p.style.top = `${clamp(r.top + r.height / 2 - hgt / 2, 12, innerHeight - hgt - 12)}px`;
    p.classList.add('show');
    previewTry([hlsVariant(ch.stream), ch.stream].filter(Boolean), token);
  }

  /** Programma in onda sotto il nome dell'anteprima: dalla guida o dal pannello Xtream. */
  async function previewProgram(ch, token) {
    let title = ch.now?.title;
    if (!title) title = (await invoke('program_info', { stream: ch.stream }).catch(() => null))?.title;
    if (token === pv.token && title) els.pvProg.textContent = title;
  }

  function previewFailed() {
    els.preview.classList.add('failed');
    els.pvMsg.textContent = tr('preview.unavailable');
    stopPreviewMedia();
  }

  function previewTry(urls, token) {
    if (token !== pv.token) return;
    stopPreviewMedia();
    const url = urls.shift();
    if (!url) return previewFailed();
    if (!(window.Hls && Hls.isSupported())) {
      els.pvVideo.src = url;
      els.pvVideo.play().catch(() => {});
      return;
    }
    const hls = new Hls({
      xhrSetup: (xhr, u) => xhr.open('GET', proxify(u), true),
      enableWorker: true,
      liveDurationInfinity: true,
      startLevel: 0,
      capLevelToPlayerSize: true,
      maxBufferLength: 8,
      backBufferLength: 0,
      manifestLoadingMaxRetry: 0,
    });
    pv.hls = hls;
    let parsed = false;
    hls.on(Hls.Events.MANIFEST_PARSED, () => { parsed = true; els.pvVideo.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || token !== pv.token) return;
      if (!parsed) previewTry(urls, token);
      else previewFailed();
    });
    hls.loadSource(url);
    hls.attachMedia(els.pvVideo);
  }

  function stopPreviewMedia() {
    if (pv.hls) {
      pv.hls.destroy();
      pv.hls = null;
    }
    els.pvVideo.removeAttribute('src');
    els.pvVideo.load();
  }

  function hidePreview() {
    clearTimeout(pv.timer);
    if (!pv.shown) return;
    pv.shown = false;
    pv.token++;
    els.preview.classList.remove('show', 'playing', 'failed');
    stopPreviewMedia();
  }

  // Nella versione legacy l'anteprima non c'è proprio (né il suo secondo lettore video).
  if (els.preview && !touch && !tv) {
    els.pvVideo.muted = true;
    els.pvVideo.addEventListener('playing', () => { if (pv.shown) els.preview.classList.add('playing'); });
    els.list.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.ch');
      if (row !== pv.row) schedulePreview(row);
    });
    els.list.addEventListener('mouseleave', () => schedulePreview(null));
  }

  // ---------- Trascinamento (canali nelle cartelle, ordine delle cartelle) ----------

  let drag = null; // { type: 'ch', stream } | { type: 'folder', f }

  function clearDrop() {
    for (const el of els.rows.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
  }

  function dropTarget(e) {
    if (!drag) return null;
    const target = e.target.closest('.folder, .sec[data-drop]');
    if (!target) return null;
    if (drag.type === 'folder') {
      return target.classList.contains('folder') && org.data.folders[target.dataset.f] !== drag.f ? target : null;
    }
    return target;
  }

  els.list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.ch, .folder');
    if (!row) return;
    schedulePreview(null);
    closeMenu();
    drag = row.classList.contains('folder')
      ? { type: 'folder', f: org.data.folders[row.dataset.f] }
      : { type: 'ch', stream: streamAt(row.dataset.i) };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    row.classList.add('dragging');
  });
  els.list.addEventListener('dragend', () => {
    drag = null;
    clearDrop();
    for (const el of els.rows.querySelectorAll('.dragging')) el.classList.remove('dragging');
  });
  els.list.addEventListener('dragover', (e) => {
    const target = dropTarget(e);
    if (!target) { clearDrop(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!target.classList.contains('drop-target')) {
      clearDrop();
      target.classList.add('drop-target');
    }
  });
  els.list.addEventListener('drop', (e) => {
    const target = dropTarget(e);
    clearDrop();
    if (!target) return;
    e.preventDefault();
    const d = drag;
    drag = null;
    if (d.type === 'folder') placeFolder(d.f, org.data.folders[target.dataset.f]);
    else if (target.classList.contains('folder')) moveToFolder(d.stream, org.data.folders[target.dataset.f].id);
    else if (target.dataset.drop === 'pin' && org.where.get(d.stream) !== PIN) togglePin(d.stream);
    else if (target.dataset.drop === 'all') unfile(d.stream);
  });

  // ---------- Riproduzione ----------

  let cardTimer = 0;
  let spinnerTimer = 0;

  function showCard(ch) {
    clearTimeout(cardTimer);
    fillLogo(els.cardLogo, ch);
    els.cardName.textContent = ch.name;
    // Riavvia l'animazione d'ingresso anche se la card era già visibile.
    els.card.classList.remove('show');
    void els.card.offsetWidth;
    els.card.classList.add('show');
  }

  function hideCard(delay = 0) {
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => els.card.classList.remove('show'), delay);
  }

  function setLoading(on) {
    clearTimeout(spinnerTimer);
    if (on) spinnerTimer = setTimeout(() => els.spinner.classList.add('on'), 250);
    else els.spinner.classList.remove('on');
  }

  let playSeq = 0;
  async function play(i) {
    // Di solito il canale è già qui (riga visibile); altrimenti arriva da Rust.
    const seq = ++playSeq;
    const ch = await getChannel(i);
    if (!ch || seq !== playSeq) return;
    const token = ++state.token;

    state.current = i;
    state.playing = ch;
    store.set('last', ch.stream);
    markActive();
    showCard(ch);
    fillLogo(els.nowLogo, ch);
    els.nowName.textContent = ch.name;
    body.classList.add('has-channel', 'switching');
    resetProgram();
    resetSubs();
    loadEpg(ch, token);
    wake();

    // Lascia che il video precedente "affondi" prima di cambiare sorgente
    // (la versione legacy non ha l'animazione: cambia subito).
    if (state.hasPlayed && !lite) await wait(300);
    if (token !== state.token) return;
    startStream(ch.stream, token);
  }

  // ---------- Sottotitoli ----------
  //
  // Tre provenienze, un solo pulsante (visibile solo se il canale ne ha):
  // - tracce WebVTT nella playlist HLS e didascalie CEA-608/708 nel video: le gestisce
  //   hls.js e le mostra la WebView come tracce di testo;
  // - sottotitoli DVB (immagini): li decodifica Rust nel proxy e arrivano con l'evento
  //   "subtitle"; qui vengono collocati sulla timeline del video e disegnati sul canvas.

  const subs = {
    on: store.get('subs', false),
    dvb: null,      // lingua della traccia DVB del canale, se presente
    queue: [],      // display set DVB in arrivo: { pts, timeout, display, image, img }
    shown: null,    // display set attualmente disegnato
    initPTS: null,  // origine dei tempi del lettore ({ base, scale })
    frame: 0,
  };
  const subCtx = els.subCanvas.getContext('2d');

  const textTracks = () => [...video.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
  const hlsSubtitleTracks = () => state.hls?.subtitleTracks ?? [];
  const subsAvailable = () => !!subs.dvb || !!subs.native || hlsSubtitleTracks().length > 0 || textTracks().length > 0;

  function updateSubsButton() {
    body.classList.toggle('has-subs', subsAvailable());
    els.subsBtn.classList.toggle('on', subs.on);
    els.subsBtn.setAttribute('aria-pressed', String(subs.on));
  }

  /** Applica la scelta acceso/spento a tutte le fonti disponibili. */
  function applySubs() {
    // Lettore nativo: i sottotitoli (anche DVB) li disegna ExoPlayer.
    if (nativePlayer) nativePlayer.setSubtitles(subs.on);
    const hls = state.hls;
    const hlsTracks = hlsSubtitleTracks();
    if (hls && hlsTracks.length) {
      // Traccia nella lingua dell'interfaccia, se c'è, altrimenti la prima.
      const preferred = Math.max(0, hlsTracks.findIndex((t) => (t.lang || '').toLowerCase().startsWith(lang)));
      hls.subtitleDisplay = subs.on;
      hls.subtitleTrack = subs.on ? preferred : -1;
    } else {
      // Didascalie nel video (CEA-608/708) o tracce del file: se ne mostra una sola.
      textTracks().forEach((t, i) => { t.mode = subs.on && i === 0 ? 'showing' : 'disabled'; });
    }
    if (!subs.on) paintSubtitle(null);
    updateSubsButton();
    scheduleSubs();
  }

  function toggleSubs() {
    subs.on = !subs.on;
    store.set('subs', subs.on);
    applySubs();
  }

  function resetSubs() {
    cancelAnimationFrame(subs.frame);
    Object.assign(subs, { dvb: null, native: false, queue: [], shown: null, initPTS: null, frame: 0 });
    paintSubtitle(null);
    updateSubsButton();
  }

  /** Rust segnala nella risposta di ogni segmento se il canale ha una traccia DVB. */
  function streamSubtitles(xhr, token) {
    const dvb = xhr.getResponseHeader('x-subtitles');
    if (token !== state.token || !dvb || subs.dvb) return;
    subs.dvb = dvb.replace(/^dvb:/, '') || 'und';
    updateSubsButton();
  }

  window.__TAURI__.event.listen('subtitle', ({ payload: s }) => {
    if (String(s.sid) !== String(state.token)) return;
    const item = { pts: s.pts, timeout: s.timeout, display: s.display, image: s.image, img: null };
    if (s.image) {
      item.img = new Image();
      // A immagine pronta si ridisegna, nel caso fosse già il suo momento.
      item.img.onload = () => { if (subs.shown === item) subs.shown = null; scheduleSubs(); };
      item.img.src = `data:image/png;base64,${s.image.png}`;
    }
    // Un segmento riscaricato può ripetere lo stesso display set: vince l'ultimo.
    subs.queue = subs.queue.filter((q) => q.pts !== item.pts);
    subs.queue.push(item);
    if (subs.queue.length > 300) subs.queue.splice(0, subs.queue.length - 300);
    if (!subs.dvb) {
      subs.dvb = 'und';
      updateSubsButton();
    }
    scheduleSubs();
  });

  /** Tempo del video (secondi) che corrisponde a un PTS a 90 kHz. */
  function subtitleTime(pts) {
    if (!subs.initPTS) return null;
    const WRAP = 2 ** 33; // il PTS ricomincia da zero ogni ~26,5 ore
    let diff = pts - (subs.initPTS.base * 90000) / subs.initPTS.scale;
    if (diff < -WRAP / 2) diff += WRAP;
    else if (diff > WRAP / 2) diff -= WRAP;
    return diff / 90000;
  }

  function scheduleSubs() {
    if (!subs.frame && subs.on && subs.queue.length) subs.frame = requestAnimationFrame(drawSubs);
  }

  function drawSubs() {
    subs.frame = 0;
    if (!subs.on) return;
    const now = video.currentTime;
    // Il display set più recente già iniziato è quello da mostrare (finché non scade).
    let current = null;
    let currentTime = -Infinity;
    for (const item of subs.queue) {
      const t = subtitleTime(item.pts);
      if (t !== null && t <= now + 0.04 && t >= currentTime) {
        current = item;
        currentTime = t;
      }
    }
    const expired = current && current.timeout > 0 && now > currentTime + current.timeout;
    const show = current && current.img && !expired ? current : null;
    if (show !== subs.shown) paintSubtitle(show);
    // Si tengono solo quelli ancora utili.
    subs.queue = subs.queue.filter((q) => q === current || (subtitleTime(q.pts) ?? Infinity) > now - 5);
    scheduleSubs();
  }

  /** Disegna l'immagine del sottotitolo nell'area effettivamente occupata dal video. */
  function paintSubtitle(item) {
    subs.shown = item;
    const canvas = els.subCanvas;
    const dpr = devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    } else {
      subCtx.clearRect(0, 0, w, h);
    }
    if (!item || !item.img?.complete || !video.videoWidth) return;
    // Il video è centrato con "object-fit: contain".
    const scale = Math.min(w / video.videoWidth, h / video.videoHeight);
    const vw = video.videoWidth * scale;
    const vh = video.videoHeight * scale;
    const left = (w - vw) / 2;
    const top = (h - vh) / 2;
    const [dw, dh] = item.display;
    const { x, y, width, height } = item.image;
    const dx = left + (x * vw) / dw;
    let dy = top + (y * vh) / dh;
    const dHeight = (height * vh) / dh;
    // Con il widget dei controlli visibile, il sottotitolo sale quanto basta per non finirci sotto.
    if (!body.classList.contains('idle') && body.classList.contains('has-channel')) {
      const limit = (els.controls.getBoundingClientRect().top - canvas.getBoundingClientRect().top - 12) * dpr;
      if (dy + dHeight > limit) dy = Math.max(0, limit - dHeight);
    }
    subCtx.imageSmoothingQuality = 'high';
    subCtx.drawImage(item.img, dx, dy, (width * vw) / dw, dHeight);
  }

  // Quando i controlli compaiono o si nascondono, il sottotitolo va riposizionato.
  new MutationObserver(() => { if (subs.shown) paintSubtitle(subs.shown); })
    .observe(body, { attributes: true, attributeFilter: ['class'] });

  els.subsBtn.addEventListener('click', () => { toggleSubs(); wake(); });
  video.textTracks.addEventListener('addtrack', () => applySubs());
  video.textTracks.addEventListener('removetrack', () => updateSubsButton());

  // ---------- Programma in onda ----------
  //
  // Due fonti: lo stream stesso (tabella EIT letta dal proxy Rust e restituita
  // nell'intestazione "x-program" dei segmenti) e la guida del pannello Xtream.
  // Se ci sono entrambe vince lo stream; gli orari vengono dalla guida.

  const program = { stream: null, epg: null, timer: 0 };

  function resetProgram() {
    clearTimeout(program.timer);
    program.stream = null;
    program.epg = null;
    renderProgram();
  }

  function renderProgram() {
    const { stream, epg } = program;
    let text = stream || epg?.title || '';
    // Gli orari della guida solo se si riferiscono allo stesso programma.
    if (epg?.start && epg?.end && (!stream || stream.toLowerCase() === epg.title.toLowerCase())) {
      const time = (s) => new Date(s * 1000).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
      text += ` · ${time(epg.start)}–${time(epg.end)}`;
    }
    if (els.nowProgram.textContent !== text) els.nowProgram.textContent = text;
  }

  function streamProgram(xhr, token) {
    if (token !== state.token) return;
    const raw = xhr.getResponseHeader('x-program');
    if (!raw) return;
    let title;
    try { title = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { return; }
    if (title !== program.stream) {
      program.stream = title;
      renderProgram();
    }
  }

  async function loadEpg(ch, token) {
    clearTimeout(program.timer);
    const info = await invoke('program_info', { stream: ch.stream }).catch(() => null);
    if (token !== state.token) return;
    program.epg = info;
    renderProgram();
    // Finito il programma, chiede alla guida il successivo.
    if (info?.end) {
      const ms = info.end * 1000 - Date.now() + 5000;
      if (ms > 0 && ms < 6 * 3600e3) program.timer = setTimeout(() => loadEpg(ch, token), ms);
    }
  }

  /** Riapre da capo lo stream del canale attuale. */
  function reloadChannel() {
    if (state.current < 0) return;
    hideToast();
    play(state.current);
  }

  function teardown() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    video.removeAttribute('src');
    video.load();
    if (nativePlayer) {
      nativePlayer.stop();
      document.documentElement.classList.remove('native-video');
    }
  }

  /**
   * I pannelli Xtream Codes (liste get.php?username=…&password=…) danno flussi MPEG-TS
   * ("/user/pass/123" o "/live/user/pass/123.ts"), che la WebView non riproduce: lo stesso
   * canale è però disponibile in HLS su "/live/user/pass/123.m3u8".
   */
  function hlsVariant(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length === 4 && parts[0] === 'live' && /^\d+\.ts$/i.test(parts[3])) {
        parts[3] = parts[3].replace(/\.ts$/i, '.m3u8');
      } else if (parts.length === 3 && /^\d+(\.ts)?$/i.test(parts[2])) {
        parts.unshift('live');
        parts[3] = `${parts[3].replace(/\.ts$/i, '')}.m3u8`;
      } else {
        return null;
      }
      u.pathname = `/${parts.join('/')}`;
      return u.toString();
    } catch {
      return null;
    }
  }

  function startStream(url, token) {
    if (useNative()) return playViaNative(url, token);
    const alt = hlsVariant(url);
    const original = () => playHls(url, token, () => playNative(url, token));
    if (alt) playHls(alt, token, original);
    else original();
  }

  // Memoria del lettore. hls.js di serie tiene fino a 60 MB e 10 minuti di video in avanti;
  // qui il buffer resta più corto, e nella versione legacy (box da 2 GB) ancora di più, con
  // la qualità limitata alla dimensione del video sullo schermo.
  const HLS_BUFFER = lite
    ? { maxBufferLength: 20, maxMaxBufferLength: 30, maxBufferSize: 25e6, backBufferLength: 10, capLevelToPlayerSize: true }
    : { maxMaxBufferLength: 120, backBufferLength: 30 };

  /** Prova a riprodurre `url` con hls.js; se non è una playlist valida chiama `fallback`. */
  function playHls(url, token, fallback) {
    if (token !== state.token) return;
    teardown();
    setLoading(true);

    if (!(window.Hls && Hls.isSupported())) return fallback();

    const hls = new Hls({
      xhrSetup: (xhr, u) => {
        // "sid" identifica la sessione del lettore principale: Rust ci lega i sottotitoli DVB.
        xhr.open('GET', `${proxify(u)}&sid=${token}`, true);
        xhr.addEventListener('load', () => {
          streamProgram(xhr, token);
          streamSubtitles(xhr, token);
        });
      },
      enableWorker: true,
      liveDurationInfinity: true,
      manifestLoadingMaxRetry: 1,
      subtitleDisplay: subs.on,
      ...HLS_BUFFER,
    });
    state.hls = hls;
    let recovered = false;
    let parsed = false;

    hls.on(Hls.Events.MANIFEST_PARSED, () => { parsed = true; tryPlay(); });
    // Origine dei tempi del lettore: serve a collocare i sottotitoli DVB sulla timeline.
    hls.on(Hls.Events.INIT_PTS_FOUND, (_, data) => {
      if (token !== state.token) return;
      const base = typeof data.initPTS === 'object' ? data.initPTS.baseTime : data.initPTS;
      const scale = (typeof data.initPTS === 'object' ? data.initPTS.timescale : data.timescale) || 90000;
      subs.initPTS = { base, scale };
    });
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { if (token === state.token) applySubs(); });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (token !== state.token || !data.fatal) return;
      // Playlist assente o non HLS: si passa all'alternativa successiva.
      if (!parsed) return fallback();
      if (!recovered && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        recovered = true;
        return hls.recoverMediaError();
      }
      if (!recovered && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        recovered = true;
        return hls.startLoad();
      }
      fail(token);
    });

    hls.loadSource(url);
    hls.attachMedia(video);
  }

  // ---------- Lettore nativo (versione legacy su Android) ----------
  //
  // ExoPlayer legge direttamente il flusso originale (per Xtream l'MPEG-TS, il più leggero);
  // se non va prova la variante HLS. Gli eventi tornano qui con window.__nativePlayer.

  let nativeNext = null;

  function playViaNative(url, token) {
    if (token !== state.token) return;
    teardown();
    setLoading(true);
    // La pagina diventa trasparente dove non c'è interfaccia: sotto c'è il video.
    document.documentElement.classList.add('native-video');
    const tries = [url, hlsVariant(url)].filter(Boolean);
    nativeNext = () => {
      const next = tries.shift();
      if (!next) return fail(token);
      nativePlayer.play(next, token);
    };
    nativeNext();
    applyVolume();
    nativePlayer.setSubtitles(subs.on);
    nativeRect();
  }

  window.__nativePlayer = (token, event, data) => {
    if (token !== state.token) return;
    if (event === 'playing') onPlaying();
    else if (event === 'waiting') setLoading(true);
    else if (event === 'error' || event === 'ended') nativeNext?.();
    else if (event === 'subtitles') {
      subs.native = !!data.available;
      updateSubsButton();
    }
  };

  /** Il video nativo segue il riquadro del video nella pagina (tutto schermo o miniatura della guida). */
  function nativeRect() {
    if (!nativePlayer) return;
    const set = () => {
      if (!body.classList.contains('guide-open')) return nativePlayer.setRect(0, 0, 0, 0);
      const r = els.videoWrap.getBoundingClientRect();
      const d = devicePixelRatio || 1;
      nativePlayer.setRect(Math.round(r.left * d), Math.round(r.top * d), Math.round(r.width * d), Math.round(r.height * d));
    };
    set();
    // Di nuovo a transizione finita.
    setTimeout(set, 450);
  }

  function playNative(url, token) {
    if (token !== state.token) return;
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    video.dataset.native = token;
    video.src = url;
    tryPlay();
  }

  function tryPlay() {
    applyVolume();
    video.play().catch((err) => {
      // Se la riproduzione con audio viene bloccata, si parte in muto.
      if (err.name === 'NotAllowedError') {
        state.muted = true;
        applyVolume();
        video.play().catch(() => {});
      }
    });
  }

  function fail(token) {
    if (token !== state.token) return;
    setLoading(false);
    hideCard();
    body.classList.remove('switching', 'is-playing');
    toast(tr('toast.playFail'), { kind: 'error', action: { label: tr('toast.retry'), icon: ICONS.reload, fn: reloadChannel } });
  }

  video.addEventListener('playing', () => onPlaying());

  function onPlaying() {
    setLoading(false);
    state.hasPlayed = true;
    body.classList.add('is-playing');
    body.classList.remove('switching');
    hideCard(1400);
    // Un eventuale "Riprova" rimasto a schermo non serve più.
    if (els.toast.classList.contains('has-action')) hideToast();
    wake();
  }
  video.addEventListener('waiting', () => setLoading(true));
  video.addEventListener('pause', () => body.classList.remove('is-playing'));
  video.addEventListener('error', () => {
    if (video.dataset.native && Number(video.dataset.native) === state.token && video.getAttribute('src')) {
      fail(state.token);
    }
  });

  // ---------- Volume ----------

  function applyVolume() {
    video.volume = state.volume;
    video.muted = state.muted || state.volume === 0;
    const silent = video.muted;
    if (nativePlayer) nativePlayer.setVolume(silent ? 0 : state.volume);
    els.volume.value = Math.round(state.volume * 100);
    els.volume.style.setProperty('--v', `${state.volume * 100}%`);
    body.classList.toggle('muted', silent);
    els.muteBtn.innerHTML = silent ? ICONS.mute
      : state.volume < 0.05 ? ICONS.vol0
      : state.volume < 0.5 ? ICONS.vol1
      : ICONS.vol2;
    store.set('volume', state.volume);
    store.set('muted', state.muted);
  }

  function setVolume(v) {
    state.volume = clamp(v, 0, 1);
    if (state.volume > 0) state.muted = false;
    applyVolume();
  }

  function toggleMute() {
    if (state.volume === 0) {
      state.volume = 0.5;
      state.muted = false;
    } else {
      state.muted = !state.muted;
    }
    applyVolume();
  }

  els.volume.addEventListener('input', () => setVolume(els.volume.value / 100));
  // Restituisce le scorciatoie da tastiera al resto dell'app dopo il trascinamento.
  els.volume.addEventListener('change', () => els.volume.blur());
  els.muteBtn.addEventListener('click', toggleMute);
  els.stage.addEventListener('wheel', (e) => {
    if (!body.classList.contains('has-channel')) return;
    setVolume(state.volume - Math.sign(e.deltaY) * 0.05);
    wake();
  }, { passive: true });

  // ---------- Sidebar, schermo intero, finestra ----------

  function setSidebar(open) {
    body.classList.toggle('sb-closed', !open);
    store.set('sidebar', open);
    if (!open) {
      hidePreview();
      closeMenu();
    }
  }
  const sidebarOpen = () => !body.classList.contains('sb-closed');

  let sidebarBeforeFs = true;
  async function toggleFullscreen() {
    if (mobile) return; // sul telefono l'app occupa già tutto lo schermo
    const fs = !(await appWindow.isFullscreen());
    if (fs) sidebarBeforeFs = sidebarOpen();
    await appWindow.setFullscreen(fs);
    body.classList.toggle('fs', fs);
    if (fs) {
      body.classList.add('sb-closed');
      hidePreview();
    } else {
      setSidebar(sidebarBeforeFs);
    }
  }

  els.sbToggle.addEventListener('click', () => setSidebar(!sidebarOpen()));
  els.fsBtn.addEventListener('click', toggleFullscreen);
  video.addEventListener('dblclick', toggleFullscreen);
  // Un clic sul video chiude il pannello canali, se aperto.
  video.addEventListener('click', () => {
    if (body.classList.contains('guide-open')) return;
    if (sidebarOpen() && body.classList.contains('has-channel')) setSidebar(false);
  });
  $('winMin').addEventListener('click', () => appWindow.minimize());
  $('winMax').addEventListener('click', () => appWindow.toggleMaximize());
  $('winClose').addEventListener('click', () => { flushOrg(); appWindow.close(); });

  // ---------- Inattività: nasconde controlli e cursore ----------

  let idleTimer = 0;
  let overUi = false;
  function wake() {
    body.classList.remove('idle');
    clearTimeout(idleTimer);
    // Con il mouse fermo sul video si nascondono controlli e pannello canali
    // (non mentre si scrive nella ricerca o c'è un menu/dialogo aperto).
    idleTimer = setTimeout(() => {
      const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type !== 'range';
      if (body.classList.contains('is-playing') && !overUi && !menu.open && !dialogOpen() && !typing) {
        body.classList.add('idle');
        hidePreview();
      }
    }, 2800);
  }
  document.addEventListener('mousemove', wake);
  // Sugli schermi touch un tocco qualsiasi fa ricomparire i controlli.
  document.addEventListener('touchstart', wake, { passive: true });
  for (const el of [els.controls, els.sidebar]) {
    el.addEventListener('mouseenter', () => { overUi = true; });
    el.addEventListener('mouseleave', () => { overUi = false; wake(); });
  }

  // ---------- Toast ----------

  let toastTimer = 0;
  let toastFn = null;

  /**
   * kind: 'info', 'success' o 'error' (gli errori restano a schermo più a lungo).
   * action: { label, icon, fn } aggiunge un pulsante e tiene il toast più a lungo.
   */
  function toast(text, { kind = 'info', action = null } = {}) {
    clearTimeout(toastTimer);
    els.toastText.textContent = text;
    els.toast.classList.toggle('success', kind === 'success');
    els.toast.classList.toggle('error', kind === 'error');
    els.toast.classList.toggle('has-action', !!action);
    toastFn = action?.fn ?? null;
    if (action) {
      els.toastAction.innerHTML = action.icon || '';
      els.toastAction.append(h('span', null, action.label));
    }
    els.toast.classList.add('show');
    toastTimer = setTimeout(hideToast, action ? 10000 : kind === 'error' ? 4500 : 2600);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    els.toast.classList.remove('show');
    toastFn = null;
  }

  els.toastAction.addEventListener('click', () => {
    const fn = toastFn;
    hideToast();
    fn?.();
  });

  // ---------- Eventi ----------

  els.list.addEventListener('click', (e) => {
    const row = e.target.closest('.ch, .folder');
    if (!row) return;
    const act = e.target.closest('[data-act]');
    if (row.classList.contains('folder')) {
      const f = org.data.folders[row.dataset.f];
      if (act) folderMenu(f, act.getBoundingClientRect());
      else toggleFolder(f);
      return;
    }
    const i = Number(row.dataset.i);
    if (act?.dataset.act === 'pin') return togglePin(streamAt(i));
    // Ricarica: riapre da capo lo stream (sul canale attivo come su uno nuovo).
    if (act?.dataset.act === 'reload') {
      schedulePreview(null);
      return i === state.current ? reloadChannel() : play(i);
    }
    if (act?.dataset.act === 'more') return channelMenu(i, act.getBoundingClientRect());
    schedulePreview(null);
    play(i);
    // Sulla TV si chiude il pannello per vedere subito il canale.
    if (tv) setSidebar(false);
  });
  els.list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.ch, .folder');
    if (!row) return;
    e.preventDefault();
    const at = { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY };
    if (row.classList.contains('folder')) folderMenu(org.data.folders[row.dataset.f], at);
    else channelMenu(Number(row.dataset.i), at);
  });
  // Niente menu di sistema della WebView, tranne nei campi di testo.
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  });
  els.list.addEventListener('scroll', () => {
    scheduleRows();
    schedulePreview(null);
    closeMenu();
    els.topBtn.classList.toggle('show', els.list.scrollTop > 600);
  }, { passive: true });

  // "Torna su" e, sulla TV, pagina su/giù: con il telecomando scorrere 300.000 canali una
  // riga alla volta non è pensabile.
  function scrollList(y) {
    els.list.scrollTo({ top: Math.max(0, y), behavior: lite ? 'auto' : 'smooth' });
  }
  els.topBtn.addEventListener('click', () => scrollList(0));
  els.pageUp.addEventListener('click', () => scrollList(els.list.scrollTop - (els.list.clientHeight - 60)));
  els.pageDown.addEventListener('click', () => scrollList(els.list.scrollTop + (els.list.clientHeight - 60)));

  /** Telecomando su/giù su una riga della lista: la riga successiva, anche se non è ancora a schermo. */
  function stepRow(row, d) {
    let pos = posAt(parseFloat(row.style.top) + 1) + d;
    while (pos >= 0 && pos < list.n && list.kind[pos] === K_SEC) pos += d;
    if (pos < 0 || pos >= list.n) return false; // ai bordi decide la geometria (es. la ricerca)
    focusRow(pos);
    return true;
  }

  async function focusRow(pos) {
    const box = els.list;
    const y = list.top[pos];
    const hgt = list.top[pos + 1] - y;
    if (y < box.scrollTop + 8) box.scrollTop = Math.max(0, y - 8);
    else if (y + hgt > box.scrollTop + box.clientHeight - 16) box.scrollTop = y + hgt - box.clientHeight + 16;
    renderRows();
    if (!list.rows.has(pos) && list.loading) {
      await list.loading;
      renderRows();
    }
    const row = list.rows.get(pos);
    if (row) row.focus({ preventScroll: true });
  }

  // Ricerca: la fa Rust sulla lista aperta e restituisce le posizioni dei canali trovati.
  let filterTimer = 0;
  let searchSeq = 0;
  async function runSearch() {
    const q = els.searchInput.value.trim().toLowerCase();
    const seq = ++searchSeq;
    if (!q || !state.serial) {
      list.hits = null;
      list.query = '';
      rebuild();
      return;
    }
    try {
      const buf = await invoke('search', { serial: state.serial, query: q });
      if (seq !== searchSeq) return; // nel frattempo si è scritto altro
      list.hits = new Uint32Array(buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer);
      list.query = q;
      rebuild();
    } catch { /* lista cambiata: applyChannels rifà la ricerca */ }
  }
  els.searchInput.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(runSearch, state.total > 5000 ? 180 : 0);
  });
  els.srcBtn.addEventListener('click', toggleMenu(els.srcBtn, sourcesMenu));
  els.optionsBtn.addEventListener('click', toggleMenu(els.optionsBtn, optionsMenu));
  els.emptyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    createSource('', els.emptyInput.value);
  });
  els.refreshBtn.addEventListener('click', () => (activeSource()?.file ? pickFile(state.active) : downloadActive()));
  els.emptyFile.addEventListener('click', () => pickFile());
  els.browseClose.addEventListener('click', closeBrowse);
  els.guideBtn.addEventListener('click', openGuide);
  els.gClose.addEventListener('click', closeGuide);
  // La miniatura del video nella guida riporta al video a tutto schermo.
  els.videoWrap.addEventListener('click', () => { if (body.classList.contains('guide-open')) closeGuide(); });

  // ---------- Guida dei programmi (pagina) ----------
  //
  // Canali in righe, ore in colonne, una linea per "adesso"; il video continua in un angolo.
  // Le righe sono virtuali come la lista: esistono solo quelle vicine alla parte visibile.

  // Da 12 ore fa a 48 ore avanti (la finestra tenuta da Rust, epg.rs). PX = pixel per minuto.
  const G = { ROW: 64, NAME: 230, PX: 4, BEFORE: 12, HOURS: 60, RULER: 34, STEP: 3 };
  const gv = { open: false, ids: [], t0: 0, rows: new Map(), progs: new Map(), asked: new Set(), frame: 0, clock: 0 };

  async function openGuide() {
    if (!state.guide) return;
    closeMenu();
    hidePreview();
    rememberFocus();
    gv.open = true;
    body.classList.add('guide-open');
    els.guide.setAttribute('aria-hidden', 'false');
    nativeRect();
    if (Date.now() - state.guide.at > GUIDE_REFRESH) loadGuide();
    await refreshGuide(true);
    if (tv) setTimeout(() => {
      const first = els.gCanvas.querySelector('.g-prog.now') || els.gClose;
      focusItem(first);
    }, 120);
  }

  function closeGuide() {
    if (!gv.open) return;
    gv.open = false;
    clearInterval(gv.clock);
    body.classList.remove('guide-open');
    els.guide.setAttribute('aria-hidden', 'true');
    nativeRect();
    restoreFocus();
  }

  /** (Ri)carica i canali della guida: prima fissati e cartelle, poi gli altri in ordine di lista. */
  async function refreshGuide(scrollToNow = false) {
    const serial = state.serial;
    const buf = await invoke('guide_channels', { serial }).catch(() => null);
    if (!buf || serial !== state.serial || !gv.open) return;
    const all = new Uint32Array(buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer);
    const has = new Set(all);
    const first = [];
    const seen = new Set();
    const saved = org.data.pinned.concat(...org.data.folders.map((f) => f.items));
    for (const s of saved) {
      const i = org.idx.get(s);
      if (i >= 0 && has.has(i) && !seen.has(i)) { seen.add(i); first.push(i); }
    }
    gv.ids = first.concat([...all].filter((i) => !seen.has(i)));
    const now = Date.now() / 1000;
    gv.t0 = Math.floor(now / 1800) * 1800 - G.BEFORE * 3600;
    gv.progs.clear();
    gv.asked.clear();
    for (const row of gv.rows.values()) row.remove();
    gv.rows.clear();
    els.gEmpty.hidden = gv.ids.length > 0;
    els.gEmpty.textContent = tr('guide.empty');
    els.gCanvas.style.width = `${G.NAME + G.HOURS * 60 * G.PX}px`;
    els.gCanvas.style.height = `${G.RULER + gv.ids.length * G.ROW}px`;
    renderRuler();
    tickGuide();
    clearInterval(gv.clock);
    gv.clock = setInterval(tickGuide, 30e3);
    if (scrollToNow) {
      els.gBody.scrollTop = 0;
      scrollGuideTo(now - 1800, false);
    }
    renderGuide();
  }

  const gx = (t) => G.NAME + ((t - gv.t0) / 60) * G.PX;
  const hhmm = (t) => new Date(t * 1000).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });

  const dayName = (t) => new Date(t * 1000).toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' });

  function renderRuler() {
    const marks = [];
    for (let k = 0; k < G.HOURS * 2; k++) {
      const t = gv.t0 + k * 1800;
      const d = new Date(t * 1000);
      // A mezzanotte anche il giorno, per capire dove si è nel tempo.
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      const m = h('span', midnight ? 'g-mark day' : 'g-mark', midnight ? `${dayName(t)} · ${hhmm(t)}` : hhmm(t));
      m.style.left = `${gx(t)}px`;
      marks.push(m);
    }
    els.gRuler.replaceChildren(...marks);
  }

  /** Ora attuale: orologio, linea "adesso" e programmi che passano da "in onda" a "finiti". */
  function tickGuide() {
    const now = Date.now() / 1000;
    els.gClock.textContent = hhmm(now);
    renderGuideFoot();
    els.gNow.style.left = `${gx(now)}px`;
    els.gNow.style.height = `${G.RULER + gv.ids.length * G.ROW}px`;
    for (const b of els.gCanvas.querySelectorAll('.g-prog')) {
      const s = Number(b.dataset.start);
      const e = Number(b.dataset.end);
      b.classList.toggle('now', s <= now && now < e);
      b.classList.toggle('past', e <= now);
    }
  }

  /** Riquadro "in onda" accanto alla miniatura del lettore nativo. */
  function renderGuideFoot() {
    const ch = state.playing;
    if (!ch) return;
    if (els.gFootName.textContent !== ch.name) fillLogo(els.gFootLogo, ch);
    els.gFootName.textContent = ch.name;
    els.gFootProg.textContent = els.nowProgram.textContent;
  }

  function scheduleGuide() {
    if (!gv.frame) gv.frame = requestAnimationFrame(renderGuide);
  }

  /** Ora mostrata al bordo sinistro della griglia (dopo la colonna dei canali). */
  const guideLeftTime = () => gv.t0 + (els.gBody.scrollLeft / G.PX) * 60;

  /** Sposta la griglia in modo che `t` sia vicino al bordo sinistro. */
  function scrollGuideTo(t, smooth = true) {
    els.gBody.scrollTo({ left: Math.max(0, ((t - gv.t0) / 60) * G.PX - 90), behavior: smooth && !lite ? 'smooth' : 'auto' });
  }

  els.gPrev.addEventListener('click', () => scrollGuideTo(guideLeftTime() + 1350 - G.STEP * 3600));
  els.gNext.addEventListener('click', () => scrollGuideTo(guideLeftTime() + 1350 + G.STEP * 3600));
  els.gNowBtn.addEventListener('click', () => scrollGuideTo(Date.now() / 1000 - 1800));

  function renderGuide() {
    gv.frame = 0;
    if (!gv.open) return;
    els.gDay.textContent = dayName(guideLeftTime() + 3600);
    const top = els.gBody.scrollTop;
    const hgt = els.gBody.clientHeight || innerHeight;
    const start = Math.max(0, Math.floor((top - G.RULER) / G.ROW) - 4);
    const end = Math.min(gv.ids.length, Math.ceil((top + hgt) / G.ROW) + 4);
    for (const [p, row] of gv.rows) {
      if (p < start || p >= end) { row.remove(); gv.rows.delete(p); }
    }
    const need = [];
    const frag = document.createDocumentFragment();
    for (let p = start; p < end; p++) {
      if (gv.rows.has(p)) continue;
      const i = gv.ids[p];
      if (!chans.has(i) || !gv.progs.has(i)) {
        if (!gv.asked.has(i)) need.push(i);
        continue;
      }
      const row = guideRow(p, i);
      gv.rows.set(p, row);
      frag.append(row);
    }
    els.gCanvas.append(frag);
    if (need.length) fetchGuideRows(need);
  }

  async function fetchGuideRows(indices) {
    const serial = state.serial;
    for (const i of indices) gv.asked.add(i);
    const from = gv.t0;
    const to = gv.t0 + G.HOURS * 3600;
    try {
      const missing = indices.filter((i) => !chans.has(i));
      const [progs] = await Promise.all([
        invoke('guide_programmes', { serial, indices, from, to }),
        missing.length ? fetchChannels(missing) : null,
      ]);
      if (serial !== state.serial || from !== gv.t0) return;
      indices.forEach((i, k) => gv.progs.set(i, progs[k] || []));
      scheduleGuide();
    } catch { /* lista o guida cambiate */ } finally {
      for (const i of indices) gv.asked.delete(i);
    }
  }

  function guideRow(p, i) {
    const ch = chans.get(i);
    const row = h('div', 'g-row');
    row.style.top = `${G.RULER + p * G.ROW}px`;
    const name = h('div', 'g-name');
    const logo = h('div', 'logo');
    fillLogo(logo, ch);
    name.append(logo, h('span', null, ch.name));
    name.classList.toggle('active', i === state.current);
    row.append(name);
    const now = Date.now() / 1000;
    const limit = gv.t0 + G.HOURS * 3600;
    for (const pr of gv.progs.get(i)) {
      const s = Math.max(pr.start, gv.t0);
      const e = Math.min(pr.end, limit);
      const b = h('button', 'g-prog');
      b.type = 'button';
      b.style.left = `${gx(s)}px`;
      const width = Math.max(12, ((e - s) / 60) * G.PX - 4);
      b.style.width = `${width}px`;
      // Programmi di pochi minuti: solo il blocco, il titolo è nel suggerimento.
      if (width < 44) b.classList.add('tiny');
      b.dataset.i = i;
      b.dataset.start = pr.start;
      b.dataset.end = pr.end;
      b.classList.toggle('now', pr.start <= now && now < pr.end);
      b.classList.toggle('past', pr.end <= now);
      b.append(h('span', 'g-title', pr.title), h('span', 'g-time', `${hhmm(pr.start)}–${hhmm(pr.end)}`));
      b.title = pr.title;
      row.append(b);
    }
    return row;
  }

  els.gBody.addEventListener('scroll', scheduleGuide, { passive: true });
  els.gCanvas.addEventListener('click', (e) => {
    const b = e.target.closest('.g-prog');
    if (!b) return;
    const i = Number(b.dataset.i);
    const pr = (gv.progs.get(i) || []).find((x) => String(x.start) === b.dataset.start);
    if (!pr) return;
    const now = Date.now() / 1000;
    // In onda: si guarda subito (il video resta nella miniatura); altrimenti i dettagli.
    if (pr.start <= now && now < pr.end) {
      play(i).then(renderGuideFoot);
      for (const n of els.gCanvas.querySelectorAll('.g-name')) n.classList.remove('active');
      b.parentElement.querySelector('.g-name').classList.add('active');
      return;
    }
    const ch = chans.get(i);
    dialog({
      title: pr.title,
      text: `${hhmm(pr.start)}–${hhmm(pr.end)} · ${ch ? ch.name : ''}${pr.desc ? `\n\n${pr.desc}` : ''}`,
      confirm: tr('guide.watch'),
      cancel: tr('guide.close'),
    }).then((ok) => { if (ok) play(i); });
  });

  // ---------- Indietro e telecomando (Android, Android TV) ----------

  /** Un passo indietro: menu → dialogo → anteprima → campo → pannello → schermo intero → uscita. */
  function goBack() {
    if (menu.open) closeMenu();
    else if (dialogOpen()) closeDialog(null);
    else if (gv.open) closeGuide();
    else if (browsing()) closeBrowse();
    else if (pv.shown) schedulePreview(null);
    else if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    else if (sidebarOpen()) setSidebar(false);
    else if (body.classList.contains('fs')) toggleFullscreen();
    else confirmQuit();
  }

  // Su Android il tasto Indietro fa tornare indietro la WebView nella cronologia (e, senza
  // cronologia, chiude l'app): teniamo sempre una voce in più e la usiamo per goBack().
  if (mobile) {
    history.pushState({ glassplay: true }, '');
    window.addEventListener('popstate', () => {
      history.pushState({ glassplay: true }, '');
      goBack();
    });
  }

  // Navigazione con il telecomando: le frecce spostano il fuoco sull'elemento più vicino
  // in quella direzione, tra quelli visibili nell'area attiva (dialogo, menu o pannello).
  const NAV_ITEMS = 'button:not([disabled]), input:not([type=hidden]), .ch, .folder';

  function navAreas() {
    if (dialogOpen()) return [els.dialogForm];
    if (menu.open) return [els.menu];
    if (gv.open) return [els.guide];
    if (browsing()) return [els.empty];
    // Senza liste c'è la scheda di benvenuto (campo URL, file M3U): senza di lei, OK nel campo
    // spostava il fuoco nel pannello invece di aggiungere la lista.
    const welcome = !body.classList.contains('has-source');
    if (sidebarOpen()) {
      if (body.classList.contains('has-channel')) return [els.sidebar, els.sbToggle, els.controls];
      return welcome ? [els.sidebar, els.sbToggle, els.empty] : [els.sidebar, els.sbToggle];
    }
    return welcome ? [els.empty, els.sbToggle] : [];
  }

  function navCandidates(areas) {
    const listBox = els.list.getBoundingClientRect();
    const out = [];
    for (const area of areas) {
      const items = area.matches(NAV_ITEMS) ? [area] : [...area.querySelectorAll(NAV_ITEMS)];
      for (const el of items) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
        // Nella lista contano solo le righe (anche in parte) visibili.
        if (els.list.contains(el) && (r.bottom <= listBox.top || r.top >= listBox.bottom)) continue;
        out.push(el);
      }
    }
    return out;
  }

  function focusItem(el) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }

  /** Primo elemento a cui dare il fuoco entrando in un'area: il canale attivo, se visibile. */
  function focusFirst() {
    const items = navCandidates(navAreas());
    const active = items.find((el) => el.classList.contains('ch') && el.classList.contains('active'));
    const first = active || items.find((el) => el.classList.contains('ch')) || items[0];
    if (first) focusItem(first);
  }

  function moveFocus(dir) {
    const current = document.activeElement;
    // Su e giù tra le righe della lista: per posizione, così si scorre oltre quelle a schermo.
    if ((dir === 'up' || dir === 'down') && current && current.parentElement === els.rows
      && (current.classList.contains('ch') || current.classList.contains('folder'))
      && stepRow(current, dir === 'down' ? 1 : -1)) return;
    const items = navCandidates(navAreas());
    if (!items.includes(current)) return focusFirst();
    const r = current.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const vertical = dir === 'up' || dir === 'down';
    let best = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (el === current) continue;
      const b = el.getBoundingClientRect();
      const dx = b.left + b.width / 2 - cx;
      const dy = b.top + b.height / 2 - cy;
      const ahead = { up: dy < -4, down: dy > 4, left: dx < -4, right: dx > 4 }[dir];
      if (!ahead) continue;
      // Distanza lungo la direzione, penalizzando chi è spostato di lato. Prima gli elementi
      // davvero in quella direzione (entro 45°): "destra" non deve finire sul campo appena sotto.
      const along = vertical ? Math.abs(dy) : Math.abs(dx);
      const aside = vertical ? Math.abs(dx) : Math.abs(dy);
      const score = along + aside * 2 + (aside > along ? 1e6 : 0);
      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (best) focusItem(best);
  }

  /** Tasti del telecomando in modalità TV; restituisce true se il tasto è stato gestito. */
  function handleRemote(e) {
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    const inText = e.target instanceof HTMLInputElement && e.target.type !== 'range';
    if (dir) {
      // Nei campi di testo sinistra/destra spostano il cursore.
      if (inText && !dir.match(/up|down/)) return false;
      if (!navAreas().length) return false; // guardando il video: canale e volume
      e.preventDefault();
      moveFocus(dir);
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!navAreas().length) {
        // OK mentre si guarda: apre il pannello sul canale attuale.
        setSidebar(true);
        setTimeout(focusFirst, 80);
        return true;
      }
      const el = document.activeElement;
      if (!el || el === document.body || !navCandidates(navAreas()).includes(el)) {
        focusFirst();
      } else if (el instanceof HTMLInputElement && el.type !== 'range') {
        // Nei campi: OK conferma il modulo (dialoghi, aggiunta lista); la ricerca filtra già da sola.
        el.form?.requestSubmit();
      } else {
        // OK attiva l'elemento selezionato (alcuni telecomandi non generano il "clic" nativo).
        el.click();
      }
      return true;
    }
    return false;
  }

  // Chiudendo un menu o un dialogo, il fuoco torna dove era: col telecomando non ci si perde.
  let focusBeforeOverlay = null;
  function rememberFocus() {
    const el = document.activeElement;
    // Un menu che ne apre un altro (es. Opzioni → Lingua) non sovrascrive il punto di partenza.
    if (tv && !menu.open && !dialogOpen() && !els.menu.contains(el) && !els.dialog.contains(el)) focusBeforeOverlay = el;
  }
  function restoreFocus() {
    if (!tv || menu.open || dialogOpen()) return;
    const el = focusBeforeOverlay;
    focusBeforeOverlay = null;
    if (el?.isConnected) focusItem(el);
    else if (navAreas().length) focusFirst();
  }

  document.addEventListener('keydown', wake);

  document.addEventListener('keydown', (e) => {
    if (tv && handleRemote(e)) return;
    if (e.key === 'ChannelUp') { e.preventDefault(); step(-1); return; }
    if (e.key === 'ChannelDown') { e.preventDefault(); step(1); return; }
    if (menu.open && e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    // Con un dialogo aperto: Esc annulla, Invio conferma (gestito dal form).
    if (dialogOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(null); }
      return;
    }
    // F11 come in Windows: schermo intero (funziona anche mentre si scrive in un campo).
    if (e.key === 'F11') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }
    const typing = e.target instanceof HTMLInputElement;
    // Esc torna indietro un passo alla volta: anteprima → campo → pannello canali → schermo intero → uscita.
    if (e.key === 'Escape') {
      e.preventDefault();
      goBack();
      return;
    }
    if (typing) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); step(1); break;
      case 'ArrowUp': e.preventDefault(); step(-1); break;
      case 'ArrowRight': setVolume(state.volume + 0.05); wake(); break;
      case 'ArrowLeft': setVolume(state.volume - 0.05); wake(); break;
      case 'm': case 'M': toggleMute(); wake(); break;
      case 'c': case 'C': if (body.classList.contains('has-subs')) { toggleSubs(); wake(); } break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'r': case 'R': reloadChannel(); break;
      case 's': case 'S': setSidebar(!sidebarOpen()); break;
      case 'g': case 'G': if (gv.open) closeGuide(); else openGuide(); break;
      case '/': e.preventDefault(); setSidebar(true); els.searchInput.focus(); break;
    }
  });

  window.addEventListener('resize', () => {
    paintSubtitle(subs.shown);
    scheduleRows();
    moveHighlight(true);
    closeMenu();
    hidePreview();
    nativeRect();
    scheduleGuide();
  });
  window.addEventListener('beforeunload', flushOrg);

  // ---------- Avvio ----------

  const spinnerBars = [];
  for (let n = 0; n < 12; n++) {
    const bar = document.createElement('i');
    bar.style.setProperty('--r', `${n * 30}deg`);
    bar.style.setProperty('--dl', `${(n - 12) / 12}s`);
    spinnerBars.push(bar);
  }
  els.spinner.append(...spinnerBars);

  applyLanguage();
  setSidebar(store.get('sidebar', true));
  applyVolume();
  requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('preload')));

  // Il plugin window-state riapre la finestra già a schermo intero se lo era alla chiusura.
  if (!mobile) {
    appWindow.isFullscreen().then((fs) => {
      if (!fs) return;
      sidebarBeforeFs = sidebarOpen();
      body.classList.add('fs', 'sb-closed');
    }).catch(() => {});
  }

  invoke('get_proxy')
    .then((p) => {
      state.proxy = { enabled: !!p.enabled, url: p.url || '', username: p.username || '', password: p.password || '' };
      nativeProxy();
    })
    .catch(() => {});

  refreshSources()
    .then(({ active }) => {
      renderPublicLists();
      if (active) return openSource(active).then(() => { if (tv && sidebarOpen()) focusFirst(); });
      // Sul telefono, senza liste, il pannello coprirebbe la schermata di benvenuto.
      if (narrow()) body.classList.add('sb-closed');
      if (tv) focusItem(els.emptyInput);
      else els.emptyInput.focus();
    })
    .catch((err) => toast(errText(err), { kind: 'error' }));
})();
