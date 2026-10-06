// meta.js : transforme les JSON du morceau en structures prêtes à interroger (grille de temps, accords, paroles, sections).
// Tolérant : chaque partie absente ou illisible donne null, l'interface masque alors la fonctionnalité correspondante.

const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;

// Plus grand indice i tel que arr[i] <= x ; -1 si x est avant le premier élément.
export function lastLE(arr, x) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
// Plus petit indice i tel que arr[i] > x ; arr.length si aucun.
export function firstGT(arr, x) { return lastLE(arr, x) + 1; }

// ---------- grille de temps ----------
function buildBeats(meta) {
  let times = [], nums = [];
  if (Array.isArray(meta.beats)) for (const b of meta.beats) if (b && num(b.time) !== null) { times.push(b.time); nums.push(b.beatNum | 0); }
  if (!times.length && Array.isArray(meta.chords))                       // repli : la grille des accords
    for (const c of meta.chords) if (c && num(c.curr_beat_time) !== null) { times.push(c.curr_beat_time); nums.push(c.beat_num | 0); }
  if (!times.length) return null;
  const t = Float64Array.from(times), bar = new Int32Array(t.length), starts = [];
  let b = 0;
  for (let i = 0; i < t.length; i++) { if (nums[i] === 1) { b++; starts.push(t[i]); } bar[i] = b; }
  return { t, n: Uint8Array.from(nums), bar, barStarts: Float64Array.from(starts) };
}
export function nearestIndex(arr, x) {
  const i = lastLE(arr, x);
  if (i < 0) return 0; if (i >= arr.length - 1) return arr.length - 1;
  return (x - arr[i] <= arr[i + 1] - x) ? i : i + 1;
}
export const snapBeat = (g, t) => g.t[nearestIndex(g.t, t)];
export const snapBar = (g, t) => g.barStarts.length ? g.barStarts[nearestIndex(g.barStarts, t)] : snapBeat(g, t);
export function barBeatAt(g, t) { const i = lastLE(g.t, t); return i < 0 ? null : { bar: g.bar[i], beat: g.n[i], index: i }; }
export function prevBar(g, t) { const i = lastLE(g.barStarts, t - 0.25); return g.barStarts[Math.max(0, i)]; }
export function nextBar(g, t) { const i = firstGT(g.barStarts, t + 0.05); return i < g.barStarts.length ? g.barStarts[i] : null; }

// ---------- accords ----------
function buildChords(meta) {
  if (!Array.isArray(meta.chords) || !meta.chords.length) return null;
  const list = meta.chords.filter(c => c && num(c.curr_beat_time) !== null).sort((a, b) => a.curr_beat_time - b.curr_beat_time);
  return list.length ? { list, t: Float64Array.from(list.map(c => c.curr_beat_time)) } : null;
}
// notation : 'pop' | 'jazz' | 'nashville' ; level : 'basic' | 'simple' | 'complex'
export function chordText(c, notation, level) {
  if (!c) return '';
  const key = 'chord_' + level + '_' + notation;
  let s = c[key] ?? c['chord_simple_' + notation] ?? c.chord_simple_pop ?? '';
  const bass = notation === 'nashville' ? c.bass_nashville : c.bass;
  if (s && bass && bass !== s) s += '/' + bass;
  return String(s);
}
// Accord courant, accord suivant différent, et nombre de temps avant le changement.
export function chordAt(ch, t, notation, level) {
  const i = lastLE(ch.t, t);
  if (i < 0) return { index: -1, now: '', next: chordText(ch.list[0], notation, level), inBeats: null };
  const now = chordText(ch.list[i], notation, level);
  let j = i + 1;
  while (j < ch.list.length && chordText(ch.list[j], notation, level) === now) j++;
  return { index: i, now, next: j < ch.list.length ? chordText(ch.list[j], notation, level) : '', inBeats: j < ch.list.length ? j - i : null };
}

// ---------- BPM local ----------
function buildBpm(meta) {
  if (!Array.isArray(meta.bpm_local) || !meta.bpm_local.length) return null;
  const l = meta.bpm_local.filter(b => b && num(b.beat_time) !== null && num(b.bpm) !== null).sort((a, b) => a.beat_time - b.beat_time);
  return l.length ? { t: Float64Array.from(l.map(b => b.beat_time)), bpm: Float64Array.from(l.map(b => b.bpm)) } : null;
}
export function bpmAt(b, t) { const i = lastLE(b.t, t); return i < 0 ? b.bpm[0] : b.bpm[i]; }

// ---------- paroles ----------
export function parseLrc(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(raw.trim());
    if (m) out.push({ text: m[3].trim(), start: (+m[1]) * 60 + (+m[2]) });
  }
  out.forEach((l, i) => { l.end = i + 1 < out.length ? out[i + 1].start : l.start + 4; l.words = []; });
  return out.filter(l => l.text);
}
function buildLyrics(meta) {
  let lines = null;
  const nf = meta.lyrics_new_format;
  if (Array.isArray(nf) && nf.length) {
    lines = nf.filter(l => l && l.text && num(l.start) !== null).map(l => ({
      text: String(l.text), start: l.start, end: num(l.end) ?? l.start + 3,
      words: Array.isArray(l.words) ? l.words.filter(w => w && w.word && num(w.start) !== null).map(w => ({ word: String(w.word), start: w.start, end: num(w.end) ?? w.start })) : [],
    }));
  } else if (typeof meta.paroles_lrc === 'string') lines = parseLrc(meta.paroles_lrc);
  if (!lines || !lines.length) return null;
  lines.sort((a, b) => a.start - b.start);
  return { lines, starts: Float64Array.from(lines.map(l => l.start)) };
}
// Ligne active (jusqu'à 2,5 s après sa fin, pour ne pas clignoter entre deux phrases) et mot courant.
export function lyricAt(ly, t) {
  const i = lastLE(ly.starts, t);
  if (i < 0) return { line: -1, word: -1 };
  const l = ly.lines[i];
  if (t > l.end + 2.5) return { line: -1, word: -1 };
  let w = -1; for (let k = 0; k < l.words.length; k++) if (l.words[k].start <= t) w = k; else break;
  return { line: i, word: w };
}

// ---------- sections ----------
function buildSections(meta) {
  const src = Array.isArray(meta.segments) ? meta.segments : (meta.infos && Array.isArray(meta.infos.sections)) ? meta.infos.sections : null;
  if (!src) return null;
  const l = src.filter(s => s && num(s.start) !== null && num(s.end) !== null).map(s => ({ label: String(s.label || ''), start: s.start, end: s.end }));
  return l.length ? l.sort((a, b) => a.start - b.start) : null;
}
// Regroupe les sections consécutives de même nom (ex. 3 « Chorus » d'affilée) et numérote les répétitions.
export function mergeSections(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.label.trim().toLowerCase() === s.label.trim().toLowerCase()) last.end = s.end;
    else out.push({ ...s });
  }
  const total = {}, seen = {};
  out.forEach(s => { total[s.label] = (total[s.label] || 0) + 1; });
  out.forEach(s => { seen[s.label] = (seen[s.label] || 0) + 1; s.name = total[s.label] > 1 ? s.label + ' ' + seen[s.label] : s.label; });
  return out;
}
export function sectionsView(segs, merged) { return merged ? mergeSections(segs) : segs.map(s => ({ ...s, name: s.label })); }
export function sectionAt(view, t) { for (let i = 0; i < view.length; i++) if (t >= view[i].start && t < view[i].end) return i; return -1; }
export const shortLabel = n => n.split(/\s+/).map(w => /^\d+$/.test(w) ? w : w[0].toUpperCase()).join('');

// ---------- point d'entrée ----------
export function buildMeta(meta) {
  meta = meta || {};
  return { info: meta.infos || {}, beats: buildBeats(meta), chords: buildChords(meta), bpm: buildBpm(meta), lyrics: buildLyrics(meta), sections: buildSections(meta) };
}
