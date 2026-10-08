import { parseOggOpus, decodeRange } from './ogg-opus.js';
import { createDrive, createCache, loadSong, parseFolderId } from './drive.js';
import { buildMeta, snapBeat, snapBar, barBeatAt, prevBar, nextBar, chordAt, bpmAt, lyricAt, sectionsView, sectionAt, shortLabel } from './meta.js';

const $ = id => document.getElementById(id);
const T = window.Themes;
const SR = 48000, BLOCK = 96000, AHEAD = 4;               // blocs de 2 s, 4 s planifiées d'avance
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const fmtT = s => { const d = Math.floor(Math.max(0, s) * 10), sec = (d % 600) / 10; return Math.floor(d / 600) + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1); };
const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
const msg = t => { $('msg').textContent = t || ''; };
const status = t => { $('status').textContent = t || ''; };
const pref = { notation: store.get('chordNotation') || 'pop', level: store.get('chordLevel') || 'simple' };

// ---------------- Lecteur ----------------
let ctx = null, tracks = [], gains = [], playing = false, gen = 0, pumping = false, timer = null;
let segs = [], live = new Set(), cursorSample = 0, cursorWhen = 0, posSample = 0, endWhen = 0, dragging = false;
const dur = () => Math.min(...tracks.map(t => t.p.durationSamples));
const loopA = () => Math.round($('a').value * SR), loopB = () => Math.round($('b').value * SR);
const loopOn = () => $('loop').checked && loopB() > loopA() + SR * 0.1;     // une boucle B <= A est ignorée

function buildGains() {                                             // un GainNode par piste, à refaire à chaque nouveau morceau
  gains.forEach(g => g.disconnect());
  gains = tracks.map((t, i) => { const g = ctx.createGain(); g.connect(ctx.destination); applyGain(i, g); return g; });
}
function ensureCtx() {
  if (ctx) return;
  ctx = new AudioContext({ sampleRate: SR });
  if (ctx.sampleRate !== SR) msg('Attention : le contexte audio tourne à ' + ctx.sampleRate + ' Hz au lieu de 48000.');
  buildGains();
}
function applyGain(i, g = gains[i]) { g.gain.value = $('m' + i).checked ? 0 : $('v' + i).value / 100; }
function stopSources() { live.forEach(s => { s.onended = null; try { s.stop(); } catch (e) {} }); live.clear(); segs = []; endWhen = 0; }
function curPos() {
  if (!playing) return posSample;
  const now = ctx.currentTime; let g = null;
  for (const s of segs) if (s.when <= now) g = s;
  if (!g) return segs.length ? segs[0].sample : posSample;
  return Math.min(g.sample + Math.round((now - g.when) * SR), g.sample + g.len);
}
// Temps entendu : on retire la latence de sortie pour que paroles et accords tombent avec le son.
const curTime = () => Math.max(0, curPos() / SR - ((playing && ctx && ctx.outputLatency) || 0));
function pause() {
  if (!playing) return;
  posSample = Math.min(curPos(), dur()); playing = false; gen++;
  clearInterval(timer); stopSources(); $('play').textContent = '▶ Lecture';
}
function startFrom(sample) {
  gen++; stopSources(); playing = true;
  cursorSample = sample; cursorWhen = ctx.currentTime + 0.3;      // marge pour décoder le premier bloc
  clearInterval(timer); timer = setInterval(pump, 150); pump();
  $('play').textContent = '⏸ Pause';
}
async function pump() {
  if (pumping || !playing) return;
  pumping = true; const my = gen;
  try {
    while (playing && my === gen && cursorWhen < ctx.currentTime + AHEAD) {
      const D = dur();
      if (loopOn() && cursorSample >= loopB()) cursorSample = loopA();
      if (cursorSample >= D) {
        if (!loopOn()) { endWhen = cursorWhen; break; }
        cursorSample = loopA();
      }
      let end = Math.min(cursorSample + BLOCK, D);
      if (loopOn() && cursorSample < loopB()) end = Math.min(end, loopB());
      const len = end - cursorSample;
      const res = await Promise.all(tracks.map(t => decodeRange(t.p, t.dec, cursorSample, len)));
      if (my !== gen) return;
      if (cursorWhen < ctx.currentTime) { msg('Décodage trop lent : resynchronisation.'); startFrom(cursorSample); return; }
      res.forEach((r, i) => {
        const buf = ctx.createBuffer(2, len, SR);
        buf.copyToChannel(r.channelData[0], 0); buf.copyToChannel(r.channelData[1], 1);
        const s = ctx.createBufferSource(); s.buffer = buf; s.connect(gains[i]);
        s.start(cursorWhen);                                        // même instant pour toutes les pistes
        live.add(s); s.onended = () => live.delete(s);
      });
      segs.push({ when: cursorWhen, sample: cursorSample, len }); if (segs.length > 8) segs.shift();
      cursorWhen += len / SR; cursorSample += len;
      if (loopOn() && cursorSample >= loopB()) cursorSample = loopA();
    }
  } catch (e) { msg('Erreur de lecture : ' + e.message); }
  finally { pumping = false; }
}

// ---------------- Métadonnées : grille, accords, paroles, sections ----------------
let M = null, view = [], mapBtns = [], listBtns = [], lyEls = [];
let ui = { bb: '', sec: -2, chord: '', line: -2, word: -2, time: '' };
const noMeta = () => { M = null; view = []; ui = { bb: '', sec: -2, chord: '', line: -2, word: -2, time: '' }; renderStructure(); renderLyrics(); $('now').hidden = true; };

function snapTime(t, mode = $('snap').value) {
  if (!M || !M.beats || mode === 'free') return t;
  return mode === 'bar' ? snapBar(M.beats, t) : snapBeat(M.beats, t);
}
function seekTo(t, snap = true) {
  t = Math.max(0, Math.min(t, dur() / SR)); if (snap) t = snapTime(t);
  posSample = Math.round(t * SR); $('pos').value = posSample; if (playing) startFrom(posSample);
}
function loopSection(g) { $('a').value = g.start; $('b').value = g.end; $('loop').checked = true; seekTo(g.start, false); }

function renderStructure() {
  const map = $('map'), list = $('secs'); map.innerHTML = ''; list.innerHTML = ''; mapBtns = []; listBtns = []; ui.sec = -2;
  if (!M || !M.sections) { view = []; map.hidden = true; $('seclist').hidden = true; return; }
  view = sectionsView(M.sections, $('merge').checked);
  map.hidden = false; $('seclist').hidden = false;
  view.forEach(g => {
    const btn = () => { const b = document.createElement('button'); b.type = 'button'; b.onclick = () => loopSection(g); return b; };
    const m = btn(); m.textContent = shortLabel(g.name); m.style.flexGrow = g.end - g.start;
    m.setAttribute('aria-label', g.name + ', de ' + fmt(g.start) + ' à ' + fmt(g.end) + ', boucler cette section'); m.title = g.name + ' ' + fmt(g.start) + '–' + fmt(g.end);
    map.appendChild(m); mapBtns.push(m);
    const l = btn(); l.textContent = g.name + ' ' + fmt(g.start); list.appendChild(l); listBtns.push(l);
  });
  const off = document.createElement('button'); off.type = 'button'; off.textContent = 'Sans boucle'; off.onclick = () => { $('loop').checked = false; }; list.appendChild(off);
}
function renderLyrics() {
  const box = $('lyrics'); box.innerHTML = ''; lyEls = []; ui.line = -2; ui.word = -2;
  if (!M || !M.lyrics) { $('lyrics-panel').hidden = true; return; }
  $('lyrics-panel').hidden = false;
  M.lyrics.lines.forEach(l => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ly'; b.setAttribute('aria-current', 'false');
    let spans = [];
    if (l.words.length) spans = l.words.map(w => { const sp = document.createElement('span'); sp.className = 'w'; sp.textContent = w.word + ' '; b.appendChild(sp); return sp; });
    else b.textContent = l.text;
    b.onclick = () => seekTo(Math.max(0, l.start - 0.3), false);   // saut libre : une ligne ne tombe pas forcément sur un temps
    box.appendChild(b); lyEls.push({ b, spans });
  });
}
function scrollLyric(el) {
  const box = $('lyrics'); if (!box.scrollTo) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: reduce ? 'auto' : 'smooth' });
}
// Appelée à chaque image : ne touche au DOM que lorsqu'une valeur change.
function updateMusical(t) {
  if (!M) return;
  const bb = M.beats ? barBeatAt(M.beats, t) : null, bpm = M.bpm ? bpmAt(M.bpm, t) : null;
  const txt = [bb && 'Mesure ' + bb.bar + ' · temps ' + bb.beat, bpm && Math.round(bpm) + ' BPM'].filter(Boolean).join(' · ');
  if (txt !== ui.bb) { ui.bb = txt; $('barbeat').textContent = txt; }
  if (M.chords) {
    const c = chordAt(M.chords, t, pref.notation, pref.level), key = c.index + '|' + pref.notation + '|' + pref.level;
    if (key !== ui.chord) {
      ui.chord = key; $('chord-now').textContent = c.now || '–'; $('chord-next').textContent = c.next ? '→ ' + c.next : '';
      $('next-lbl').textContent = c.inBeats ? 'Suivant (dans ' + c.inBeats + ' temps)' : 'Suivant';
    }
  }
  if (view.length) {
    const si = sectionAt(view, t);
    if (si !== ui.sec) {
      ui.sec = si; $('secname').textContent = si >= 0 ? view[si].name : '';
      mapBtns.forEach((b, i) => b.setAttribute('aria-current', String(i === si))); listBtns.forEach((b, i) => b.setAttribute('aria-current', String(i === si)));
    }
  }
  if (M.lyrics) {
    const { line, word } = lyricAt(M.lyrics, t);
    if (line !== ui.line) {
      if (ui.line >= 0 && lyEls[ui.line]) { const o = lyEls[ui.line]; o.b.setAttribute('aria-current', 'false'); o.spans.forEach(sp => { sp.className = 'w'; }); }
      if (line >= 0) { lyEls[line].b.setAttribute('aria-current', 'true'); scrollLyric(lyEls[line].b); }
      ui.line = line; ui.word = -2;
    }
    if (line >= 0 && word !== ui.word) { lyEls[line].spans.forEach((sp, k) => { sp.className = k <= word ? 'w sung' : 'w'; }); ui.word = word; }
  }
}
function tick() {
  if (tracks.length) {
    if (playing && endWhen && ctx.currentTime >= endWhen) { pause(); posSample = 0; }
    const p = curPos(), D = dur();
    if (!dragging) $('pos').value = p;
    const txt = fmtT(p / SR) + ' / ' + fmtT(D / SR);
    if (txt !== ui.time) { ui.time = txt; $('time').textContent = txt; $('pos').setAttribute('aria-valuetext', txt); }
    updateMusical(curTime());
  }
  requestAnimationFrame(tick);
}

// ---------------- Chargement des pistes ----------------
const label = n => n.replace(/\.opus$/i, '').replace(/\.ogg$/i, '');
async function loadFromBytes(list) {                                // list : [{name, bytes}]
  pause(); posSample = 0; tracks.forEach(t => t.dec.free()); tracks = [];
  if (ctx) { gains.forEach(g => g.disconnect()); gains = []; }
  const Dec = window['opus-decoder'] && window['opus-decoder'].OpusDecoder;
  if (!Dec) throw new Error('Décodeur Opus non chargé (fichier vendor/opus-decoder.min.js manquant ?).');
  for (const f of list) {
    const p = parseOggOpus(f.bytes);
    if (p.channels !== 2) throw new Error(f.name + ' : ' + p.channels + ' canaux (stéréo attendu)');
    const dec = new Dec({ channels: 2 }); await dec.ready;
    tracks.push({ name: f.name, p, dec });
  }
  const durs = new Set(tracks.map(t => t.p.durationSamples)), pre = new Set(tracks.map(t => t.p.preSkip));
  const ok = durs.size === 1 && pre.size === 1;
  const encs = new Set(tracks.map(t => { const c = t.p.tags.comments; return c.PROFILE ? 'profil ' + c.PROFILE : (t.p.tags.vendor || 'encodeur inconnu'); }));
  const mixed = encs.size > 1;                                      // pistes encodées avec des encodeurs ou réglages différents
  $('info').className = ok && !mixed ? 'ok' : 'ko';
  $('info').textContent = (ok ? '✔ ' + tracks.length + ' pistes alignées (' + [...durs][0] + ' échantillons).' : '✘ Durées ou pre-skip différents : pistes non alignées.')
    + (mixed ? ' ⚠ Encodages différents : ' + [...encs].join(' ; ') + '.' : ' Encodage : ' + [...encs][0] + '.');
  $('tracks').innerHTML = tracks.map((t, i) => `<div class="track"><span class="n">${esc(label(t.name))}</span>
    <input type="range" id="v${i}" min="0" max="100" value="100" aria-label="Volume ${esc(label(t.name))}">
    <label class="chk"><input type="checkbox" id="m${i}"> Muet</label></div>`).join('');
  tracks.forEach((t, i) => {
    if (/^original/i.test(t.name)) $('m' + i).checked = true;       // le mix original est muet par défaut
    $('v' + i).oninput = $('m' + i).onchange = () => gains[i] && applyGain(i);
  });
  if (ctx) buildGains();                                            // contexte déjà créé : reconnecter les nouvelles pistes
  $('pos').max = dur(); $('pos').value = 0; $('pos').disabled = false; $('play').disabled = false;
  $('b').value = Math.min(4, (dur() / SR).toFixed(1));
}
$('play').onclick = async () => { if (playing) { pause(); return; } ensureCtx(); await ctx.resume(); msg(''); startFrom(posSample); };
$('pos').oninput = () => { dragging = true; };
$('pos').onchange = () => { dragging = false; seekTo(+$('pos').value / SR); };
$('prev-bar').onclick = () => { if (!tracks.length) return; seekTo(M && M.beats ? prevBar(M.beats, curTime()) : curTime() - 2, false); };
$('next-bar').onclick = () => {
  if (!tracks.length) return;
  if (M && M.beats) { const n = nextBar(M.beats, curTime()); if (n !== null) seekTo(n, false); } else seekTo(curTime() + 2, false);
};
$('set-a').onclick = () => { $('a').value = snapTime(curTime()).toFixed(2); msg(''); };
$('set-b').onclick = () => {
  const v = snapTime(curTime()); $('b').value = v.toFixed(2);
  msg(v <= +$('a').value ? 'Le point B doit être après le point A.' : '');
};
$('snap').value = store.get('snap') || 'beat'; $('snap').onchange = () => store.set('snap', $('snap').value);
$('merge').checked = store.get('merge') === '1'; $('merge').onchange = () => { store.set('merge', $('merge').checked ? '1' : '0'); renderStructure(); };
$('f').onchange = async e => {
  try {
    const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name));
    msg(''); noMeta(); $('song-info').textContent = '';
    await loadFromBytes(await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
  } catch (err) { msg(err.message); }
};
document.addEventListener('keydown', e => {                          // clavier : espace = lecture/pause, flèches = mesure précédente/suivante
  const tag = (e.target && e.target.tagName) || '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || e.ctrlKey || e.metaKey || e.altKey || !tracks.length) return;
  if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); $('play').onclick(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); $('prev-bar').onclick(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); $('next-bar').onclick(); }
});

// ---------------- Google Drive + cache ----------------
const cache = createCache();
let drive = null;
const makeDrive = () => { const k = $('key').value.trim(); return k ? createDrive(k) : null; };
$('key').value = store.get('drv_key') || ''; $('root').value = store.get('drv_root') || '';
drive = makeDrive();
cache.purge().then(n => n && status(n + ' fichier(s) inutilisé(s) depuis 45 jours supprimé(s) du cache.'));
cache.persist();

function songButtons(el, items) {
  el.innerHTML = '';
  items.forEach(s => { const b = document.createElement('button'); b.type = 'button'; b.textContent = s.name; b.onclick = () => openSong(s); el.appendChild(b); });
}
async function refreshLocal() {
  const l = await cache.listSongs();
  songButtons($('local'), l);
  if (!l.length) $('local').textContent = 'Aucun morceau enregistré pour l\'instant.';
}
$('list').onclick = async () => {
  try {
    msg(''); status('Lecture de la liste…');
    const rootId = parseFolderId($('root').value); $('root').value = rootId;     // une adresse Drive collée est réduite à son identifiant
    store.set('drv_key', $('key').value.trim()); store.set('drv_root', rootId);
    drive = makeDrive();
    if (!drive) throw new Error('Saisissez une clé API.');
    const songs = await drive.listSongs(rootId);
    if (songs.length) songButtons($('songs'), songs); else $('songs').textContent = 'Aucun morceau terminé (dossier contenant _termine) trouvé.';
    status('');
  } catch (e) { status(''); msg(e.message); }
};
async function openSong(s) {
  try {
    pause(); msg(''); noMeta(); $('song-info').textContent = '';
    const r = await loadSong(navigator.onLine ? drive : null, cache, s.id, status, s.name);
    await loadFromBytes(r.tracks);
    M = buildMeta(r.meta);
    const i = M.info;
    $('song-info').textContent = [i.titre && (i.artiste ? i.artiste + ' - ' + i.titre : i.titre), i.bpm && i.bpm + ' BPM', i['tonalité'] || i.tonalite,
      M.beats && M.beats.t.length + ' temps'].filter(Boolean).join(' · ');
    renderStructure(); renderLyrics();
    $('now').hidden = !(M.beats || M.chords);
    status(r.offline ? 'Hors ligne : copie enregistrée sur cet appareil.' : r.fromCache ? r.fromCache + ' piste(s) lue(s) depuis le cache.' : '');
    if (r.warnings.length) msg(r.warnings.join('\n'));
    refreshLocal();
  } catch (e) { status(''); msg(e.message); }
}
refreshLocal();

// ---------------- Réglages : thèmes, accords, version, cache ----------------
const settings = $('settings');
$('ver').textContent = self.APP_VERSION || '?';
function fillThemes() {
  $('theme').innerHTML = [{ id: 'auto', label: 'Automatique (réglage du système)' }, ...T.list()].map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
  $('theme').value = T.saved();
}
fillThemes();
$('theme').onchange = () => { T.save($('theme').value); T.apply($('theme').value); };
$('chord-notation').value = pref.notation; $('chord-level').value = pref.level;
$('chord-notation').onchange = () => { pref.notation = $('chord-notation').value; store.set('chordNotation', pref.notation); ui.chord = ''; };
$('chord-level').onchange = () => { pref.level = $('chord-level').value; store.set('chordLevel', pref.level); ui.chord = ''; };
async function showStorage() {
  const u = await cache.usage();
  $('storage').textContent = u ? 'Stockage utilisé : ' + (u.used / 1e6).toFixed(0) + ' Mo' + (u.quota ? ' sur ' + (u.quota / 1e9).toFixed(1) + ' Go disponibles' : '') + '.' : '';
}
$('open-settings').onclick = () => { fillThemes(); showStorage(); settings.showModal(); };
$('clear-cache').onclick = async () => { await cache.clear(); await refreshLocal(); await showStorage(); status('Cache audio vidé.'); };

// ---------------- Mises à jour (service worker) ----------------
let swReg = null;
function offerUpdate() {
  $('update').hidden = false;
  fetch('version.js', { cache: 'no-store' }).then(r => r.text()).then(t => {
    const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(t);
    if (m) $('update-text').textContent = 'La version ' + m[1] + ' est disponible (vous utilisez la ' + self.APP_VERSION + ').';
  }).catch(() => {});
}
$('update-go').onclick = () => { if (swReg && swReg.waiting) swReg.waiting.postMessage('SKIP_WAITING'); };
$('check-update').onclick = async () => {
  if (!swReg) { $('storage').textContent = 'Mises à jour indisponibles (service worker non actif).'; return; }
  $('storage').textContent = 'Recherche…';
  try { await swReg.update(); } catch (e) { $('storage').textContent = 'Impossible de vérifier (hors ligne ?).'; return; }
  $('storage').textContent = (swReg.waiting || swReg.installing) ? 'Une nouvelle version est prête.' : 'Vous avez la dernière version (' + self.APP_VERSION + ').';
};
async function initSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  try { swReg = await navigator.serviceWorker.register('sw.js'); } catch (e) { return; }
  if (swReg.waiting && hadController) offerUpdate();
  swReg.addEventListener('updatefound', () => {
    const w = swReg.installing;
    w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(); });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadController || reloading) return; reloading = true; location.reload(); });
  setInterval(() => swReg.update().catch(() => {}), 3600e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) swReg.update().catch(() => {}); });
}
initSW();
noMeta();
requestAnimationFrame(tick);
