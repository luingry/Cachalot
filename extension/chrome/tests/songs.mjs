// Synthetic songs in the common genres, at the tempo people (and Beatport, DJ software…) give for them. Used by the
// tempo tests: the beat a listener counts, not just any periodicity of the drums (a half-time groove repeats every two
// beats, a 3-3-2 rhythm every three eighths, yet the song is still 138 or 95 BPM).
import { ANALYSIS_RATE } from "../src/lib/transients.js";

const SR = ANALYSIS_RATE;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

// 16 steps per bar. Velocities 0…1; a step string like "x...x...x...x..." (x = 1, o = 0.6, . = rest).
function steps(pattern) {
  return [...pattern].map((c) => (c === "x" ? 1 : c === "o" ? 0.6 : c === "-" ? 0.3 : 0));
}

export const GENRES = {
  house: {
    bpm: 124,
    kick: "x...x...x...x...",
    clap: "....x.......x...",
    openHat: "..x...x...x...x.",
    hat: "-.-.-.-.-.-.-.-.",
    bass: "..x...x...x...x.",
  },
  techno: {
    bpm: 132,
    kick: "x...x...x...x...",
    hat: "..x...x...x...x.",
    perc: "...o.......o..o.",
    bass: ".-o..-o..-o..-o.",
  },
  trance: {
    bpm: 140,
    kick: "x...x...x...x...",
    openHat: "..x...x...x...x.",
    clap: "....x.......x...",
    bass: ".oo..oo..oo..oo.",
  },
  // like Öspiel - The Second Before: kicks every half bar, a 3-3-2 bass and claps, hats on the 16ths
  melodic: {
    bpm: 138,
    kick: "x.......x.......",
    bass: "x..o..o.x..o..o.",
    clap: "....x.......x...",
    hat: "-.--.--.-.--.--.",
    perc: "......o.......o.",
  },
  dubstep: {
    bpm: 140,
    kick: "x.........x.....",
    snare: "........x.......",
    hat: "x.x.x.x.x.x.x.x.",
    bass: "x.....o...x.....",
  },
  dnb: {
    bpm: 174,
    kick: "x.........x.....",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    bass: "x.....o...x.....",
  },
  hiphop: {
    bpm: 90,
    kick: "x......x..x.....",
    snare: "....x.......x...",
    hat: "x.o.x.o.x.o.x.o.",
    swing: 0.12,
  },
  trap: {
    bpm: 140,
    kick: "x..........x....",
    snare: "........x.......",
    hat: "x-x-x-x-x-xxx-x-",
    bass: "x..........x....",
  },
  reggaeton: {
    bpm: 95,
    kick: "x...x...x...x...",
    snare: "...x..x....x..x.",
    hat: "x.x.x.x.x.x.x.x.",
  },
  pop: {
    bpm: 100,
    kick: "x.......x.x.....",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    bass: "x.......x.x.....",
  },
  ballad: {
    bpm: 72,
    kick: "x.........x.....",
    snare: "....x.......x...",
    hat: "x...x...x...x...",
    bass: "x.......x.......",
  },
};

/**
 * One song of `genre`: `intro` seconds of pad alone, then `bars` bars of the groove (with the pad), a little timing
 * and velocity humanisation (`jitter`: ± seconds on each hit, a third of it on the kick; `noise`: hiss level).
 * `drift`: the tempo moves by this fraction from the first bar to the last (a band without a click);
 * `breakdown`: [from, to) bars with no drums. Returns { samples, bpm, start, beats } (start: where the drums come in;
 * beats: the time of every beat).
 */
export function makeSong(genre, { bars = 24, intro = 0, seed = 1, bpm, jitter = 0.003, noise: hiss = 0, drift = 0, breakdown = null } = {}) {
  const g = GENRES[genre];
  const tempo = bpm || g.bpm;
  const start = intro;
  const barStarts = [start];
  for (let bar = 0; bar < bars; bar++) barStarts.push(barStarts[bar] + 4 * (60 / (tempo * (1 + (drift * bar) / Math.max(1, bars - 1)))));
  const beats = [];
  for (let bar = 0; bar < bars; bar++) for (let k = 0; k < 4; k++) beats.push(barStarts[bar] + (k * (barStarts[bar + 1] - barStarts[bar])) / 4);
  const length = Math.ceil((barStarts[bars] + 1) * SR);
  const out = new Float32Array(length);
  const noise = rng(seed * 7919);
  const timing = rng(seed * 104729);
  const level = rng(seed * 15485863);
  const add = (t, dur, fn) => {
    const a = Math.round(t * SR);
    for (let i = 0; i < dur * SR && a + i < length; i++) if (a + i >= 0) out[a + i] += fn(i / SR);
  };
  // pad: a soft chord all along, no attacks
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    const fade = Math.min(1, t / 2);
    out[i] = hiss * noise() + 0.04 * fade * (Math.sin(2 * Math.PI * 220 * t) + 0.7 * Math.sin(2 * Math.PI * 277.2 * t) + 0.6 * Math.sin(2 * Math.PI * 329.6 * t));
  }
  const voices = {
    kick: (v) => (x) => 0.9 * v * Math.exp(-x * 14) * Math.sin(2 * Math.PI * (48 + 110 * Math.exp(-x * 35)) * x),
    snare: (v) => {
      let prev = 0;
      return (x) => {
        const n = noise();
        const hp = n - 0.6 * prev;
        prev = n;
        return v * (0.5 * Math.exp(-x * 22) * hp + 0.25 * Math.exp(-x * 30) * Math.sin(2 * Math.PI * 190 * x));
      };
    },
    clap: (v) => {
      let prev = 0;
      return (x) => {
        const n = noise();
        const hp = n - 0.8 * prev;
        prev = n;
        return 0.45 * v * Math.exp(-x * 28) * hp;
      };
    },
    hat: (v) => {
      let prev = 0;
      return (x) => {
        const n = noise();
        const hp = n - prev;
        prev = n;
        return 0.16 * v * Math.exp(-x * 90) * hp;
      };
    },
    openHat: (v) => {
      let prev = 0;
      return (x) => {
        const n = noise();
        const hp = n - prev;
        prev = n;
        return 0.14 * v * Math.exp(-x * 14) * hp;
      };
    },
    perc: (v) => (x) => 0.3 * v * Math.exp(-x * 35) * Math.sin(2 * Math.PI * 420 * x),
    bass: (v) => (x) => 0.35 * v * Math.min(1, x * 400) * Math.exp(-x * 9) * Math.sin(2 * Math.PI * 55 * x),
  };
  const lengths = { kick: 0.35, snare: 0.2, clap: 0.2, hat: 0.06, openHat: 0.25, perc: 0.12, bass: 0.25 };
  for (let bar = 0; bar < bars; bar++) {
    if (breakdown && bar >= breakdown[0] && bar < breakdown[1]) continue;
    const sixteenth = (barStarts[bar + 1] - barStarts[bar]) / 16;
    for (const [voice, pattern] of Object.entries(g)) {
      if (!voices[voice]) continue;
      steps(pattern).forEach((v, k) => {
        if (!v) return;
        const swing = g.swing && k % 2 === 1 ? g.swing * sixteenth * 2 : 0;
        const t = barStarts[bar] + k * sixteenth + swing + (voice === "kick" ? jitter * 0.3 : jitter) * timing();
        add(t, lengths[voice], voices[voice](v * (0.9 + 0.1 * level())));
      });
    }
  }
  return { samples: out, bpm: tempo, start, beats };
}
