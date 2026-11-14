// Transient mode: finds the attacks of a song (onsets), its tempo and bar grid,
// and turns them into the editable list of sections the popup draws on the
// waveform. Pure functions on mono PCM (Float32Array, ANALYSIS_RATE Hz) so they
// run, and are tested, in Node.
//
// Detection is a multi-band spectral flux (SuperFlux style): each band (sub,
// low, mid, presence, air) is normalized on its own, so a hi-hat weighs like a
// kick ("by timbre"). Peaks of that curve are the candidate transients, each
// with a strength in [0, 1.5]; the sensitivity only filters them, so the
// slider and the grid toggles recompute instantly.

export const ANALYSIS_RATE = 22050;
/** Divisions per 4/4 bar: "1" = 1:1 (a bar) … "64" = 1:64; "2:1" … "32:1" = several bars; "auto" = every transient. */
export const GRIDS = ["1", "2", "4", "8", "16", "32", "64", "2:1", "4:1", "8:1", "16:1", "32:1", "auto"];
/** "2:1" … "32:1": sections of that many bars (phrases). */
export const MULTI_BAR_GRIDS = ["2:1", "4:1", "8:1", "16:1", "32:1"];
/** Anti-click ramps at the edges of every section heard or saved (the cut rarely falls on a zero crossing). */
export const DECLICK_IN_S = 0.002;
export const DECLICK_OUT_S = 0.003;
export const DEFAULT_SENSITIVITY = 0.5;

const FFT_SIZE = 1024;
const HOP = 256;
const BAND_EDGES_HZ = [0, 150, 400, 1500, 5000, 11025];
const PEAK_RADIUS = 3; // frames each side a peak must dominate (~35 ms)
const MEAN_BEFORE = 16; // adaptive threshold window, frames before/after
const MEAN_AFTER = 4;
const FINE_HOP = 16; // fine energy envelope used to place each onset on its attack
const FINE_WIN = 4; // in FINE_HOP blocks (64 samples ≈ 3 ms)
const MIN_SECTION_S = 0.01;
const ATTACK_MARGIN_S = 0.001;
export const MIN_DRAG_GAP_S = 0.02; // the view keeps dragged dividers this far from their neighbours
const PIN_SHADOW_S = 0.015; // an automatic cut this close to one the user placed gives way (< MIN_DRAG_GAP_S)

/** Raw little-endian PCM s16 (what Cachalot sends) → Float32 in [-1, 1). */
export function pcm16ToFloat(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const ints = new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) out[i] = ints[i] / 32768;
  return out;
}

// ---- FFT (radix-2, two real frames per complex transform) -------------------

function makeFft(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
}

// ---- Onset detection ----------------------------------------------------------

/**
 * Multi-band spectral flux of the whole signal.
 * Returns { env, bands: Float32Array[], frameRate, frames } where env[t] is
 * the combined novelty at frame t (centered at sample t*HOP).
 */
export function onsetEnvelope(samples, sampleRate = ANALYSIS_RATE) {
  const n = FFT_SIZE;
  const half = n / 2;
  const frames = Math.max(1, Math.ceil(samples.length / HOP) + 1);
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const fft = makeFft(n);
  const binHz = sampleRate / n;
  const bandOf = new Int8Array(half + 1);
  const bandCount = BAND_EDGES_HZ.length - 1;
  const binsPerBand = new Float64Array(bandCount);
  for (let k = 0; k <= half; k++) {
    const hz = k * binHz;
    let b = bandCount - 1;
    while (b > 0 && hz < BAND_EDGES_HZ[b]) b--;
    bandOf[k] = k === 0 ? -1 : b; // DC carries no attack
    if (k > 0) binsPerBand[b]++;
  }
  const bands = Array.from({ length: bandCount }, () => new Float32Array(frames));
  let prev = new Float64Array(half + 1);
  let cur = new Float64Array(half + 1);
  const reA = new Float64Array(n);
  const imA = new Float64Array(n);
  const scale = 1000 / half;

  const fill = (t, out, isImag) => {
    const offset = t * HOP - half; // frame t is centered on sample t*HOP
    for (let i = 0; i < n; i++) {
      const s = offset + i;
      out[i] = s >= 0 && s < samples.length ? samples[s] * window[i] : 0;
    }
    return isImag;
  };
  const logMag = (out, xr, xi) => {
    for (let k = 0; k <= half; k++) out[k] = Math.log1p(Math.hypot(xr[k], xi[k]) * scale);
  };
  const reB = new Float64Array(half + 1);
  const imB2 = new Float64Array(half + 1);
  const reC = new Float64Array(half + 1);
  const imC = new Float64Array(half + 1);
  const spectra = [cur, new Float64Array(half + 1)];

  const flux = (t, spec) => {
    for (let k = 1; k <= half; k++) {
      // SuperFlux: compare with the louder neighbour of the previous frame (vibrato is not an attack)
      const ref = Math.max(prev[k], k > 1 ? prev[k - 1] : 0, k < half ? prev[k + 1] : 0);
      const d = spec[k] - ref;
      if (d > 0) bands[bandOf[k]][t] += d;
    }
    const swap = prev;
    prev = spec;
    return swap;
  };

  for (let t = 0; t < frames; t += 2) {
    // two real frames in one complex FFT: x = a + i·b
    fill(t, reA, false);
    if (t + 1 < frames) fill(t + 1, imA, true);
    else imA.fill(0);
    fft(reA, imA);
    for (let k = 0; k <= half; k++) {
      const j = (n - k) % n;
      reB[k] = (reA[k] + reA[j]) / 2;
      imB2[k] = (imA[k] - imA[j]) / 2;
      reC[k] = (imA[k] + imA[j]) / 2;
      imC[k] = -(reA[k] - reA[j]) / 2;
    }
    logMag(spectra[0], reB, imB2);
    const recycled = flux(t, spectra[0]);
    spectra[0] = recycled;
    if (t + 1 < frames) {
      logMag(spectra[1], reC, imC);
      spectra[1] = flux(t + 1, spectra[1]);
    }
  }

  // Each band on its own scale (timbre), with a floor so a silent band's noise is not blown up.
  const p98 = bands.map((band, b) => {
    for (let t = 0; t < frames; t++) band[t] /= binsPerBand[b] || 1;
    return percentile(band, 0.98);
  });
  const loudest = Math.max(...p98, 1e-9);
  const env = new Float32Array(frames);
  bands.forEach((band, b) => {
    const denom = Math.max(p98[b], loudest * 0.2, 1e-9);
    for (let t = 0; t < frames; t++) {
      band[t] /= denom;
      env[t] += band[t] / bandCount;
    }
  });
  return { env, bands, frameRate: sampleRate / HOP, frames };
}

/** Energy of FINE_HOP-sample blocks; summed over FINE_WIN blocks it places onsets on the attack. */
function fineEnergy(samples) {
  const blocks = new Float32Array(Math.ceil(samples.length / FINE_HOP));
  for (let b = 0; b < blocks.length; b++) {
    let sum = 0;
    const end = Math.min(samples.length, (b + 1) * FINE_HOP);
    for (let i = b * FINE_HOP; i < end; i++) sum += samples[i] * samples[i];
    blocks[b] = sum;
  }
  const energy = new Float32Array(blocks.length);
  let acc = 0;
  for (let b = 0; b < blocks.length; b++) {
    acc += blocks[b];
    if (b >= FINE_WIN) acc -= blocks[b - FINE_WIN];
    energy[b] = acc;
  }
  return { blocks, energy }; // energy[b] covers blocks b-FINE_WIN+1 … b
}

/**
 * Moves an onset found at frame resolution (~12 ms) onto its attack: the
 * steepest rise of the fine energy near it marks the hit; the attack starts at
 * the first 0.7 ms block before that which clearly rises above the level just
 * before the hit (4×). Then 1 ms earlier, so the section before ends in the
 * quiet — no more than that, or every section would start early.
 */
function placeOnAttack(frame, fine, sampleRate) {
  const { blocks, energy } = fine;
  const center = frame * HOP;
  const from = Math.max(1, Math.floor((center - 2 * HOP) / FINE_HOP));
  const to = Math.min(energy.length - 1, Math.ceil((center + FFT_SIZE / 2) / FINE_HOP));
  let best = from;
  let bestRise = -Infinity;
  for (let b = from; b <= to; b++) {
    const rise = energy[b] - energy[b - 1];
    if (rise > bestRise) {
      bestRise = rise;
      best = b;
    }
  }
  // the level just before the hit: the median of ~4–11 ms earlier
  const before = [];
  for (let b = Math.max(0, best - 16); b <= best - FINE_WIN - 2; b++) before.push(blocks[b]);
  before.sort((x, y) => x - y);
  const floor = before.length ? before[before.length >> 1] : 0;
  const threshold = floor * 4 + 1e-7 * FINE_HOP;
  let start = Math.max(0, best - FINE_WIN + 1);
  for (let b = Math.max(0, best - FINE_WIN - 1); b <= best; b++) {
    if (blocks[b] > threshold) {
      start = b;
      break;
    }
  }
  return Math.max(0, (start * FINE_HOP) / sampleRate - ATTACK_MARGIN_S);
}

/**
 * Candidate transients: peaks of the envelope above a local adaptive mean.
 * Returns [{ time, strength, band, frame }] sorted by time; strength ≈ 1 for
 * the strong hits of the song (95th percentile), up to 1.5.
 */
export function pickOnsets(samples, envelope, sampleRate = ANALYSIS_RATE) {
  const { env, bands, frames } = envelope;
  const smooth = new Float32Array(frames);
  for (let t = 0; t < frames; t++) smooth[t] = 0.25 * (env[t - 1] || 0) + 0.5 * env[t] + 0.25 * (env[t + 1] || 0);
  const prefix = new Float64Array(frames + 1);
  for (let t = 0; t < frames; t++) prefix[t + 1] = prefix[t] + smooth[t];
  const raw = [];
  for (let t = 0; t < frames - 1; t++) { // t = 0 too: a song that starts with a hit right away
    const v = smooth[t];
    if (v <= 0) continue;
    let isPeak = true;
    for (let d = 1; d <= PEAK_RADIUS && isPeak; d++) {
      if ((t - d >= 0 && smooth[t - d] >= v) || (t + d < frames && smooth[t + d] > v)) isPeak = false;
    }
    if (!isPeak) continue;
    const a = Math.max(0, t - MEAN_BEFORE);
    const b = Math.min(frames, t + MEAN_AFTER + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    const height = v - mean;
    if (height > 1e-4) raw.push({ frame: t, height });
  }
  if (!raw.length) return [];
  const scale = percentile(raw.map((r) => r.height), 0.95) || 1;
  const fine = fineEnergy(samples);
  return raw.map(({ frame, height }) => {
    let band = 0;
    for (let k = 1; k < bands.length; k++) if (bands[k][frame] > bands[band][frame]) band = k;
    return {
      time: placeOnAttack(frame, fine, sampleRate),
      strength: Math.min(1.5, height / scale),
      band,
      frame,
    };
  });
}

// ---- Tempo and bar grid ----------------------------------------------------------

/**
 * Global tempo from the autocorrelation of the novelty curve, weighted toward
 * 120 BPM (log-normal prior) so the octave picked is the one people count.
 * Returns { bpm, confidence }.
 */
export function estimateTempo(env, frameRate) {
  const n = env.length;
  let mean = 0;
  for (let t = 0; t < n; t++) mean += env[t];
  mean /= n || 1;
  const x = new Float64Array(n);
  for (let t = 0; t < n; t++) x[t] = Math.max(0, env[t] - mean);
  const minLag = Math.max(1, Math.floor((frameRate * 60) / 200));
  const maxLag = Math.min(n - 2, Math.ceil((frameRate * 60) / 55));
  if (maxLag <= minLag + 2) return { bpm: 120, confidence: 0 };
  const acf = new Float64Array(2 * maxLag + 2);
  let energy = 0;
  for (let t = 0; t < n; t++) energy += x[t] * x[t];
  for (let lag = minLag; lag < acf.length && lag < n; lag++) {
    let sum = 0;
    for (let t = 0; t + lag < n; t++) sum += x[t] * x[t + lag];
    acf[lag] = sum / (n - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  const score = (lag) => {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    return (acf[lag] + 0.5 * (acf[2 * lag] || 0)) * prior;
  };
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = score(lag);
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  // sub-frame lag: parabola through the neighbours
  let lagF = best;
  if (best > minLag && best < maxLag) {
    const a = score(best - 1);
    const c = score(best + 1);
    const denom = a - 2 * bestScore + c;
    if (denom < 0) lagF = best + (0.5 * (a - c)) / denom;
  }
  const zero = energy / (n || 1);
  return { bpm: (60 * frameRate) / lagF, confidence: zero > 0 ? Math.max(0, Math.min(1, acf[best] / zero)) : 0 };
}

function sampleAt(curve, f) {
  const i = Math.floor(f);
  if (i < 0 || i >= curve.length) return 0;
  const frac = f - i;
  return curve[i] * (1 - frac) + (i + 1 < curve.length ? curve[i + 1] : 0) * frac;
}

/**
 * Where the beats and bars fall: the phase that collects the most novelty on
 * the beat, and the downbeat, the beat of four with the most low end (kick).
 * Returns { beat, bar, origin } in seconds; origin ∈ [0, bar).
 */
export function beatGrid(envelope, bpm, onsets = []) {
  const { env, bands, frameRate } = envelope;
  const period = (60 * frameRate) / bpm;
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let phase = 0; phase < period; phase += 0.5) {
    let sum = 0;
    for (let f = phase; f < env.length; f += period) sum += sampleAt(env, f);
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = phase;
    }
  }
  const low = bands[0] && bands[1] ? bands[0].map((v, i) => v + bands[1][i]) : env;
  const perBeat = [0, 0, 0, 0];
  let k = 0;
  for (let f = bestPhase; f < env.length; f += period, k++) {
    perBeat[k % 4] += Math.max(sampleAt(low, f - 1), sampleAt(low, f), sampleAt(low, f + 1));
  }
  const beat = 60 / bpm;
  const bar = 4 * beat;
  // Bar 1 starts where the music does: the first real hit. Songs start on a downbeat far more often than the
  // strongest-bass guess below gets right, and a bar 1 that starts mid-music shifts every bar after it.
  const first = onsets.find((o) => o.strength >= FIRST_HIT_STRENGTH);
  if (first) return { beat, bar, origin: first.time };
  const down = perBeat.indexOf(Math.max(...perBeat));
  const origin = ((((bestPhase + down * period) / frameRate) % bar) + bar) % bar;
  return { beat, bar, origin };
}

/**
 * The tempo, exact: a least-squares line through the strong hits that fall on
 * beats (time = origin + k × beat). The autocorrelation is good to a few
 * tenths of a percent, which over a song adds up to beats; the fit is not.
 * Bar 1 stays on the beat of the music's first hit, on the fitted line.
 */
export function refineTempo(onsets, beat, origin) {
  const strong = onsets.filter((o) => o.strength >= TRACK_STRENGTH);
  let b = beat;
  let a = origin;
  // Progressive: fit the first 20 s, then 40, 80… With a tempo a few tenths off, a hit minutes later would be
  // counted on the wrong beat; a window that grows as the estimate improves never gets that far wrong.
  const span = strong.length ? strong[strong.length - 1].time - origin : 0;
  for (let window = 20; ; window *= 2) {
    for (let iter = 0; iter < 3; iter++) {
      let n = 0;
      let sk = 0;
      let st = 0;
      let skk = 0;
      let skt = 0;
      for (const o of strong) {
        if (Math.abs(o.time - origin) > window) continue;
        const k = Math.round((o.time - a) / b);
        if (Math.abs(o.time - (a + k * b)) > 0.12 * b) continue; // off the beat (syncopation): not for the fit
        n++;
        sk += k;
        st += o.time;
        skk += k * k;
        skt += k * o.time;
      }
      const den = n * skk - sk * sk;
      if (n < 8 || Math.abs(den) < 1e-9) break;
      const nb = (n * skt - sk * st) / den;
      if (!(nb > beat * 0.97 && nb < beat * 1.03)) break;
      a = (st - nb * sk) / n;
      b = nb;
    }
    if (window >= span) break;
  }
  const k0 = Math.round((origin - a) / b);
  return { beat: b, origin: a + k0 * b };
}

/**
 * The novelty curve for the tempo: the low end (kick, bass) weighs most, because it carries the pulse. With every
 * band normalized alike, hi-hats on all the 16ths look as periodic at 3/4 of a beat as the kick at one beat.
 */
function pulseEnvelope({ bands, env }) {
  if (!bands || bands.length < 5) return env;
  const weights = [2, 1.5, 1, 0.75, 0.75];
  const out = new Float32Array(env.length);
  for (let t = 0; t < env.length; t++) {
    let v = 0;
    for (let b = 0; b < 5; b++) v += weights[b] * bands[b][t];
    out[t] = v / 7;
  }
  return out;
}

/** Everything the view needs from the audio, computed once per song. */
export function analyze(samples, sampleRate = ANALYSIS_RATE) {
  const envelope = onsetEnvelope(samples, sampleRate);
  const onsets = pickOnsets(samples, envelope, sampleRate);
  let { bpm, confidence } = estimateTempo(pulseEnvelope(envelope), envelope.frameRate);
  if (!Number.isFinite(bpm) || bpm <= 0) bpm = 120;
  const grid = beatGrid(envelope, bpm, onsets);
  const fitted = refineTempo(onsets, grid.beat, grid.origin);
  bpm = 60 / fitted.beat;
  return {
    duration: samples.length / sampleRate,
    sampleRate,
    onsets,
    bpm,
    confidence,
    beat: fitted.beat,
    bar: 4 * fitted.beat,
    origin: fitted.origin,
  };
}

/**
 * The analysis with bar 1 moved to `origin` (seconds), where the user marked the start of the music; null keeps
 * the detected one. The grid (and so every grid cut) is counted from there. Cached per origin, with its own lines.
 */
export function withOrigin(analysis, origin) {
  if (origin == null || !Number.isFinite(origin)) return analysis;
  const o = Math.min(Math.max(0, origin), analysis.duration);
  const cache = analysis.originCache || (analysis.originCache = new Map());
  let view = cache.get(o);
  if (!view) {
    if (cache.size >= 8) cache.clear(); // dragging the marker makes a new one per frame
    view = { ...analysis, origin: o, originSet: true, lineCache: null, beatTimes: null, originCache: null };
    cache.set(o, view);
  }
  return view;
}

// ---- Cuts: sensitivity × grid ------------------------------------------------------

/** Minimum strength a transient needs at a sensitivity in [0, 1] (1 = even the faintest). */
export function thresholdFor(sensitivity) {
  const s = Math.min(1, Math.max(0, Number(sensitivity) || 0));
  return 1.05 * (1 - s) ** 1.6 + 0.01;
}

function firstAtOrAfter(onsets, time) {
  let lo = 0;
  let hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const TRACK_STRENGTH = 0.5; // hits strong enough to steer the beat grid
const SNAP_S = 0.015; // a grid cut moves onto a transient this close after it (never further)
const GUARD_S = 0.03; // …or back onto its own hit played up to this much early (the section must not end in its attack)
const GUARD_STRENGTH = 0.3; // hits this strong count for that guard even below the sensitivity
const FIRST_HIT_STRENGTH = 0.3; // the first onset this strong is where the music (and bar 1) starts
const LEAD_IN_S = 0.05; // a lead-in this short joins the first section instead of being one
const AUTO_BARS_CONFIDENCE = 0.15; // below this tempo confidence, Auto cuts at every transient (no bars)

/**
 * The beats of the song, following the music: starting from the detected
 * phase, each beat is pulled halfway toward the strong hit next to it, so a
 * tempo a little off does not drift over the song. Returns beat times from at
 * or before 0 to past the end, and which of them start a bar.
 */
export function trackBeats(analysis) {
  const beat = analysis.beat || 0.5;
  const strong = analysis.onsets.filter((o) => o.strength >= TRACK_STRENGTH);
  const tolerance = Math.min(beat * 0.4, 0.1);
  const origin = analysis.origin || 0;
  const times = [];
  const bars = [];
  // before bar 1: plain beats back to 0 (nothing to follow there); bar 1 itself sits exactly on the origin
  for (let k = Math.ceil(origin / beat); k >= 1; k--) {
    times.push(origin - k * beat);
    bars.push(k % 4 === 0);
  }
  let anchor = origin;
  let anchorIndex = 0;
  for (let n = 0; ; n++) {
    const line = anchor + (n - anchorIndex) * beat;
    times.push(line);
    bars.push(n % 4 === 0);
    if (line > analysis.duration + beat) break;
    let best = null;
    for (let i = firstAtOrAfter(strong, line - tolerance); i < strong.length && strong[i].time <= line + tolerance; i++) {
      if (!best || strong[i].strength > best.strength) best = strong[i];
    }
    if (best) {
      anchor = line + 0.5 * (best.time - line);
      anchorIndex = n;
    }
  }
  return { times, bars };
}

/**
 * Lines of a grid ("1" = bars … "64" = 64 per bar) over the tracked beats:
 * [{ time, bar }]. Coarser than a beat: every 4 / 2 beats from a downbeat;
 * finer: each beat split evenly.
 */
/** Bars per section for "2:1" … "32:1", else null. */
function barsPerSection(grid) {
  const m = /^(\d+):1$/.exec(String(grid));
  return m ? Number(m[1]) : null;
}

/** Length of one section of a grid, in seconds (null for "auto"). */
export function gridStep(analysis, grid) {
  const bar = analysis.bar || 4 * (analysis.beat || 0.5);
  const many = barsPerSection(grid);
  if (many) return bar * many;
  const div = Number(grid);
  return Number.isFinite(div) && div > 0 ? bar / div : null;
}

export function gridLines(analysis, grid) {
  // computed once per song and grid (the view asks for them on every frame while playing)
  const cache = analysis.lineCache || (analysis.lineCache = {});
  if (!cache[grid]) cache[grid] = computeGridLines(analysis, grid);
  return cache[grid];
}

function computeGridLines(analysis, grid) {
  const tracked = analysis.beatTimes ? analysis.beatTimes : (analysis.beatTimes = trackBeats(analysis));
  const { times, bars } = tracked;
  const many = barsPerSection(grid);
  if (many) {
    // every N bars, counted from bar 1 (where the music starts)
    const barTimes = times.filter((_, i) => bars[i]);
    const origin = analysis.origin || 0;
    let start = 0;
    barTimes.forEach((t, i) => {
      if (Math.abs(t - origin) < Math.abs(barTimes[start] - origin)) start = i;
    });
    return barTimes
      .map((time, i) => ({ time, bar: true, i }))
      .filter(({ i }) => (((i - start) % many) + many) % many === 0)
      .map(({ time }) => ({ time, bar: true }));
  }
  const div = Number(grid);
  if (!Number.isFinite(div) || div <= 0) return [];
  const lines = [];
  if (div <= 4) {
    const every = 4 / div;
    let sinceBar = 0;
    for (let i = 0; i < times.length; i++) {
      if (bars[i]) sinceBar = 0;
      if (sinceBar % every === 0) lines.push({ time: times[i], bar: bars[i] });
      sinceBar++;
    }
    return lines;
  }
  const parts = div / 4;
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i];
    const step = (times[i + 1] - a) / parts;
    for (let k = 0; k < parts; k++) lines.push({ time: a + k * step, bar: bars[i] && k === 0 });
  }
  return lines;
}

/**
 * Times where the song is cut:
 *  - "auto": bars first — every bar starts a section, and inside a bar a cut
 *    goes on each 1/16 line where a transient that passes the sensitivity is
 *    played (on its attack). Without a steady pulse: at every transient;
 *  - "1" … "64": on every line of that grid, so each section is a bar, half a
 *    bar … 1/64 long. A cut moves onto a transient (that passes the
 *    sensitivity) only when one is within 15 ms after it, and back onto one
 *    that starts up to 60 ms (≤ 30 % of a section) before it, so no section
 *    ends with the first samples of the next hit.
 */
export function detectCuts(analysis, { sensitivity = DEFAULT_SENSITIVITY, grid = "auto" } = {}) {
  const threshold = thresholdFor(sensitivity);
  const onsets = analysis.onsets.filter((o) => o.strength >= threshold);
  const duration = analysis.duration;
  const beat = analysis.beat || 0.5;
  const origin = analysis.origin || 0;
  // once the user marks where the music starts, what comes before it is a single lead-in section and bar 1 cuts
  // exactly on the mark (the detected start keeps the grid running back over the lead-in)
  const beforeMusic = (t) => analysis.originSet && t < origin - 1e-6;
  const isMarkedStart = (t) => analysis.originSet && Math.abs(t - origin) < 1e-6;
  const audible = analysis.onsets.filter((o) => o.strength >= Math.min(threshold, GUARD_STRENGTH));

  /**
   * Where a grid line really cuts: back onto a hit that starts a little before it (the section before must not end
   * with its attack), else onto a hit within 15 ms after it, else on the line.
   */
  const cutAt = (line, step) => {
    // the line's own hit: the nearest one played a little early (≤ 30 ms, any audible hit) or late (≤ 15 ms,
    // passing the sensitivity). Another sound further before the line (a hi-hat on the 16th before) is not its hit.
    const early = nearestOnset(audible, line, Math.min(GUARD_S, step * 0.25));
    const late = nearestOnset(onsets, line, Math.min(SNAP_S, step / 4));
    const own = [early && early.time <= line ? early : null, late].filter(Boolean);
    if (!own.length) return line;
    return own.reduce((x, y) => (Math.abs(y.time - line) < Math.abs(x.time - line) ? y : x)).time;
  };
  const cuts = [];
  const push = (t) => {
    if (t > MIN_SECTION_S && t < duration - MIN_SECTION_S && (!cuts.length || t - cuts[cuts.length - 1] > MIN_SECTION_S)) cuts.push(t);
  };

  if (grid === "auto" || !GRIDS.includes(String(grid))) {
    if ((analysis.confidence ?? 1) < AUTO_BARS_CONFIDENCE || !analysis.bar) {
      // no steady pulse to hang bars on: a cut at every transient
      const minGap = Math.max(0.06, (beat / 4) * 0.6);
      const kept = [];
      for (const o of onsets) {
        const last = kept[kept.length - 1];
        if (last && o.time - last.time < minGap) {
          if (o.strength > last.strength) kept[kept.length - 1] = o;
        } else {
          kept.push(o);
        }
      }
      const times = kept.map((o) => o.time).filter((t) => !beforeMusic(t) && (!analysis.originSet || t - origin > MIN_SECTION_S));
      if (analysis.originSet) times.unshift(origin);
      return times.filter((t) => t > MIN_SECTION_S && t < duration - MIN_SECTION_S);
    }
    // Bars first: the whole song is marked in bars and every bar starts a section; inside a bar, a cut goes on
    // each 1/16 line where a transient (that passes the sensitivity) is played, on its attack.
    const step = gridStep(analysis, "16");
    for (const line of gridLines(analysis, "16")) {
      if (line.time <= LEAD_IN_S || line.time >= duration - MIN_SECTION_S || beforeMusic(line.time)) continue;
      if (line.bar) {
        push(isMarkedStart(line.time) ? line.time : cutAt(line.time, step));
        continue;
      }
      const lo = firstAtOrAfter(onsets, line.time - Math.min(GUARD_S, step * 0.3));
      const played = lo < onsets.length && onsets[lo].time <= line.time + step / 2;
      if (played) push(cutAt(line.time, step));
    }
    return cuts;
  }
  const step = gridStep(analysis, grid);
  for (const { time: line } of gridLines(analysis, grid)) {
    if (line <= LEAD_IN_S || line >= duration - MIN_SECTION_S || beforeMusic(line)) continue; // the song's own edges are not cuts
    push(isMarkedStart(line) ? line : cutAt(line, step));
  }
  return cuts;
}

// ---- Sections and the user's edits ------------------------------------------------
// edits = { pinned: [t], suppressed: [t], start: t|null, end: t|null, links: [{ from, to }], origin: t|null }
//   pinned: dividers the user placed or dragged (they survive a new detection);
//   suppressed: automatic cuts the user dragged away or removed;
//   start/end: the song trimmed at either edge;
//   links: where each dragged automatic cut came from (to put it back on a reset);
//   origin: where the user marked the start of the music (bar 1; null = the detected one).

export function emptyEdits() {
  return { pinned: [], suppressed: [], start: null, end: null, links: [], origin: null };
}

function cloneEdits(edits) {
  return {
    ...emptyEdits(),
    ...edits,
    pinned: [...(edits.pinned || [])],
    suppressed: [...(edits.suppressed || [])],
    links: (edits.links || []).map((l) => ({ ...l })),
  };
}

const same = (a, b) => Math.abs(a - b) < 1e-6;

const near = (list, t, tol) => list.some((x) => Math.abs(x - t) < tol);

/**
 * Dividers and sections from the automatic cuts and the edits.
 * dividers: [{ time, kind: "start" | "end" | "auto" | "pinned" }] in order;
 * sections: [{ index, start, end, key }] between consecutive dividers; key
 * (the start in ms) identifies a section across recomputations.
 */
export function buildSections({ duration, cuts = [], edits = emptyEdits() }) {
  const start = Math.min(Math.max(0, edits.start ?? 0), duration);
  const end = Math.max(start, Math.min(duration, edits.end ?? duration));
  const pinned = edits.pinned || [];
  const suppressed = edits.suppressed || [];
  const inner = [
    ...cuts.filter((t) => !near(suppressed, t, 0.002) && !near(pinned, t, PIN_SHADOW_S)).map((time) => ({ time, kind: "auto" })),
    ...pinned.map((time) => ({ time, kind: "pinned" })),
  ]
    .filter((d) => d.time > start + MIN_SECTION_S && d.time < end - MIN_SECTION_S)
    .sort((a, b) => a.time - b.time);
  const dividers = [{ time: start, kind: "start" }];
  for (const d of inner) {
    if (d.time - dividers[dividers.length - 1].time >= MIN_SECTION_S) dividers.push(d);
  }
  dividers.push({ time: end, kind: "end" });
  const sections = [];
  for (let i = 0; i + 1 < dividers.length; i++) {
    const s = dividers[i].time;
    sections.push({ index: i, start: s, end: dividers[i + 1].time, key: sectionKey(s) });
  }
  return { dividers, sections };
}

export function sectionKey(start) {
  return Math.round(start * 1000);
}

/** The edits after dragging a divider to a new time (clamped by the caller between its neighbours). */
export function moveDivider(edits, divider, time) {
  const next = cloneEdits(edits);
  if (divider.kind === "start") next.start = time;
  else if (divider.kind === "end") next.end = time;
  else if (divider.kind === "auto") {
    next.suppressed.push(divider.time);
    next.pinned.push(time);
    next.links.push({ from: divider.time, to: time });
  } else {
    const i = next.pinned.findIndex((t) => same(t, divider.time));
    if (i >= 0) next.pinned[i] = time;
    else next.pinned.push(time);
    const link = next.links.find((l) => same(l.to, divider.time));
    if (link) link.to = time;
  }
  return next;
}

/** The edits without a divider (an edge goes back to the start or end of the song). */
export function removeDivider(edits, divider) {
  const next = cloneEdits(edits);
  if (divider.kind === "start") next.start = null;
  else if (divider.kind === "end") next.end = null;
  else if (divider.kind === "auto") next.suppressed.push(divider.time);
  else {
    next.pinned = next.pinned.filter((t) => !same(t, divider.time));
    next.links = next.links.filter((l) => !same(l.to, divider.time)); // its original cut stays removed
  }
  return next;
}

export function addDivider(edits, time) {
  const next = cloneEdits(edits);
  next.pinned.push(time);
  return next;
}

/** Puts one divider back as detected: a dragged cut returns to its transient, one the user added goes away. */
function restoreDivider(next, divider) {
  if (divider.kind === "start") next.start = null;
  else if (divider.kind === "end") next.end = null;
  else if (divider.kind === "pinned") {
    next.pinned = next.pinned.filter((t) => !same(t, divider.time));
    const link = next.links.find((l) => same(l.to, divider.time));
    if (link) {
      next.links = next.links.filter((l) => l !== link);
      next.suppressed = next.suppressed.filter((t) => !same(t, link.from));
    }
  }
}

/** Automatic cuts the user removed (not dragged) strictly inside (a, b). */
const removedInside = (edits, a, b) =>
  (edits.suppressed || []).filter((t) => t > a && t < b && !(edits.links || []).some((l) => same(l.from, t)));

/** Whether section `index` (of these dividers) differs from what the detection gave. */
export function isSectionEdited(edits, dividers, index) {
  const a = dividers[index];
  const b = dividers[index + 1];
  if (!a || !b) return false;
  const edited = (d) => d.kind === "pinned" || (d.kind === "start" && edits.start != null) || (d.kind === "end" && edits.end != null);
  return edited(a) || edited(b) || removedInside(edits, a.time, b.time).length > 0;
}

/**
 * The edits with section `index` back to its original size: both of its
 * dividers as detected (or the song's edges) and the cuts removed inside it back.
 */
export function resetSection(edits, dividers, index) {
  const a = dividers[index];
  const b = dividers[index + 1];
  const next = cloneEdits(edits);
  if (!a || !b) return next;
  const inside = removedInside(next, a.time, b.time);
  next.suppressed = next.suppressed.filter((t) => !inside.includes(t));
  restoreDivider(next, a);
  restoreDivider(next, b);
  return next;
}

/** The edits with a section cut into `parts` equal parts (dividers the user owns). */
export function splitSection(edits, section, parts = 2) {
  const next = cloneEdits(edits);
  const len = section.end - section.start;
  for (let k = 1; k < parts; k++) next.pinned.push(section.start + (len * k) / parts);
  return next;
}

/**
 * The edits with section `index` `factor` times as long: the dividers it now covers go away and its end lands at
 * start + factor × length (or at the song's end).
 */
export function multiplySection(edits, dividers, index, duration, factor = 2) {
  const a = dividers[index];
  const b = dividers[index + 1];
  let next = cloneEdits(edits);
  if (!a || !b) return next;
  const target = a.time + (b.time - a.time) * factor;
  const reach = Math.min(target, duration);
  for (const d of dividers) {
    if (d.kind === "start" || d.kind === "end") continue;
    if (d.time > a.time + 1e-9 && d.time < reach - MIN_SECTION_S) next = removeDivider(next, d);
  }
  const last = dividers[dividers.length - 1];
  if (target >= last.time - MIN_SECTION_S) {
    // past the (trimmed) end: the end moves out, up to the song's
    if (last.kind === "end" && edits.end != null) next.end = target >= duration - MIN_SECTION_S ? null : target;
  } else if (!dividers.some((d) => Math.abs(d.time - target) < 0.001)) {
    next.pinned.push(target);
  }
  return next;
}

/** The candidate transient closest to a time, within maxDistance seconds (for snapping), or null. */
export function nearestOnset(onsets, time, maxDistance) {
  const i = firstAtOrAfter(onsets, time);
  let best = null;
  for (const o of [onsets[i - 1], onsets[i]]) {
    if (o && Math.abs(o.time - time) <= maxDistance && (!best || Math.abs(o.time - time) < Math.abs(best.time - time))) best = o;
  }
  return best;
}

// ---- Fades ------------------------------------------------------------------------
// fade = { in, inCurve, out, outCurve }: lengths in seconds, curves in [-1, 1].
// The gain over a fade is x^p, x going 0 → 1 toward full volume (fade-in: from
// the start; fade-out: toward the end), p = 4^-curve: curve > 0 is aggressive
// (convex: loud almost all the way, abrupt at the edge), < 0 is soft (concave,
// a gentle long tail), 0 is linear. The backend applies the same formula.

export function emptyFade() {
  return { in: 0, inCurve: 0, out: 0, outCurve: 0 };
}

export function fadePower(curve) {
  return 4 ** -Math.min(1, Math.max(-1, Number(curve) || 0));
}

export function fadeGain(x, curve) {
  const v = Math.min(1, Math.max(0, x));
  return v ** fadePower(curve);
}

/** The fade fitted to a section of `length` seconds: never negative, fade-in + fade-out ≤ length. */
export function fitFade(fade, length) {
  const f = { ...emptyFade(), ...(fade || {}) };
  const len = Math.max(0, length);
  f.in = Math.min(Math.max(0, f.in), len);
  f.out = Math.min(Math.max(0, f.out), len - f.in);
  f.inCurve = Math.min(1, Math.max(-1, f.inCurve));
  f.outCurve = Math.min(1, Math.max(-1, f.outCurve));
  return f;
}

export function hasFade(fade) {
  return Boolean(fade && (fade.in > 0 || fade.out > 0));
}

/** Gain at `t` seconds into a section of `length` seconds. */
export function fadeGainAt(fade, t, length) {
  if (!fade) return 1;
  let g = 1;
  if (fade.in > 0 && t < fade.in) g *= fadeGain(t / fade.in, fade.inCurve);
  if (fade.out > 0 && t > length - fade.out) g *= fadeGain((length - t) / fade.out, fade.outCurve);
  return g;
}

/**
 * A copy of the samples with the section's fades applied (for listening); declick: also the short anti-click
 * ramps at both edges, as the saved file has them.
 */
export function applyFades(samples, sampleRate, fade, { declick = false } = {}) {
  const out = Float32Array.from(samples);
  if (declick) {
    const a = Math.min(out.length, Math.round(DECLICK_IN_S * sampleRate));
    for (let i = 0; i < a; i++) out[i] *= i / a;
    const b = Math.min(out.length, Math.round(DECLICK_OUT_S * sampleRate));
    for (let i = 0; i < b; i++) out[out.length - 1 - i] *= i / b;
  }
  const f = fitFade(fade, samples.length / sampleRate);
  const length = samples.length / sampleRate;
  const inEnd = Math.min(out.length, Math.ceil(f.in * sampleRate));
  for (let i = 0; i < inEnd; i++) out[i] *= fadeGain(i / sampleRate / f.in, f.inCurve);
  const outStart = Math.max(0, Math.floor((length - f.out) * sampleRate));
  if (f.out > 0) for (let i = outStart; i < out.length; i++) out[i] *= fadeGain((length - i / sampleRate) / f.out, f.outCurve);
  return out;
}

// ---- Waveform peaks -----------------------------------------------------------------

/** min/max of every `size` samples; levels of these let any zoom draw in O(width). */
export function buildPeakLevel(samples, size) {
  const count = Math.ceil(samples.length / size);
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    let lo = 1;
    let hi = -1;
    const end = Math.min(samples.length, (b + 1) * size);
    for (let i = b * size; i < end; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { size, min, max };
}

export function buildPeaks(samples) {
  return [buildPeakLevel(samples, 64), buildPeakLevel(samples, 1024)];
}

/**
 * min/max per pixel column for the samples [from, from + perPixel·width).
 * Returns Float32Array [min0, max0, min1, max1, …].
 */
export function columnPeaks(samples, levels, from, perPixel, width) {
  const out = new Float32Array(width * 2);
  const level = [...levels].reverse().find((l) => perPixel >= l.size * 2) || null;
  for (let x = 0; x < width; x++) {
    const a = Math.max(0, Math.floor(from + x * perPixel));
    const b = Math.min(samples.length, Math.max(a + 1, Math.floor(from + (x + 1) * perPixel)));
    let lo = 0;
    let hi = 0;
    if (a < samples.length) {
      lo = 1;
      hi = -1;
      if (level) {
        const end = Math.min(level.min.length, Math.ceil(b / level.size));
        for (let i = Math.floor(a / level.size); i < end; i++) {
          if (level.min[i] < lo) lo = level.min[i];
          if (level.max[i] > hi) hi = level.max[i];
        }
      } else {
        for (let i = a; i < b; i++) {
          const v = samples[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (lo > hi) lo = hi = 0;
    }
    out[2 * x] = lo;
    out[2 * x + 1] = hi;
  }
  return out;
}

/** "1:23.456" / "0:07.12" for the time readouts. */
export function formatTime(seconds, digits = 2) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(digits).padStart(digits ? digits + 3 : 2, "0");
  return `${m}:${rest}`;
}
