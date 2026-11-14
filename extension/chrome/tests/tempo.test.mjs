import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, detectCuts, gridStep } from "../src/lib/transients.js";
import { GENRES, makeSong } from "./songs.mjs";

// The tempo people count, in each common genre: a half-time groove (kicks every half bar, trap, dubstep) is still 138
// or 140, a drum & bass break 174, hip-hop 90 and a ballad 72 — never the half, the double or 2/3 of it.
for (const genre of Object.keys(GENRES)) {
  test(`tempo: ${genre} at ${GENRES[genre].bpm} BPM, exact, on a clean take and a loose, noisy one with an intro`, () => {
    for (const options of [{ seed: 1 }, { seed: 5, bpm: GENRES[genre].bpm + 3.4, intro: 9, jitter: 0.01, noise: 0.05 }]) {
      const song = makeSong(genre, { bars: 12, ...options });
      const a = analyze(song.samples);
      const err = Math.abs(a.bpm - song.bpm) / song.bpm;
      assert.ok(err < 0.003, `${genre}: ${a.bpm.toFixed(2)} BPM, not ${song.bpm}`);
      assert.ok(Math.abs(a.origin - song.start) < 0.01, `${genre}: bar 1 at ${a.origin.toFixed(3)}, the drums at ${song.start}`);
      // 4:1 is four bars of that tempo, from where the drums come in
      const cuts = detectCuts(a, { sensitivity: 0.5, grid: "4:1" }).filter((t) => t > song.start - 0.05);
      if (song.start < 0.05) cuts.unshift(0); // the start of the song is not a cut
      const bar = (4 * 60) / song.bpm;
      assert.ok(Math.abs(gridStep(a, "4:1") - 4 * bar) < 4 * bar * 0.003);
      assert.ok(Math.abs(cuts[0] - song.start) < 0.01 && Math.abs(cuts[1] - cuts[0] - 4 * bar) < 0.03, `${genre}: 4:1 cuts ${cuts.slice(0, 3)}`);
    }
  });
}

test("tempo: a noise that starts out of digital silence long before the music is not bar 1", () => {
  const song = makeSong("reggaeton", { bars: 12, bpm: 102, seed: 9, intro: 12, noise: 0.05 });
  const a = analyze(song.samples);
  assert.ok(Math.abs(a.origin - 12) < 0.01, `bar 1 at ${a.origin.toFixed(3)}`);
  assert.ok(Math.abs(a.bpm - 102) < 0.3, `${a.bpm.toFixed(2)} BPM`);
});

// The grid never drifts: at the last beat of a long song it is as exact as at the first, through a breakdown, at an
// odd tempo — a fixed grid like a DJ player's. A band whose tempo moves gets a dynamic grid that follows it.
import { gridLines } from "../src/lib/transients.js";

function worstBeatError(song, a) {
  const lines = gridLines(a, "4").map((l) => l.time);
  let worst = 0;
  for (const t of song.beats) {
    let best = Infinity;
    for (const x of lines) best = Math.min(best, Math.abs(x - t));
    worst = Math.max(worst, best);
  }
  return worst;
}

for (const [name, genre, options, dynamic, limit] of [
  ["a long song (96 bars), loose", "house", { bars: 96, jitter: 0.006, seed: 3 }, false, 0.005],
  ["16 bars of breakdown without drums, then the drop", "melodic", { bars: 80, breakdown: [32, 48], jitter: 0.006, noise: 0.03, seed: 4 }, false, 0.005],
  ["an odd tempo (128.37)", "techno", { bars: 96, bpm: 128.37, seed: 5 }, false, 0.005],
  ["a band speeding up 3 %", "pop", { bars: 64, drift: 0.03, jitter: 0.008, seed: 6 }, true, 0.012],
  ["a band slowing down 2 %", "hiphop", { bars: 48, drift: -0.02, jitter: 0.008, seed: 7 }, true, 0.012],
]) {
  test(`grid: ${name} — every beat on the grid, to the end`, () => {
    const song = makeSong(genre, options);
    const a = analyze(song.samples);
    assert.equal(a.tempo.dynamic, dynamic, dynamic ? "a dynamic grid" : "a fixed grid");
    const worst = worstBeatError(song, a);
    assert.ok(worst < limit, `a beat ${(worst * 1000).toFixed(1)} ms off the grid`);
  });
}
