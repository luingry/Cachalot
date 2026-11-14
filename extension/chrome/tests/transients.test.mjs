import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_RATE,
  addDivider,
  analyze,
  applyFades,
  fadeGain,
  fadeGainAt,
  fitFade,
  gridLines,
  gridStep,
  buildPeaks,
  buildSections,
  columnPeaks,
  detectCuts,
  emptyEdits,
  formatTime,
  isSectionEdited,
  moveDivider,
  multiplySection,
  nearestOnset,
  pcm16ToFloat,
  removeDivider,
  resetSection,
  splitSection,
  thresholdFor,
  withOrigin,
} from "../src/lib/transients.js";

const SR = ANALYSIS_RATE;

/** Deterministic noise so the tests never flake. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/**
 * Drum loop: kick on every beat, snare on 2 and 4, closed hat on the 8ths
 * (quiet), a soft pad underneath. Starts after `lead` seconds of near silence.
 */
function drumLoop({ bpm = 120, bars = 8, lead = 0.37 } = {}) {
  const beat = 60 / bpm;
  const length = Math.ceil((lead + bars * 4 * beat + 1) * SR);
  const out = new Float32Array(length);
  const noise = rng(7);
  for (let i = 0; i < length; i++) out[i] = 0.02 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.002 * noise();
  const add = (t, dur, fn) => {
    const a = Math.round(t * SR);
    for (let i = 0; i < dur * SR && a + i < length; i++) out[a + i] += fn(i / SR);
  };
  const kicks = [];
  const hats = [];
  for (let b = 0; b < bars * 4; b++) {
    const t = lead + b * beat;
    kicks.push(t);
    add(t, 0.25, (x) => 0.8 * Math.exp(-x * 18) * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-x * 40)) * x));
    if (b % 4 === 1 || b % 4 === 3) add(t, 0.18, (x) => 0.45 * Math.exp(-x * 25) * noise());
    for (const h of [0, 0.5]) {
      const th = t + h * beat;
      hats.push(th);
      let prev = 0;
      add(th, 0.05, (x) => {
        const n = noise();
        const hp = n - prev; // crude high-pass: hats live up top
        prev = n;
        return 0.18 * Math.exp(-x * 90) * hp;
      });
    }
  }
  return { samples: out, kicks, hats, beat, lead, bars };
}

test("pcm16ToFloat reads little-endian s16", () => {
  const buf = new Int16Array([0, 16384, -32768, 32767]).buffer;
  const f = pcm16ToFloat(buf);
  assert.deepEqual([...f].map((v) => Math.round(v * 1000) / 1000), [0, 0.5, -1, 1]);
  assert.equal(pcm16ToFloat(new Uint8Array([1, 0, 2]).buffer).length, 1); // odd byte dropped
});

test("analysis finds the tempo and places kicks on their attack", () => {
  const loop = drumLoop();
  const started = Date.now();
  const a = analyze(loop.samples);
  const elapsed = Date.now() - started;
  assert.ok(Math.abs(a.bpm - 120) < 2, `bpm ${a.bpm}`);
  assert.ok(Math.abs(a.duration - loop.samples.length / SR) < 1e-9);
  for (const k of loop.kicks) {
    const o = nearestOnset(a.onsets, k, 0.03);
    assert.ok(o, `no onset near kick at ${k.toFixed(3)}`);
    assert.ok(Math.abs(o.time - k) < 0.008, `kick ${k.toFixed(3)} placed at ${o.time.toFixed(4)}`);
    assert.ok(o.time <= k + 0.004, "a slice must not start after the hit");
  }
  // bar origin lands on a kick (downbeat), modulo the bar
  const bar = 4 * loop.beat;
  const offset = ((((a.origin - loop.lead) % bar) + bar) % bar);
  assert.ok(Math.min(offset, bar - offset) < 0.03, `origin ${a.origin} vs lead ${loop.lead}`);
  assert.ok(elapsed < 3000, `analysis took ${elapsed} ms`);
});

test("sensitivity filters the faint transients (hats) out", () => {
  const loop = drumLoop();
  const a = analyze(loop.samples);
  const many = detectCuts(a, { sensitivity: 0.95, grid: "auto" });
  const few = detectCuts(a, { sensitivity: 0.15, grid: "auto" });
  assert.ok(many.length >= loop.hats.length * 0.9, `high sensitivity kept ${many.length} of ${loop.hats.length} hits`);
  assert.ok(few.length < many.length, `${few.length} >= ${many.length}`);
  assert.ok(few.length >= loop.kicks.length * 0.5, `low sensitivity still keeps the kicks (${few.length})`);
  assert.ok(thresholdFor(0) > thresholdFor(0.5) && thresholdFor(0.5) > thresholdFor(1));
});

test("a grid makes every section that long, starting on the attacks", () => {
  const loop = drumLoop();
  const a = analyze(loop.samples);
  const bar = 4 * loop.beat;
  for (const [grid, sensitivity] of [["1", 0.2], ["2", 0.5], ["4", 0.9], ["8", 0.5], ["16", 0.5], ["32", 0.5], ["64", 0.5]]) {
    const step = bar / Number(grid);
    const cuts = detectCuts(a, { sensitivity, grid });
    // every inner section has the grid's length (± the 15 ms a cut may move onto an attack)
    for (let i = 1; i < cuts.length; i++) {
      const len = cuts[i] - cuts[i - 1];
      assert.ok(Math.abs(len - step) <= Math.min(0.015, step / 4) * 2 + 0.004, `grid 1:${grid}: section ${i} is ${len.toFixed(4)} s, not ${step} s`);
    }
    // and the grid covers the song from the first line to the end
    assert.ok(cuts[0] < Math.max(step, 0.05) + 0.02 && cuts[cuts.length - 1] > a.duration - step - 0.02, `grid 1:${grid} covers the song`);
  }
  // the bar lines land on the kicks that start each bar, on their attack
  const bars = detectCuts(a, { sensitivity: 0.5, grid: "1" });
  for (const t of loop.kicks.filter((_, i) => i % 4 === 0)) {
    assert.ok(bars.some((c) => Math.abs(c - t) < 0.008 && c <= t + 0.004), `no bar cut on the kick at ${t.toFixed(3)}`);
  }
  // the grid size does not depend on the sensitivity
  assert.equal(detectCuts(a, { sensitivity: 0.05, grid: "4" }).length, detectCuts(a, { sensitivity: 1, grid: "4" }).length);
});

test("2:1 … 32:1 make sections of several bars, from where the music starts", () => {
  const loop = drumLoop({ bars: 16 });
  const a = analyze(loop.samples);
  const bar = 4 * loop.beat;
  for (const n of [2, 4, 8]) {
    const cuts = detectCuts(a, { sensitivity: 0.5, grid: `${n}:1` });
    assert.ok(cuts.some((c) => Math.abs(c - loop.lead) < 0.01), `${n}:1 starts on the first bar: ${cuts}`);
    for (let i = 1; i < cuts.length; i++) assert.ok(Math.abs(cuts[i] - cuts[i - 1] - n * bar) < 0.03, `${n}:1 section ${i}`);
  }
  assert.equal(gridStep(a, "4:1"), 4 * a.bar);
  assert.equal(gridStep(a, "4"), a.bar / 4);
  assert.equal(gridStep(a, "auto"), null);
});

test("listening copies get the same anti-click ramps as the saved file", () => {
  const ones = new Float32Array(1000).fill(1);
  const d = applyFades(ones, 10000, null, { declick: true });
  assert.equal(d[0], 0);
  assert.equal(d[999], 0);
  assert.ok(d[10] > 0.4 && d[10] < 0.6, "2 ms ramp in");
  assert.equal(d[500], 1);
  assert.equal(applyFades(ones, 10000, null)[0], 1, "only when asked");
});

test("bar 1 starts with the music, so the first section is a full bar like the others", () => {
  // A song whose bass is loudest on beat 3 (the old guess put bar 1 there) and that starts right at 0.
  const beat = 0.5;
  const length = Math.ceil((8 * 4 * beat + 0.5) * SR);
  const out = new Float32Array(length);
  const add = (t, dur, fn) => {
    const a = Math.round(t * SR);
    for (let i = 0; i < dur * SR && a + i < length; i++) out[a + i] += fn(i / SR);
  };
  for (let b = 0; b < 32; b++) {
    const amp = b % 4 === 2 ? 0.9 : 0.5;
    add(0.004 + b * beat, 0.25, (x) => amp * Math.exp(-x * 18) * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-x * 40)) * x));
  }
  const a = analyze(out);
  assert.ok(a.origin < 0.02, `bar 1 at ${a.origin}`);
  for (const grid of ["1", "2", "4", "4:1"]) {
    const cuts = detectCuts(a, { sensitivity: 0.5, grid });
    const step = gridStep(a, grid);
    assert.ok(Math.abs(cuts[0] - step) < 0.02, `1:${grid}: first section is ${cuts[0].toFixed(3)} s, not ${step} s`);
  }
});

test("the start the user marks becomes bar 1: the grid moves with it and the lead-in is one section", () => {
  const loop = drumLoop();
  const a = analyze(loop.samples);
  const linesBefore = gridLines(a, "1").map((l) => l.time);
  assert.equal(withOrigin(a, null), a, "no mark: the detected start");
  assert.equal(emptyEdits().origin, null);
  for (const mark of [0.6, 0.87]) {
    const m = withOrigin(a, mark);
    assert.equal(withOrigin(a, mark), m, "cached per mark");
    for (const grid of ["1", "4", "2:1", "auto"]) {
      const cuts = detectCuts(m, { sensitivity: 0.5, grid });
      assert.equal(cuts[0], mark, `${grid}: the first cut is exactly the mark, nothing before it (${cuts.slice(0, 3)})`);
    }
    const bars = detectCuts(m, { sensitivity: 0.5, grid: "1" });
    assert.ok(Math.abs(bars[1] - mark - a.bar) < 0.03, `the next bar is a bar later: ${bars[1]}`);
    const four = detectCuts(m, { sensitivity: 0.5, grid: "4" });
    assert.ok(Math.abs(four[1] - mark - a.beat) < 0.03, `1:4 counts from the mark too: ${four[1]}`);
  }
  assert.deepEqual(gridLines(a, "1").map((l) => l.time), linesBefore, "the detected grid is untouched");
});

test("drift: exact tempo and cuts on the attack from the start to the end of the song", () => {
  for (const bpm of [96.7, 128, 140.3]) {
    const beat = 60 / bpm;
    const seconds = 90;
    const length = seconds * SR;
    const out = new Float32Array(length);
    const noise = rng(5);
    for (let i = 0; i < length; i++) out[i] = 0.03 * Math.sin((2 * Math.PI * 110 * i) / SR) + 0.003 * noise();
    const add = (t, dur, fn) => {
      const a = Math.round(t * SR);
      for (let i = 0; i < dur * SR && a + i < length; i++) out[a + i] += fn(i / SR);
    };
    const kicks = [];
    for (let b = 0; 0.8 + b * beat < seconds - 1; b++) {
      const t = 0.8 + b * beat;
      kicks.push(t);
      add(t, 0.25, (x) => 0.8 * Math.exp(-x * 18) * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-x * 40)) * x));
      for (const q of [0.25, 0.5, 0.75]) {
        let p = 0;
        add(t + q * beat, 0.03, (x) => {
          const n = noise();
          const hp = n - p;
          p = n;
          return 0.15 * Math.exp(-x * 120) * hp; // hats on the 16ths: they must not pull the bar cuts early
        });
      }
    }
    const a = analyze(out);
    assert.ok(Math.abs(a.bpm - bpm) < 0.02, `${bpm} BPM estimated ${a.bpm}`);
    const cuts = detectCuts(a, { sensitivity: 0.5, grid: "1" });
    for (const k of kicks.filter((_, i) => i % 4 === 0)) {
      const c = cuts.reduce((m, x) => (Math.abs(x - k) < Math.abs(m - k) ? x : m), cuts[0]);
      assert.ok(c - k <= 0.0005 && k - c < 0.004, `${bpm} BPM: bar at ${k.toFixed(3)} cut at ${c.toFixed(4)}`);
    }
  }
});

test("a grid section never ends with the start of the next hit", () => {
  // 120 BPM, a hit on each beat, one played 25 ms early (0.975) and one 40 ms late (2.04)
  const onsets = [0, 0.5, 0.975, 1.5, 2.04, 2.5, 3, 3.5].map((time) => ({ time, strength: 1, band: 0 }));
  const analysis = { onsets, duration: 4, beat: 0.5, bar: 2, origin: 0, bpm: 120 };
  const cuts = detectCuts(analysis, { sensitivity: 0.5, grid: "4" });
  assert.ok(cuts.some((c) => Math.abs(c - 0.975) < 1e-9), `the early hit starts its section: ${cuts}`);
  assert.ok(!cuts.some((c) => c > 0.975 && c < 1.2), "no cut after it inside the hit");
  // a late hit beyond the 15 ms snap: the cut stays on the grid line, before the hit (nothing of it captured)
  const late = cuts.find((c) => c > 1.9 && c < 2.1);
  assert.ok(late !== undefined && late <= 2.04, `late hit: ${cuts}`);
  // every section ends at or before the next hit's start
  for (let i = 0; i + 1 < cuts.length; i++) {
    const inside = onsets.filter((o) => o.time > cuts[i] + 1e-9 && o.time < cuts[i + 1] - 1e-9);
    for (const o of inside) assert.ok(cuts[i + 1] - o.time > 0.06 || o.time - cuts[i] < 0.015, `hit ${o.time} at the end of ${cuts[i]}–${cuts[i + 1]}`);
  }
});

test("sections follow the cuts and the user's edits", () => {
  const duration = 10;
  const cuts = [2, 4, 6, 8];
  let edits = emptyEdits();
  let { dividers, sections } = buildSections({ duration, cuts, edits });
  assert.deepEqual(sections.map((s) => [s.start, s.end]), [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10]]);
  assert.deepEqual(dividers.map((d) => d.kind), ["start", "auto", "auto", "auto", "auto", "end"]);

  // drag the automatic cut at 4 to 4.5: it becomes the user's and survives a new detection
  edits = moveDivider(edits, dividers[2], 4.5);
  ({ sections } = buildSections({ duration, cuts: [2, 4, 6, 8, 9], edits }));
  assert.deepEqual(sections.map((s) => s.start), [0, 2, 4.5, 6, 8, 9]);

  // trim the edges, remove a cut, add one
  ({ dividers } = buildSections({ duration, cuts, edits }));
  edits = moveDivider(edits, dividers[0], 0.5);
  edits = moveDivider(edits, dividers[dividers.length - 1], 9.5);
  edits = removeDivider(edits, dividers.find((d) => d.time === 6));
  edits = addDivider(edits, 7);
  ({ dividers, sections } = buildSections({ duration, cuts, edits }));
  assert.deepEqual(sections.map((s) => [s.start, s.end]), [[0.5, 2], [2, 4.5], [4.5, 7], [7, 8], [8, 9.5]]);
  assert.equal(sections[2].key, 4500);

  // an automatic cut next to a pinned one gives way; removing the pin brings nothing back at 4 (still suppressed)
  edits = removeDivider(edits, dividers.find((d) => d.time === 4.5));
  ({ sections } = buildSections({ duration, cuts, edits }));
  assert.deepEqual(sections.map((s) => s.start), [0.5, 2, 7, 8]);
  // edges back to the song's
  ({ dividers } = buildSections({ duration, cuts, edits }));
  edits = removeDivider(edits, dividers[0]);
  ({ sections } = buildSections({ duration, cuts, edits }));
  assert.equal(sections[0].start, 0);
});

test("a section resets to the size the detection gave it", () => {
  const duration = 10;
  const cuts = [2, 4, 6, 8];
  const build = (edits) => buildSections({ duration, cuts, edits });
  let edits = emptyEdits();
  let { dividers } = build(edits);
  assert.equal(isSectionEdited(edits, dividers, 1), false);

  // section 2 (2–4): its start dragged to 2.5, its end (4) dragged to 4.4 and then again to 4.8
  edits = moveDivider(edits, dividers[1], 2.5);
  ({ dividers } = build(edits));
  edits = moveDivider(edits, dividers[2], 4.4);
  ({ dividers } = build(edits));
  edits = moveDivider(edits, dividers[2], 4.8);
  ({ dividers } = build(edits));
  assert.deepEqual(dividers.map((d) => d.time), [0, 2.5, 4.8, 6, 8, 10]);
  assert.ok(isSectionEdited(edits, dividers, 1));
  assert.ok(isSectionEdited(edits, dividers, 0), "its neighbour shares the moved divider");
  assert.equal(isSectionEdited(edits, dividers, 3), false);
  edits = resetSection(edits, dividers, 1);
  ({ dividers } = build(edits));
  assert.deepEqual(dividers.map((d) => d.time), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(edits, emptyEdits());

  // a removed cut inside comes back; a divider the user added goes away; trimmed edges return
  edits = removeDivider(edits, dividers[3]); // 6
  ({ dividers } = build(edits));
  edits = addDivider(edits, 9);
  edits = moveDivider(edits, dividers[dividers.length - 1], 9.5);
  ({ dividers } = build(edits));
  assert.deepEqual(dividers.map((d) => d.time), [0, 2, 4, 8, 9, 9.5]);
  edits = resetSection(edits, dividers, 2); // 4–8, had 6 removed
  ({ dividers } = build(edits));
  assert.deepEqual(dividers.map((d) => d.time), [0, 2, 4, 6, 8, 9, 9.5]);
  edits = resetSection(edits, dividers, 5); // 9–9.5: user cut at 9 and trimmed end
  ({ dividers } = build(edits));
  assert.deepEqual(dividers.map((d) => d.time), [0, 2, 4, 6, 8, 10]);
  // removing a dragged divider keeps its original cut removed
  edits = moveDivider(edits, dividers[1], 2.3);
  ({ dividers } = build(edits));
  edits = removeDivider(edits, dividers[1]);
  ({ dividers } = build(edits));
  assert.deepEqual(dividers.map((d) => d.time), [0, 4, 6, 8, 10]);
  assert.deepEqual(edits.links, []);
});

test("÷2 cuts a section in equal halves, ×2 doubles it over the next ones", () => {
  const duration = 10;
  const cuts = [2, 4, 5, 6, 8];
  const build = (edits) => buildSections({ duration, cuts, edits });
  let edits = emptyEdits();
  let { dividers, sections } = build(edits);
  edits = splitSection(edits, sections[1]); // 2–4
  ({ dividers, sections } = build(edits));
  assert.deepEqual(dividers.map((d) => d.time), [0, 2, 3, 4, 5, 6, 8, 10]);
  edits = splitSection(edits, sections[0], 4); // 0–2 in four
  ({ dividers, sections } = build(edits));
  assert.deepEqual(sections.slice(0, 4).map((x) => x.end - x.start), [0.5, 0.5, 0.5, 0.5]);
  // ×2 on 4–5 (1 s): it becomes 4–6, the cut at 5 goes away, 6 was there already
  let i = sections.findIndex((x) => x.start === 4);
  edits = multiplySection(edits, dividers, i, duration);
  ({ dividers, sections } = build(edits));
  assert.deepEqual(sections.find((x) => x.start === 4).end, 6);
  // ×2 on 6–8: 6–10, the song's end
  i = sections.findIndex((x) => x.start === 6);
  edits = multiplySection(edits, dividers, i, duration);
  ({ sections } = build(edits));
  assert.deepEqual(sections[sections.length - 1], { ...sections[sections.length - 1], start: 6, end: 10 });
  // ×2 where no divider waits: a new one at start + 2 × length
  ({ dividers, sections } = build(emptyEdits()));
  const e2 = multiplySection(emptyEdits(), dividers, 0, duration); // 0–2 -> 0–4, removes 2
  assert.deepEqual(build(e2).dividers.map((d) => d.time), [0, 4, 5, 6, 8, 10]);
  const e3 = multiplySection(emptyEdits(), dividers, 2, duration); // 4–5 -> 4–6
  assert.deepEqual(build(e3).dividers.map((d) => d.time), [0, 2, 4, 6, 8, 10]);
});

test("Auto marks the bars first: every bar starts a section", () => {
  const loop = drumLoop();
  const a = analyze(loop.samples);
  const cuts = detectCuts(a, { sensitivity: 0.3, grid: "auto" });
  for (const t of loop.kicks.filter((_, i) => i % 4 === 0)) {
    assert.ok(cuts.some((c) => Math.abs(c - t) < 0.008 && c <= t + 0.004), `no cut at the bar starting ${t.toFixed(3)}`);
  }
  // and only where something is played: a quiet loop of bars (no hits inside) cuts on the bars alone
  const sixteenth = a.bar / 16;
  for (const c of cuts) {
    const k = (c - a.origin) / sixteenth;
    assert.ok(Math.abs(k - Math.round(k)) * sixteenth < 0.07, `cut ${c.toFixed(3)} is off the 1/16 grid`);
  }
});

test("waveform peaks match a direct scan at any zoom", () => {
  const loop = drumLoop({ bars: 2 });
  const levels = buildPeaks(loop.samples);
  for (const perPixel of [3, 200, 5000]) {
    const width = 40;
    const from = 1234;
    const cols = columnPeaks(loop.samples, levels, from, perPixel, width);
    for (const x of [0, 17, 39]) {
      const a = Math.floor(from + x * perPixel);
      const b = Math.min(loop.samples.length, Math.max(a + 1, Math.floor(from + (x + 1) * perPixel)));
      let hi = -1;
      for (let i = a; i < b; i++) hi = Math.max(hi, loop.samples[i]);
      // the coarse levels may look one block further: never lower than the truth
      assert.ok(cols[2 * x + 1] >= hi - 1e-6, `perPixel ${perPixel} x ${x}`);
      assert.ok(cols[2 * x] <= cols[2 * x + 1]);
    }
  }
  const past = columnPeaks(loop.samples, levels, loop.samples.length + 10, 10, 2);
  assert.deepEqual([...past], [0, 0, 0, 0]);
});

test("fades: length fits the section, curve shapes the gain", () => {
  assert.equal(fadeGain(0.5, 0), 0.5);
  assert.ok(fadeGain(0.5, 1) > 0.7, "aggressive stays loud");
  assert.ok(fadeGain(0.5, -1) < 0.1, "soft stays quiet longer");
  assert.equal(fadeGain(0, 1), 0);
  assert.equal(fadeGain(1, -1), 1);
  assert.deepEqual(fitFade({ in: 3, out: 3, inCurve: 5 }, 4), { in: 3, out: 1, inCurve: 1, outCurve: 0 });
  const f = { in: 1, inCurve: 0, out: 2, outCurve: 0 };
  assert.equal(fadeGainAt(f, 0, 10), 0);
  assert.equal(fadeGainAt(f, 0.5, 10), 0.5);
  assert.equal(fadeGainAt(f, 5, 10), 1);
  assert.equal(fadeGainAt(f, 9, 10), 0.5);
  const ones = new Float32Array(100).fill(1);
  const faded = applyFades(ones, 100, { in: 0.1, out: 0.2 });
  assert.equal(faded[0], 0);
  assert.ok(Math.abs(faded[5] - 0.5) < 1e-6);
  assert.equal(faded[50], 1);
  assert.ok(faded[99] < 0.06);
  assert.equal(ones[0], 1, "the original stays untouched");
});

test("formatTime", () => {
  assert.equal(formatTime(7.123), "0:07.12");
  assert.equal(formatTime(83.4567, 3), "1:23.457");
  assert.equal(formatTime(61, 0), "1:01");
});
