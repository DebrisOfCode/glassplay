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
    emptyForm: $('emptyForm'), emptyInput: $('emptyInput'), searchInput: $('searchInput'),
    card: $('card'), cardLogo: $('cardLogo'), cardName: $('cardName'),
    spinner: $('spinner'), controls: $('controls'), nowLogo: $('nowLogo'), nowName: $('nowName'), nowProgram: $('nowProgram'),
    muteBtn: $('muteBtn'), volume: $('volume'), fsBtn: $('fsBtn'), subsBtn: $('subsBtn'), subCanvas: $('subCanvas'),
    sidebar: $('sidebar'), sbToggle: $('sbToggle'), toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'),
    refreshBtn: $('refreshBtn'), updatedAt: $('updatedAt'), statusTexts: document.querySelectorAll('.status-text'),
    fileInput: $('fileInput'), emptyFile: $('emptyFile'),
    menu: $('menu'),
    preview: $('preview'), pvVideo: $('pvVideo'), pvName: $('pvName'), pvMsg: $('pvMsg'),
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
  // Android TV: nessun dispositivo di puntamento, si naviga con il telecomando.
  // localStorage "glassplay.tv" = "true" forza la modalità (per provarla su altri dispositivi).
  let forcedTv = false;
  try { forcedTv = localStorage.getItem('glassplay.tv') === 'true'; } catch { /* storage non disponibile */ }
  const tv = forcedTv || (mobile && matchMedia('(pointer: none)').matches);
  const narrow = () => matchMedia('(max-width: 720px)').matches;
  // macOS: la finestra usa i pulsanti nativi (semaforo) al posto di quelli disegnati dall'app.
  const mac = !mobile && /Macintosh|Mac OS X/i.test(navigator.userAgent);
  document.body.classList.toggle('mac', mac);
  document.body.classList.toggle('touch', touch || tv);
  document.body.classList.toggle('mobile', mobile);
  document.body.classList.toggle('tv', tv);
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
    channels: [],
    updatedAt: 0,  // ultimo download della lista attiva (secondi Unix)
    current: -1,
    hls: null,
    token: 0,
    hasPlayed: false,
    volume: store.get('volume', 0.8),
    muted: store.get('muted', false),
    previewOn: store.get('preview', true),
    // Sperimentale: per ora l'opzione viene solo memorizzata.
    proxyMask: store.get('proxyMask', false),
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
    img.src = ch.image;
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
  }

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

  // ---------- Lista canali (virtuale) ----------
  //
  // Anche con centinaia di migliaia di canali il DOM contiene solo le righe visibili.
  // La vista è un elenco di righe di tre tipi (sezione, cartella, canale) con altezze
  // diverse: `top` contiene la posizione di ogni riga, così la ricerca della prima riga
  // visibile è una ricerca binaria.

  const K_CH = 0;
  const K_FOLDER = 1;
  const K_SEC = 2;
  const HEIGHT = [60, 50, 30]; // deve coincidere con .ch, .folder e .sec in style.css
  const OVERSCAN_PX = 360;

  const list = {
    kind: new Uint8Array(0),
    ref: new Int32Array(0),    // indice canale | indice cartella | indice sezione
    nested: new Uint8Array(0), // 1 se il canale è dentro una cartella aperta
    top: new Float64Array(1),
    n: 0,
    posOf: new Int32Array(0),  // indice canale -> posizione nella vista (-1 se assente)
    secs: [],
    matches: 0,
    query: '',
    search: [],                // per ogni canale: nome + gruppo in minuscolo
    streamIdx: new Map(),      // stream -> indice canale
    rows: new Map(),           // posizione -> riga nel DOM
    animate: false,
    frame: 0,
  };

  function buildView() {
    const q = els.searchInput.value.trim().toLowerCase();
    const total = state.channels.length;
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
      const i = list.streamIdx.get(s);
      if (i !== undefined) push(K_CH, i, nest);
    };

    if (q) {
      // Ricerca: risultati in un'unica lista, ovunque si trovino.
      for (let i = 0; i < total; i++) if (list.search[i].includes(q)) push(K_CH, i);
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
      const { channels } = state;
      for (let i = 0; i < total; i++) if (!org.where.has(channels[i].stream)) push(K_CH, i);
    }

    const top = new Float64Array(n + 1);
    for (let p = 0; p < n; p++) top[p + 1] = top[p] + HEIGHT[kind[p]];
    const posOf = new Int32Array(total).fill(-1);
    for (let p = 0; p < n; p++) if (kind[p] === K_CH) posOf[ref[p]] = p;
    Object.assign(list, { kind, ref, nested, top, n, posOf, secs, matches, query: q });
  }

  function channelRow(i, pos) {
    const ch = state.channels[i];
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
    meta.append(h('span', 'name', ch.name), h('span', 'group', ch.group || ''));
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
    const count = f.items.reduce((n, s) => n + (list.streamIdx.has(s) ? 1 : 0), 0);
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
    const end = Math.min(list.n, posAt(top + els.list.clientHeight + OVERSCAN_PX) + 1);

    for (const [pos, row] of list.rows) {
      if (pos < start || pos >= end) {
        row.remove();
        list.rows.delete(pos);
      }
    }
    const frag = document.createDocumentFragment();
    for (let pos = start; pos < end; pos++) {
      if (list.rows.has(pos)) continue;
      const row = buildRow(pos);
      if (list.animate) {
        row.classList.add('enter');
        row.style.setProperty('--d', `${(pos - start) * 24}ms`);
      }
      list.rows.set(pos, row);
      frag.append(row);
    }
    els.rows.append(frag);
    list.animate = false;
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
    const total = state.channels.length;
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
    const smooth = !instant && Math.abs(target - top) < 3000;
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

  function applyChannels({ channels, updated_at: updatedAt }, rawOrg) {
    const playing = state.channels[state.current]?.stream;
    state.channels = channels;
    state.updatedAt = updatedAt;
    list.streamIdx = new Map();
    channels.forEach((c, i) => { if (!list.streamIdx.has(c.stream)) list.streamIdx.set(c.stream, i); });
    state.current = playing ? (list.streamIdx.get(playing) ?? -1) : -1;
    list.search = channels.map((c) => `${c.name}\n${c.group || ''}`.toLowerCase());
    org.data = normalizeOrg(rawOrg);
    indexOrg();
    els.updatedAt.textContent = formatUpdated(updatedAt);
    body.classList.add('has-source');
    list.animate = true;
    rebuild();
    markActive(true);
  }

  /** Nessuna lista: torna alla schermata di benvenuto. */
  function clearChannels() {
    state.token++;
    teardown();
    setLoading(false);
    state.channels = [];
    state.updatedAt = 0;
    state.current = -1;
    list.streamIdx = new Map();
    list.search = [];
    org.data = normalizeOrg(null);
    indexOrg();
    body.classList.remove('has-source', 'has-channel', 'is-playing', 'switching');
    resetProgram();
    resetSubs();
    rebuild();
  }

  function resumeLast() {
    if (state.current >= 0) return;
    const i = list.streamIdx.get(store.get('last', null));
    if (i !== undefined) play(i);
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
      applyChannels(result, rawOrg);
      toast(tr('toast.listUpdated', { count: fmtInt(result.channels.length) }), { kind: 'success' });
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
        const cached = await invoke('cached_channels', { id });
        if (cached && state.active === id) {
          applyChannels(cached, rawOrg);
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
    applyChannels(added, null);
    if (narrow() || tv) setSidebar(true); // si vedono subito i canali della nuova lista
    toast(tr('toast.listAdded', { count: fmtInt(added.channels.length) }), { kind: 'success' });
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
      const list = await invoke('replace_source_file', { id: target, fileName: file.name, content });
      await refreshSources();
      if (state.active !== target) return;
      applyChannels(list, org.data);
      toast(tr('toast.listUpdated', { count: fmtInt(list.channels.length) }), { kind: 'success' });
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
    // L'anteprima al passaggio richiede un mouse: su telefono e TV l'opzione non serve.
    const preview = touch || tv ? [] : [{
      label: tr('opt.preview'), sub: tr('opt.previewSub'), icon: ICONS.eye, toggle: state.previewOn, keepOpen: true,
      action: toggleItem('preview', 'previewOn', () => { if (!state.previewOn) hidePreview(); }),
    }];
    openMenu([
      { header: tr('opt.title') },
      ...preview,
      { label: tr('opt.language'), sub: current, icon: ICONS.globe, action: languageMenu },
      '-',
      {
        label: tr('opt.proxy'), sub: tr('opt.proxySub'), icon: ICONS.shield, toggle: state.proxyMask, keepOpen: true,
        action: toggleItem('proxyMask', 'proxyMask'),
      },
    ], els.optionsBtn.getBoundingClientRect(), { align: 'end', anchor: els.optionsBtn });
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
    const ch = state.channels[i];
    const at = org.where.get(ch.stream);
    const items = [
      { header: ch.name },
      { label: tr(at === PIN ? 'act.unpin' : 'act.pin'), icon: ICONS.pin, action: () => togglePin(ch.stream) },
    ];
    if (at && at !== PIN) items.push({ label: tr('menu.unfile'), icon: ICONS.out, action: () => unfile(ch.stream) });
    items.push('-', { header: tr('menu.moveTo') });
    for (const f of org.data.folders) {
      items.push({ label: f.name, icon: ICONS.folder, disabled: at === f.id, action: () => moveToFolder(ch.stream, f.id) });
    }
    items.push({ label: tr('menu.newFolder'), icon: ICONS.folderPlus, action: () => createFolder(ch.stream) });
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
    if (i === state.current) return;
    const ch = state.channels[i];
    const token = ++pv.token;
    pv.shown = true;

    const p = els.preview;
    els.pvName.textContent = ch.name;
    els.pvMsg.textContent = '';
    p.classList.remove('playing', 'failed');
    const r = row.getBoundingClientRect();
    const sb = els.sidebar.getBoundingClientRect();
    const hgt = p.offsetHeight;
    p.style.left = `${sb.right + 12}px`;
    p.style.top = `${clamp(r.top + r.height / 2 - hgt / 2, 12, innerHeight - hgt - 12)}px`;
    p.classList.add('show');
    previewTry([hlsVariant(ch.stream), ch.stream].filter(Boolean), token);
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

  els.pvVideo.muted = true;
  els.pvVideo.addEventListener('playing', () => { if (pv.shown) els.preview.classList.add('playing'); });
  els.list.addEventListener('mouseover', (e) => {
    const row = e.target.closest('.ch');
    if (row !== pv.row) schedulePreview(row);
  });
  els.list.addEventListener('mouseleave', () => schedulePreview(null));

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
      : { type: 'ch', stream: state.channels[row.dataset.i].stream };
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

  async function play(i) {
    const ch = state.channels[i];
    if (!ch) return;
    const token = ++state.token;

    state.current = i;
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

    // Lascia che il video precedente "affondi" prima di cambiare sorgente.
    if (state.hasPlayed) await wait(300);
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
  const subsAvailable = () => !!subs.dvb || hlsSubtitleTracks().length > 0 || textTracks().length > 0;

  function updateSubsButton() {
    body.classList.toggle('has-subs', subsAvailable());
    els.subsBtn.classList.toggle('on', subs.on);
    els.subsBtn.setAttribute('aria-pressed', String(subs.on));
  }

  /** Applica la scelta acceso/spento a tutte le fonti disponibili. */
  function applySubs() {
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
    Object.assign(subs, { dvb: null, queue: [], shown: null, initPTS: null, frame: 0 });
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
    const alt = hlsVariant(url);
    const original = () => playHls(url, token, () => playNative(url, token));
    if (alt) playHls(alt, token, original);
    else original();
  }

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
      backBufferLength: 30,
      manifestLoadingMaxRetry: 1,
      subtitleDisplay: subs.on,
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

  video.addEventListener('playing', () => {
    setLoading(false);
    state.hasPlayed = true;
    body.classList.add('is-playing');
    body.classList.remove('switching');
    hideCard(1400);
    // Un eventuale "Riprova" rimasto a schermo non serve più.
    if (els.toast.classList.contains('has-action')) hideToast();
    wake();
  });
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
    if (act?.dataset.act === 'pin') return togglePin(state.channels[i].stream);
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
  }, { passive: true });

  let filterTimer = 0;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(rebuild, state.channels.length > 5000 ? 180 : 0);
  });
  els.srcBtn.addEventListener('click', toggleMenu(els.srcBtn, sourcesMenu));
  els.optionsBtn.addEventListener('click', toggleMenu(els.optionsBtn, optionsMenu));
  els.emptyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    createSource('', els.emptyInput.value);
  });
  els.refreshBtn.addEventListener('click', () => (activeSource()?.file ? pickFile(state.active) : downloadActive()));
  els.emptyFile.addEventListener('click', () => pickFile());

  // ---------- Indietro e telecomando (Android, Android TV) ----------

  /** Un passo indietro: menu → dialogo → anteprima → campo → pannello → schermo intero → uscita. */
  function goBack() {
    if (menu.open) closeMenu();
    else if (dialogOpen()) closeDialog(null);
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
    if (sidebarOpen()) return body.classList.contains('has-channel') ? [els.sidebar, els.sbToggle, els.controls] : [els.sidebar, els.sbToggle];
    return [];
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
    const items = navCandidates(navAreas());
    const current = document.activeElement;
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
      // Distanza lungo la direzione, penalizzando chi è spostato di lato.
      const score = vertical ? Math.abs(dy) + Math.abs(dx) * 2 : Math.abs(dx) + Math.abs(dy) * 2;
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
      case '/': e.preventDefault(); setSidebar(true); els.searchInput.focus(); break;
    }
  });

  window.addEventListener('resize', () => {
    paintSubtitle(subs.shown);
    scheduleRows();
    moveHighlight(true);
    closeMenu();
    hidePreview();
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

  refreshSources()
    .then(({ active }) => {
      if (active) return openSource(active).then(() => { if (tv && sidebarOpen()) focusFirst(); });
      // Sul telefono, senza liste, il pannello coprirebbe la schermata di benvenuto.
      if (narrow()) body.classList.add('sb-closed');
      if (tv) focusItem(els.emptyInput);
      else els.emptyInput.focus();
    })
    .catch((err) => toast(errText(err), { kind: 'error' }));
})();
