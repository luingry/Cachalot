// Transient mode: a media card turned into the waveform of its audio, cut into
// sections at the transients Cachalot's analysis finds (by timbre and tempo).
//
// Cachalot downloads the audio and hands over a light mono copy; the analysis
// runs here (src/lib/transients.js), so the sensitivity slider and the grid
// toggles (1:1 … 1:16, auto) recompute live. Scroll zooms, dragging pans,
// dividers drag (snapping to transients; Alt = free), a double click adds or
// removes a divider, a click plays the section. Hovering a section shows
// "download this one" and "disable"; "Baixar todos" saves every active
// section, one file each (MP3, WAV or FLAC, asked unless remembered), in a
// new folder.

import { makeTitleEditable } from "./editable-title.js";
import { createBridgeClient, describeBridgeError } from "../src/lib/bridge.js";
import {
  ANALYSIS_RATE,
  DEFAULT_SENSITIVITY,
  GRIDS,
  MAX_BPM,
  MIN_BPM,
  MIN_DRAG_GAP_S,
  MULTI_BAR_GRIDS,
  TRANSIENT_GRID,
  addDivider,
  analyze,
  applyFades,
  emptyFade,
  fadeGain,
  fadeGainAt,
  fitFade,
  hasFade,
  buildPeaks,
  buildSections,
  columnPeaks,
  detectCuts,
  emptyEdits,
  formatTime,
  gridLines,
  gridStep,
  isSectionEdited,
  moveDivider,
  multiplySection,
  nearestOnset,
  pcm16ToFloat,
  removeDivider,
  resetSection,
  splitSection,
  sectionKey,
  thresholdFor,
  withOrigin,
  withTempo,
} from "../src/lib/transients.js";

const SETTINGS_KEY = "transientSettings";

/** Bars per section of a grid: "32:1" = 32 … "1" = 1 … "64" = 1/64 (Auto: 0). */
function barsOf(grid) {
  const many = /^(\d+):1$/.exec(grid);
  return many ? Number(many[1]) : grid === "auto" ? 0 : 1 / Number(grid);
}

const EDITS_PREFIX = "transientEdits:";
const POLL_MS = 500;
const HANDLE_PX = 6;
const SNAP_PX = 8;
const MIN_GAP_S = MIN_DRAG_GAP_S;
const MIN_SPAN_S = 0.05;
const CLICK_DELAY_MS = 230; // a click waits this long to tell itself from a double click
const LANE_TOP = 16;
const LANE_BOTTOM = 15;
const GRID_LABELS = {
  1: "1:1",
  2: "1:2",
  4: "1:4",
  8: "1:8",
  16: "1:16",
  32: "1:32",
  64: "1:64",
  "2:1": "2:1",
  "4:1": "4:1",
  "8:1": "8:1",
  "16:1": "16:1",
  "32:1": "32:1",
  auto: "Auto",
};
const GRID_TITLES = {
  1: "Seções de um compasso",
  2: "Seções de meio compasso",
  4: "Seções de um tempo (semínima)",
  8: "Seções de uma colcheia",
  16: "Seções de uma semicolcheia",
  32: "Seções de uma fusa (1/32)",
  64: "Seções de uma semifusa (1/64)",
  "2:1": "Seções de 2 compassos",
  "4:1": "Seções de 4 compassos",
  "8:1": "Seções de 8 compassos",
  "16:1": "Seções de 16 compassos",
  "32:1": "Seções de 32 compassos",
  auto: "Compassos primeiro: cada compasso começa uma seção e, dentro dele, corta nos transientes (em 1/16)",
};
const RULER_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const ORIGIN_TITLE = "Compasso 1: fica no começo do áudio; arraste para marcar onde a música começa e as seções andam junto · Alt solta do transiente · duplo clique volta ao começo";
const HINT =
  "Arraste a bandeira azul na régua para marcar o compasso 1 · Perto de uma divisória, ⇥⇤ junta as duas seções · Role para zoom · arraste para selecionar (Ctrl/Shift soma) · Ctrl+clique soma o trecho vizinho · Shift+clique liga/desliga um · botão direito ou do meio arrasta a vista · arraste as divisórias · nas bordas da seção, fade-in/out (alça ■ comprimento, ● curva) · duplo clique cria ou remove · clique ouve · Alt+clique toca dali · Ctrl+Z desfaz";

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  download: ["M12 4v11", "m7 10 5 5 5-5", "M5 20h14"],
  disable: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "m5.7 5.7 12.6 12.6"],
  enable: ["m5 12.5 4.5 4.5L19 7"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  folder: ["M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"],
  retry: ["M20 12a8 8 0 1 1-2.34-5.66", "M20 4v5h-5"],
  play: ["M8 5.5v13l10.5-6.5z"],
  pause: ["M8.5 5.5v13", "M15.5 5.5v13"],
  undo: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
  redo: ["m15 14 5-5-5-5", "M20 9H9.5a5.5 5.5 0 0 0 0 11H13"],
  reset: ["M3 12h18", "m7 8-4 4 4 4", "m17 8 4 4-4 4"],
  recut: ["M21 12a9 9 0 0 1-15.5 6.2L3 16", "M3 21v-5h5", "M3 12a9 9 0 0 1 15.5-6.2L21 8", "M21 3v5h-5"],
  group: ["M8 5H5v14h3", "M16 5h3v14h-3", "M9.5 12h5"],
  move: ["M8.5 7h7v10h-7z", "m5 9.5-2.5 2.5L5 14.5", "m19 9.5 2.5 2.5-2.5 2.5"],
  merge: ["M3 12h6.5", "m6.5 8.5 3.5 3.5-3.5 3.5", "M21 12h-6.5", "m17.5 8.5-3.5 3.5 3.5 3.5"],
};
/** The row button that opens the view. */
export const WAVE_ICON = ["M3 12h1.5", "M7 8.5v7", "M10.5 5v14", "M14 9v6", "M17.5 6.5v11", "M21 11v2"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(paths, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function iconButton(paths, label, className = "") {
  const b = el("button", `icon-btn icon-btn-sm ${className}`.trim());
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(paths));
  return b;
}

function errorText(res) {
  if (res?.error === "http" && res.status === 422 && res.message) return res.message;
  if (res?.error === "http" && res.status === 503 && res.message) return res.message;
  return describeBridgeError(res);
}

/** Formats Cachalot cuts sections into, in the order the picker shows them. */
export const EXPORT_FORMATS = Object.freeze(["mp3", "wav", "flac"]);
const FORMAT_HINTS = { mp3: "Menor, com perdas (320 kbps)", wav: "Sem perdas, sem compressão", flac: "Sem perdas, comprimido" };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * opts: {
 *   request: body of the "transientPrepare" message (tabId, id | url, title, cookies),
 *   title: what the card shows until Cachalot knows better,
 *   message(type, extra): the popup's channel to the service worker,
 *   onClose(): the card goes back to normal,
 * }
 * Returns { node, destroy }.
 */
export function createTransientView({ request, title, titleEdited = false, message, onClose, onRename }) {
  const bridge = createBridgeClient({ storage: chrome.storage.local });
  const v = {
    alive: true,
    jobId: "",
    title: title || "",
    titleEdited, // renamed by the user: Cachalot's title no longer replaces it
    samples: null,
    peaks: null,
    gain: 1,
    analysis: null, // what the view uses: the detected analysis, at the user's tempo when one was typed
    detected: null, // the analysis as found
    bpm: null, // the tempo the user typed (null: the detected one), per song
    settings: { sensitivity: DEFAULT_SENSITIVITY, grid: "1", loop: false, detect: false, slices: true }, // grid: per song, a new one
    // opens on 1:1; detect ("Transient detection") always starts off: the cuts sit exactly on the tempo's grid;
    // slices ("Show slices") always starts on: off, the waveform is the plain song and playback runs through all of it
    edits: emptyEdits(),
    disabled: new Set(),
    cuts: [],
    dividers: [],
    sections: [],
    start: 0,
    end: 1,
    hover: { section: -1, divider: -1, fade: null },
    drag: null,
    originDrag: null, // dragging the "music starts here" flag: { time, grab (px), moved }
    press: null,
    clickTimer: null,
    pointerX: -1,
    pointerY: -1,
    play: null, // { ctx, source, start, end, at }
    audio: null, // { ctx, buffer }
    raf: 0,
    saveTimer: null,
    pollTimer: null,
    busy: false,
    selected: new Set(), // keys of the sections picked by dragging (actions apply to all of them)
    fades: {}, // section key -> { in, inCurve, out, outCurve } (seconds, curves in [-1, 1])
    fadeDrag: null,
    picker: null, // the open "salvar como" popup: { node, done }
    lastFormat: "wav", // focused first the next time the picker opens
    undo: [], // snapshots { edits, disabled } before each change (Ctrl+Z)
    redo: [],
  };

  // ---- DOM ------------------------------------------------------------------
  const node = el("div", "transient");
  const head = el("div", "tr-head");
  const titleEl = el("div", "tr-title", v.title);
  const original = { title: v.title }; // what an emptied name goes back to (Cachalot's title once it arrives)
  makeTitleEditable(titleEl, {
    label: "Nome da música (clique para editar)",
    read: () => v.title,
    commit: (text) => {
      v.titleEdited = text != null;
      setTitle(text ?? original.title);
      onRename?.(text);
    },
  });
  const headTools = el("div", "tr-head-tools");
  const allBtn = el("button", "btn btn-primary btn-sm tr-all");
  allBtn.type = "button";
  allBtn.disabled = true;
  allBtn.append(icon(ICONS.download), el("span", "", "Baixar todos"));
  allBtn.title = "Baixar cada seção ativa num arquivo, todos na mesma pasta";
  const closeBtn = iconButton(ICONS.close, "Sair do modo transiente", "tr-close");
  const undoBtn = iconButton(ICONS.undo, "Desfazer (Ctrl+Z)", "tr-undo");
  const redoBtn = iconButton(ICONS.redo, "Refazer (Ctrl+Shift+Z)", "tr-redo");
  undoBtn.disabled = true;
  redoBtn.disabled = true;
  headTools.append(undoBtn, redoBtn, allBtn, closeBtn);
  // play / pause: the selection (or the whole song); pausing keeps the place, play goes on from it
  const playBtn = iconButton(ICONS.play, "Tocar (Espaço)", "tr-play");
  playBtn.disabled = true;
  head.append(playBtn, titleEl, headTools);

  const controls = el("div", "tr-controls");
  const sens = el("label", "tr-sens");
  sens.title = "Sensibilidade: à esquerda só os transientes fortes, à direita também os fracos";
  const sensInput = el("input");
  sensInput.type = "range";
  sensInput.min = "0";
  sensInput.max = "100";
  sensInput.step = "1";
  sensInput.setAttribute("aria-label", "Sensibilidade da detecção");
  const sensValue = el("span", "tr-sens-value", "50");
  sens.append(el("span", "tr-label", "Sens."), sensInput, sensValue);
  // every division in one row, from the longest sections to the shortest (32 bars … 1/64 of a bar), then Auto
  const grid = el("div", "tr-grid");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Divisão das seções");
  const gridButtons = new Map();
  const order = [...GRIDS].sort((a, b) => (a === "auto") - (b === "auto") || barsOf(b) - barsOf(a));
  for (const g of order) {
    const b = el("button", "tr-grid-btn", GRID_LABELS[g]);
    b.type = "button";
    b.title = GRID_TITLES[g];
    b.addEventListener("click", () => setGrid(g));
    gridButtons.set(g, b);
    if (g === "auto") grid.append(el("span", "tr-grid-sep"));
    grid.append(b);
  }
  const info = el("span", "tr-info");
  // a click on the tempo lets the user type the right one: the grid and the cuts are redone on it
  const bpmBtn = el("button", "tr-bpm");
  bpmBtn.type = "button";
  bpmBtn.hidden = true;
  const bpmInput = el("input", "tr-bpm-input");
  bpmInput.type = "text";
  bpmInput.inputMode = "decimal";
  bpmInput.setAttribute("aria-label", "Andamento da música (BPM)");
  bpmInput.hidden = true;
  const infoText = el("span", "tr-info-text");
  info.append(bpmBtn, bpmInput, infoText);
  const loop = el("label", "tr-loop");
  loop.title = "Loop: a seção clicada para ouvir toca de novo e de novo, até clicar outra vez";
  const loopInput = el("input");
  loopInput.type = "checkbox";
  loop.append(loopInput, el("span", "", "Loop"));
  // on: the sections over the waveform (bands, dividers, tools); off: the plain song, played from end to end
  const slices = el("label", "tr-slices");
  slices.title = "Show slices: mostra os trechos sobre a waveform. Desmarcado: só a música, e o play segue pela música inteira";
  const slicesInput = el("input");
  slicesInput.type = "checkbox";
  slices.append(slicesInput, el("span", "", "Show slices"));
  // off: every section exactly on the grid built on the tempo; on: the detection (Auto, sensitivity, cuts on attacks)
  const detect = el("label", "tr-detect");
  detect.title =
    "Transient detection: os cortes se ajustam aos transientes detectados (Auto, sensibilidade, corte no ataque). Desmarcado: cada trecho exatamente na grade do BPM";
  const detectInput = el("input");
  detectInput.type = "checkbox";
  detect.append(detectInput, el("span", "", "Transient detection"));
  // one section from each transient mark to the next (the marks under the waveform, at this sensitivity)
  const recutBtn = iconButton(ICONS.recut, "Recalcular os trechos pelas marcações de transientes, quantizados pelo BPM", "tr-recut");
  recutBtn.disabled = true;
  const top = el("div", "tr-controls-top");
  top.append(loop, slices, detect, recutBtn, sens, info);
  controls.append(top, grid);

  const wave = el("div", "tr-wave");
  const canvas = el("canvas", "tr-canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Waveform com as seções");
  const tools = el("div", "tr-tools");
  const toolDownload = iconButton(ICONS.download, "Baixar esta seção", "tr-tool");
  const toolToggle = iconButton(ICONS.disable, "Desativar esta seção", "tr-tool");
  const toolReset = iconButton(ICONS.reset, "Voltar a seção ao tamanho original", "tr-tool tr-reset");
  toolToggle.classList.add("tr-toggle");
  const textTool = (text, label, cls) => {
    const b = el("button", `icon-btn icon-btn-sm tr-tool tr-text ${cls}`, text);
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  };
  const toolSplit = textTool("÷2", "Dividir a seção em duas partes iguais", "tr-split");
  const toolDouble = textTool("×2", "Dobrar a seção (junta o que vier depois até o dobro do tamanho)", "tr-double");
  tools.append(toolDownload, toolSplit, toolDouble, toolReset, toolToggle);
  // drags the hovered section along the song keeping its length; sits centered right above the hover tools
  const moveBtn = iconButton(
    ICONS.move,
    "Arrastar a seção sem mudar o tamanho (encaixa na grade ou nos transientes · Alt solta)",
    "tr-move",
  );
  moveBtn.hidden = true;
  tools.hidden = true;
  const tip = el("div", "tr-tip");
  tip.hidden = true;
  const overlay = el("div", "tr-overlay");
  const overlayText = el("div", "tr-overlay-text", "Preparando o áudio…");
  const bar = el("div", "tr-progress");
  const barFill = el("div", "tr-progress-fill");
  bar.append(barFill);
  const retryBtn = el("button", "btn btn-secondary btn-sm tr-retry");
  retryBtn.type = "button";
  retryBtn.append(icon(ICONS.retry), el("span", "", "Tentar de novo"));
  retryBtn.hidden = true;
  overlay.append(overlayText, bar, retryBtn);
  // merge: centered on the divider the pointer is near; joins the two sections it separates
  const mergeBtn = iconButton(ICONS.merge, "Juntar as duas seções", "tr-merge");
  mergeBtn.hidden = true;
  // group: centered on a selection of sections in a row; joins them into one (Ctrl+G does the same)
  const groupBtn = iconButton(ICONS.group, "Agrupar as seções selecionadas numa só (Ctrl+G)", "tr-group");
  groupBtn.hidden = true;
  wave.append(canvas, tools, moveBtn, mergeBtn, groupBtn, tip, overlay);

  const foot = el("div", "tr-foot");
  const footText = el("span", "tr-foot-text", HINT);
  footText.title = HINT;
  const footFolder = iconButton(ICONS.folder, "Abrir a pasta", "tr-foot-folder");
  footFolder.hidden = true;
  foot.append(footText, footFolder);

  // the whole song, a quarter of the height: the window shows (and moves, and zooms) what the waveform above shows
  const overview = el("div", "tr-overview");
  const ocanvas = el("canvas", "tr-overview-canvas");
  ocanvas.setAttribute("role", "img");
  ocanvas.setAttribute("aria-label", "A música inteira; a janela marca o trecho visível acima");
  overview.append(ocanvas);
  overview.hidden = true;

  node.append(head, controls, wave, overview, foot);
  controls.classList.add("is-waiting");

  // ---- Loading --------------------------------------------------------------

  function showOverlay(text, { progress = null, error = false } = {}) {
    overlay.hidden = false;
    overlay.classList.toggle("is-error", error);
    overlayText.textContent = text;
    bar.hidden = progress === null;
    barFill.style.width = `${clamp(progress ?? 0, 0, 100)}%`;
    retryBtn.hidden = !error;
  }

  async function start() {
    showOverlay("Preparando o áudio…", { progress: 0 });
    loadSettings();
    const res = await message("transientPrepare", request);
    if (!v.alive) return;
    if (!res.ok) return showOverlay(errorText(res), { error: true });
    follow(res);
  }

  function follow(state) {
    v.jobId = state.id || v.jobId;
    if (state.title) {
      original.title = state.title;
      if (!v.titleEdited) setTitle(state.title);
    }
    if (state.state === "erro") return showOverlay(state.error || "Não foi possível preparar o áudio.", { error: true });
    if (state.state === "pronto") return loadAudio(state);
    const pct = Number(state.progress) || 0;
    const text =
      state.state === "decodificando"
        ? "Analisando o áudio…"
        : state.phase && !/^\d/.test(state.phase)
          ? `${state.phase}…`
          : pct > 0
            ? `Baixando o áudio… ${Math.round(pct)}%`
            : "Baixando o áudio…";
    showOverlay(text, { progress: state.state === "decodificando" ? 100 : pct });
    clearTimeout(v.pollTimer);
    v.pollTimer = setTimeout(poll, POLL_MS);
  }

  async function poll() {
    if (!v.alive) return;
    const res = await message("transient", { op: "status", body: { id: v.jobId } });
    if (!v.alive) return;
    if (res.ok) return follow(res);
    // Cachalot restarted and forgot the job: ask again (the audio may already be in its cache).
    if (res.error === "http" && res.status === 404) return start();
    showOverlay(errorText(res), { error: true });
  }

  async function loadAudio(state) {
    showOverlay("Carregando a waveform…", { progress: 100 });
    const res = await bridge.transientPcm(v.jobId);
    if (!v.alive) return;
    if (!res.ok || !(res.data instanceof ArrayBuffer)) return showOverlay(errorText(res), { error: true });
    showOverlay("Detectando os transientes…", { progress: 100 });
    await new Promise((r) => setTimeout(r, 30)); // lets the line paint before the analysis blocks
    if (!v.alive) return;
    v.samples = pcm16ToFloat(res.data);
    if (!v.samples.length) return showOverlay("A mídia não tem áudio.", { error: true });
    v.peaks = buildPeaks(v.samples);
    let peak = 0;
    for (const level of [v.peaks[1]]) for (let i = 0; i < level.max.length; i++) peak = Math.max(peak, level.max[i], -level.min[i]);
    v.gain = peak > 0.001 ? 0.95 / peak : 1;
    v.detected = analyze(v.samples, Number(state.rate) || ANALYSIS_RATE);
    v.analysis = v.detected;
    v.start = 0;
    v.end = v.analysis.duration;
    node.dataset.view = `0,${v.end}`;
    await loadEdits();
    if (!v.alive) return;
    v.analysis = withTempo(v.detected, v.bpm);
    overlay.hidden = true;
    controls.classList.remove("is-waiting");
    overview.hidden = false;
    playBtn.disabled = false;
    node.classList.add("is-ready");
    recompute();
  }

  // ---- Settings and edits (remembered) ----------------------------------------

  async function loadSettings() {
    try {
      const saved = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
      if (saved && typeof saved === "object") {
        if (Number.isFinite(saved.sensitivity)) v.settings.sensitivity = clamp(saved.sensitivity, 0, 1);
        if (typeof saved.loop === "boolean") v.settings.loop = saved.loop;
      }
    } catch {
      // defaults
    }
    paintControls();
    if (v.analysis) recompute();
  }

  function saveSettings() {
    const { sensitivity, loop } = v.settings; // the grid is per song (saveEdits)
    chrome.storage.local.set({ [SETTINGS_KEY]: { sensitivity, loop } }).catch(() => {});
  }

  /** The cuts the user moved, added or removed and the disabled sections, per song for this browser session. */
  async function loadEdits() {
    try {
      const saved = (await chrome.storage.session.get(EDITS_PREFIX + v.jobId))[EDITS_PREFIX + v.jobId];
      if (saved?.edits) v.edits = { ...emptyEdits(), ...saved.edits };
      if (Array.isArray(saved?.disabled)) v.disabled = new Set(saved.disabled);
      if (saved?.fades && typeof saved.fades === "object") v.fades = saved.fades;
      if (Number.isFinite(saved?.bpm)) v.bpm = saved.bpm;
      // Auto needs the detection, and it starts off
      if (GRIDS.includes(saved?.grid)) v.settings.grid = saved.grid === "auto" && !v.settings.detect ? "1" : saved.grid;
    } catch {
      // a fresh start
    }
    paintControls();
  }

  function saveEdits() {
    clearTimeout(v.saveTimer);
    v.saveTimer = setTimeout(() => {
      chrome.storage.session
        .set({ [EDITS_PREFIX + v.jobId]: { edits: v.edits, disabled: [...v.disabled], fades: v.fades, grid: v.settings.grid, bpm: v.bpm } })
        .catch(() => {});
    }, 300);
  }

  function paintControls() {
    loopInput.checked = v.settings.loop;
    slicesInput.checked = v.settings.slices;
    node.classList.toggle("is-sliceless", !v.settings.slices);
    detectInput.checked = v.settings.detect;
    // the sensitivity and the recut only exist with the detection: hidden without it
    sens.hidden = !v.settings.detect;
    recutBtn.hidden = !v.settings.detect;
    sensInput.disabled = !v.settings.detect;
    recutBtn.disabled = !v.settings.detect;
    recutBtn.setAttribute("aria-pressed", String(v.settings.grid === TRANSIENT_GRID));
    recutBtn.title =
      "Recalcular os trechos pelas marcações de transientes, quantizados em tamanhos de compasso pelo BPM (desfaz as divisórias editadas · Ctrl+Z volta)";
    const s = Math.round(v.settings.sensitivity * 100);
    sensInput.value = String(s);
    sensValue.textContent = String(s);
    sensInput.style.setProperty("--fill", `${s}%`);
    for (const [g, b] of gridButtons) b.setAttribute("aria-pressed", String(g === v.settings.grid));
  }

  /** Auto and the transient sections are the detection itself: choosing them turns it on. */
  function applyGrid(g) {
    v.settings.grid = g;
    if (g === "auto" || g === TRANSIENT_GRID) v.settings.detect = true;
  }

  function setGrid(g) {
    applyGrid(g);
    paintControls();
    saveEdits();
    if (v.analysis) recompute();
  }

  detectInput.addEventListener("change", () => {
    v.settings.detect = detectInput.checked;
    if (!v.settings.detect && v.settings.grid !== "1") {
      v.settings.grid = "1"; // without the detection the sections go back to the default division (1:1)
      saveEdits();
    }
    paintControls();
    if (v.analysis) recompute();
  });

  let sensFrame = 0;
  sensInput.addEventListener("input", () => {
    v.settings.sensitivity = Number(sensInput.value) / 100;
    paintControls();
    cancelAnimationFrame(sensFrame);
    sensFrame = requestAnimationFrame(() => v.analysis && recompute());
  });
  sensInput.addEventListener("change", saveSettings);

  // ---- Model ----------------------------------------------------------------

  /** Where the flag stands: the start of the audio until the user drags it (live while dragging). */
  function flagTime() {
    return v.originDrag ? v.originDrag.time : v.edits.origin ?? 0;
  }

  /** The analysis with bar 1 where the user marked the start of the music (live while the flag is dragged). */
  function gridded() {
    return withOrigin(v.analysis, v.originDrag ? v.originDrag.time : v.edits.origin);
  }

  function recompute() {
    v.cuts = detectCuts(gridded(), v.settings);
    const built = buildSections({ duration: v.analysis.duration, cuts: v.cuts, edits: v.edits });
    v.dividers = built.dividers;
    v.sections = built.sections;
    v.hover = { section: -1, divider: -1 };
    // read by the end-to-end test
    const keys = new Set(v.sections.map((x) => x.key));
    for (const k of [...v.selected]) if (!keys.has(k)) v.selected.delete(k);
    node.dataset.duration = String(v.analysis.duration);
    node.dataset.origin = String(Math.round(gridded().origin * 10000) / 10000);
    node.dataset.flag = String(Math.round(flagTime() * 10000) / 10000);
    node.dataset.dividers = JSON.stringify(v.dividers.map((d) => Math.round(d.time * 10000) / 10000));
    node.dataset.fades = JSON.stringify(v.fades);
    updateInfo();
    draw();
    refreshHover();
    followPlaying(v.sections);
  }

  function activeSections() {
    return v.sections.filter((s) => !v.disabled.has(s.key));
  }

  function updateInfo() {
    const active = activeSections().length;
    const total = v.sections.length;
    const count = total ? `${active === total ? total : `${active}/${total}`} ${total === 1 ? "seção" : "seções"}` : "";
    bpmBtn.hidden = !v.analysis || !bpmInput.hidden;
    if (v.analysis) {
      bpmBtn.textContent = `${formatBpm(v.analysis.bpm, v.bpm != null)} BPM`;
      bpmBtn.classList.toggle("is-manual", v.bpm != null);
      bpmBtn.title =
        v.bpm != null
          ? `Andamento informado: ${formatBpm(v.bpm, true)} BPM (detectado ${v.detected.bpm.toFixed(1)}) · clique para mudar; vazio volta ao detectado`
          : `Andamento estimado ${v.analysis.bpm.toFixed(1)} BPM · clique para informar o andamento certo`;
    }
    infoText.textContent = v.analysis && count ? ` · ${count}` : count;
    info.title = v.analysis ? `${v.analysis.onsets.length} transientes candidatos` : "";
    node.dataset.sections = String(total);
    node.dataset.selected = String(v.selected.size);
    node.dataset.active = String(active);
    node.dataset.disabled = JSON.stringify(v.sections.flatMap((x, i) => (v.disabled.has(x.key) ? [i] : [])));
    allBtn.disabled = v.busy || !active;
    allBtn.querySelector("span").textContent = active && active !== total ? `Baixar ${active}` : "Baixar todos";
  }

  /** A tempo as shown: whole when detected, up to two decimals when typed. */
  function formatBpm(bpm, exact) {
    return exact ? String(Math.round(bpm * 100) / 100) : String(Math.round(bpm));
  }

  function editBpm() {
    if (!v.analysis) return;
    bpmInput.value = formatBpm(v.analysis.bpm, v.bpm != null);
    bpmInput.hidden = false;
    bpmBtn.hidden = true;
    bpmInput.focus();
    bpmInput.select();
  }

  /** commit: the typed tempo (empty: back to the detected one); otherwise the field just closes. */
  function closeBpm(commit) {
    if (bpmInput.hidden) return;
    const text = bpmInput.value.trim().replace(",", ".");
    bpmInput.hidden = true;
    bpmInput.classList.remove("is-invalid");
    if (commit) {
      const value = Number(text);
      if (!text) setBpm(null);
      else if (Number.isFinite(value) && value >= MIN_BPM && value <= MAX_BPM) setBpm(Math.round(value * 100) / 100);
    }
    updateInfo();
  }

  /** The grid on the user's tempo (null: the detected one), and every cut counted on it again. */
  function setBpm(bpm) {
    const same = bpm == null ? v.bpm == null : v.bpm != null && Math.abs(bpm - v.bpm) < 1e-9;
    if (same) return;
    v.bpm = bpm;
    v.analysis = withTempo(v.detected, bpm);
    node.dataset.bpm = String(v.analysis.bpm);
    saveEdits();
    recompute();
  }

  bpmBtn.addEventListener("click", editBpm);
  bpmInput.addEventListener("keydown", (e) => {
    e.stopPropagation(); // Space, Ctrl+Z and the like are typing here
    if (e.key === "Enter") {
      e.preventDefault();
      const text = bpmInput.value.trim().replace(",", ".");
      const value = Number(text);
      if (text && !(Number.isFinite(value) && value >= MIN_BPM && value <= MAX_BPM)) {
        bpmInput.classList.add("is-invalid");
        bpmInput.title = `Um andamento entre ${MIN_BPM} e ${MAX_BPM} BPM`;
        return;
      }
      closeBpm(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeBpm(false);
    }
  });
  bpmInput.addEventListener("input", () => bpmInput.classList.remove("is-invalid"));
  bpmInput.addEventListener("blur", () => closeBpm(true));

  function setTitle(text) {
    v.title = text;
    titleEl.textContent = text;
    titleEl.title = `${text}\nClique para editar o nome`;
  }

  /** Dividers and sections as drawn: a divider being dragged sits where the pointer is. */
  function layout() {
    if (v.shift?.preview) return v.shift.preview;
    if (!v.drag?.moved) return { dividers: v.dividers, sections: v.sections };
    const dividers = v.dividers.map((d, i) => (i === v.drag.index ? { ...d, time: v.drag.time } : d));
    const sections = [];
    for (let i = 0; i + 1 < dividers.length; i++) {
      const old = v.sections[i];
      sections.push({ index: i, start: dividers[i].time, end: dividers[i + 1].time, key: old.key });
    }
    return { dividers, sections };
  }

  // ---- Drawing --------------------------------------------------------------

  const ctx = canvas.getContext("2d");
  let colors = null;
  let size = { w: 0, h: 0, dpr: 1 };

  function readColors() {
    const css = getComputedStyle(node);
    const c = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    colors = {
      wave: c("--accent", "#e8743c"),
      waveOff: c("--text-3", "#8a867d"),
      bandA: "rgba(255, 255, 255, 0.025)",
      bandB: "rgba(255, 255, 255, 0.055)",
      off: "rgba(0, 0, 0, 0.28)",
      hover: "rgba(232, 116, 60, 0.12)",
      selected: "rgba(232, 116, 60, 0.2)",
      divider: c("--text-2", "#b9b5ac"),
      pinned: c("--accent-text", "#f4a57c"),
      active: c("--accent", "#e8743c"),
      grid: "rgba(255, 255, 255, 0.07)",
      bar: "rgba(255, 255, 255, 0.16)",
      text: c("--text-3", "#8a867d"),
      label: c("--text-2", "#b9b5ac"),
      play: c("--success", "#63c28f"),
      origin: "#6fb7d9",
      ticks: ["#e8743c", "#e8a33c", "#d9c45a", "#6fb7d9", "#9a8cf0"],
      font: c("--font", "system-ui"),
    };
  }

  function resize() {
    const r = wave.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(50, Math.floor(r.width));
    const h = Math.max(60, Math.floor(r.height));
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    draw();
  }

  const span = () => v.end - v.start;
  const xOf = (t) => ((t - v.start) / span()) * size.w;
  const tOf = (x) => v.start + (x / size.w) * span();

  function draw() {
    if (!v.analysis || !size.w) return;
    if (!colors) readColors();
    placeGroup();
    drawOverview();
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const top = LANE_TOP;
    const bottom = h - LANE_BOTTOM;
    const waveH = bottom - top;
    const mid = top + waveH / 2;
    const showSlices = v.settings.slices;
    // with the slices hidden the waveform is the plain song: no bands, dividers, fades or dimmed sections
    const { dividers, sections } = showSlices ? layout() : { dividers: [], sections: [] };

    // section bands
    sections.forEach((s, i) => {
      const x0 = Math.max(0, xOf(s.start));
      const x1 = Math.min(w, xOf(s.end));
      if (x1 <= 0 || x0 >= w) return;
      const off = v.disabled.has(s.key);
      ctx.fillStyle = off ? colors.off : i % 2 ? colors.bandB : colors.bandA;
      ctx.fillRect(x0, top, x1 - x0, waveH);
      if (off) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, top, x1 - x0, waveH);
        ctx.clip();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = Math.floor(x0 / 8) * 8 - waveH; x < x1; x += 8) {
          ctx.moveTo(x, bottom);
          ctx.lineTo(x + waveH, top);
        }
        ctx.stroke();
        ctx.restore();
      }
      if (v.selected.has(s.key)) {
        ctx.fillStyle = colors.selected;
        ctx.fillRect(x0, top, x1 - x0, waveH);
        ctx.fillStyle = colors.active;
        ctx.fillRect(x0, top, x1 - x0, 2);
      } else if (i === v.hover.section && !v.drag) {
        ctx.fillStyle = colors.hover;
        ctx.fillRect(x0, top, x1 - x0, waveH);
      }
    });
    if (showSlices && v.press?.mode === "select" && v.press.moved) {
      // the band being dragged
      const a = clamp(xOf(Math.min(v.press.t0, v.press.t1)), 0, w);
      const b = clamp(xOf(Math.max(v.press.t0, v.press.t1)), 0, w);
      ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
      ctx.fillRect(a, top, b - a, waveH);
    }

    // The bar grid in the background, in proportion to the zoom: every level — 16 bars, 4 bars, a bar, a beat,
    // 1/8 … 1/64 — appears only once its lines are 12 px apart and is fully drawn at 36 px. Zoomed out, a long
    // song shows its phrases; zooming in brings bars, then beats, then the finer divisions.
    const a = gridded();
    const LEVELS = [
      ["64", 0.04],
      ["32", 0.05],
      ["16", 0.06],
      ["8", 0.075],
      ["4", 0.1],
      ["1", 0.17],
      ["4:1", 0.22],
      ["16:1", 0.27],
    ];
    const MIN_PX = 12;
    const FULL_PX = 36;
    for (const [level, base] of LEVELS) {
      const px = (gridStep(a, level) / span()) * w;
      const fade = clamp((px - MIN_PX) / (FULL_PX - MIN_PX), 0, 1);
      if (fade <= 0) continue;
      ctx.fillStyle = `rgba(255, 255, 255, ${(base * fade).toFixed(3)})`;
      for (const line of gridLines(a, level)) {
        if (line.time < v.start || line.time > v.end) continue;
        ctx.fillRect(Math.round(xOf(line.time)), top, 1, waveH);
      }
    }
    // bar numbers: bar 1 is the flag the user placed, else the first bar of the grid from the start of the audio
    const pxPerBar = (a.bar / span()) * w;
    const every = [1, 4, 16, 64].find((n) => n * pxPerBar >= 28);
    const bar1 = a.originSet ? a.origin : a.origin - Math.floor((a.origin + 0.25 * a.bar) / a.bar) * a.bar;
    if (every) {
      ctx.font = `9px ${colors.font}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "rgba(255, 255, 255, 0.32)";
      for (const line of gridLines(a, "1")) {
        if (line.time < v.start - a.bar || line.time > v.end) continue;
        const n = Math.round((line.time - bar1) / a.bar) + 1;
        if (n < 1 || (n - 1) % every !== 0) continue;
        const x = xOf(line.time);
        if (x >= -2 && x < w - 12) ctx.fillText(String(n), Math.round(x) + 3, bottom - 7);
      }
    }

    // waveform: one min/max bar per pixel column, dimmed in disabled sections
    const cols = Math.ceil(w);
    const perPixel = (span() * a.sampleRate) / w;
    const peaks = columnPeaks(v.samples, v.peaks, v.start * a.sampleRate, perPixel, cols);
    const on = new Path2D();
    const offPath = new Path2D();
    const amp = (waveH / 2) * v.gain * 0.96;
    let si = 0;
    for (let x = 0; x < cols; x++) {
      const t = tOf(x + 0.5);
      while (si < sections.length - 1 && t >= sections[si].end) si++;
      const s = sections[si];
      const inside = s && t >= s.start && t < s.end;
      const g = inside && v.fades[s.key] ? fadeGainAt(fitFade(v.fades[s.key], s.end - s.start), t - s.start, s.end - s.start) : 1;
      const lo = peaks[2 * x] * g;
      const hi = peaks[2 * x + 1] * g;
      const y1 = mid - hi * amp;
      const y2 = mid - lo * amp;
      (!showSlices || (inside && !v.disabled.has(s.key)) ? on : offPath).rect(x, y1, 1, Math.max(1, y2 - y1));
    }
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = colors.waveOff;
    ctx.fill(offPath);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.wave;
    ctx.fill(on);

    drawFades(sections, top, bottom);

    // the transients that pass the sensitivity, colored by the band that carried them (low → high): with the detection
    const threshold = v.settings.detect ? thresholdFor(v.settings.sensitivity) : Infinity;
    for (const o of a.onsets) {
      if (o.time < v.start || o.time > v.end || o.strength < threshold) continue;
      ctx.fillStyle = colors.ticks[o.band] || colors.text;
      ctx.fillRect(Math.round(xOf(o.time)) - 1, bottom - 4, 2, 4);
    }

    // dividers with their handles, and section numbers
    ctx.font = `600 10px ${colors.font}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    sections.forEach((s, i) => {
      const x0 = Math.max(0, xOf(s.start));
      const x1 = Math.min(w, xOf(s.end));
      if (x1 - x0 < 16) return; // only what is visible: a section cut by the edge keeps its number inside
      const cx = (x0 + x1) / 2;
      ctx.fillStyle = v.disabled.has(s.key) ? colors.text : colors.label;
      ctx.fillText(String(i + 1), cx, top / 2 + 1);
    });
    dividers.forEach((d, i) => {
      const x = xOf(d.time);
      if (x < -2 || x > w + 2) return;
      const hot = i === v.hover.divider || i === v.drag?.index;
      ctx.fillStyle = hot ? colors.active : d.kind === "pinned" || d.kind === "start" || d.kind === "end" ? colors.pinned : colors.divider;
      const px = Math.round(clamp(x, 0, w - 1));
      ctx.globalAlpha = hot ? 1 : 0.75;
      ctx.fillRect(px - (hot ? 1 : 0.5), top, hot ? 2 : 1, waveH);
      ctx.globalAlpha = 1;
      const hx = clamp(px - 3, 0, w - 6);
      ctx.fillRect(hx, top - 9, 6, 9);
    });

    // where playback is paused
    if (v.paused && !v.play) {
      const x = xOf(v.paused.at);
      if (x >= 0 && x <= w) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = colors.play;
        ctx.fillRect(Math.round(x), top, 2, waveH);
        ctx.globalAlpha = 1;
      }
    }

    // playhead
    if (v.play) {
      const t = playPosition();
      const x = xOf(t);
      if (x >= 0 && x <= w) {
        ctx.fillStyle = colors.play;
        ctx.fillRect(Math.round(x), top, 2, waveH);
      }
    }

    // time ruler
    const stepT = RULER_STEPS.find((s) => (s / span()) * w >= 64) || RULER_STEPS[RULER_STEPS.length - 1];
    const digits = stepT < 0.1 ? 2 : stepT < 1 ? 1 : 0;
    ctx.font = `10px ${colors.font}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (let t = Math.ceil(v.start / stepT) * stepT; t <= v.end; t += stepT) {
      const x = Math.round(xOf(t));
      ctx.fillStyle = colors.grid;
      ctx.fillRect(x, bottom, 1, 4);
      ctx.fillStyle = colors.text;
      if (x < w - 30) ctx.fillText(formatTime(t, digits), x + 3, h - 3);
    }

    // bar 1 as the user marks it: a dashed line over the waveform and a flag in the ruler to drag
    const ox = Math.round(xOf(flagTime()));
    if (ox >= -14 && ox <= w + 1) {
      const hotOrigin = v.hover.origin || v.originDrag;
      ctx.fillStyle = colors.origin;
      ctx.globalAlpha = hotOrigin ? 1 : v.edits.origin != null ? 0.85 : 0.6;
      for (let y = top; y < bottom; y += 6) ctx.fillRect(ox, y, hotOrigin ? 2 : 1, 3);
      ctx.globalAlpha = 1;
      ctx.fillRect(ox, bottom, 2, h - bottom);
      ctx.beginPath();
      ctx.moveTo(ox + 2, bottom + 1);
      ctx.lineTo(ox + 13, bottom + 5.5);
      ctx.lineTo(ox + 2, bottom + 10);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** The "music starts here" flag in the ruler is under the pointer. */
  function originHandleAt(x, y) {
    if (!v.analysis || y < size.h - LANE_BOTTOM - 3) return false;
    const ox = xOf(flagTime());
    return x >= ox - 4 && x <= ox + 15;
  }

  // ---- Fades: curves on the waveform, handles on the hovered section -------------------

  const FADE_HANDLE_Y = 6; // px below the top of the waveform area
  const CURVE_PX = 60; // vertical drag for a full curve change

  /** The fade of section s fitted to it, or null. */
  function fadeOf(s) {
    const f = v.fades[s.key];
    return f ? fitFade(f, s.end - s.start) : null;
  }

  /** Handle positions of a section's fades (px): length squares and, when there is room, curve dots. */
  function fadeHandles(s) {
    const f = fadeOf(s) || emptyFade();
    const top = LANE_TOP;
    const bottom = size.h - LANE_BOTTOM;
    const x0 = xOf(s.start);
    const x1 = xOf(s.end);
    const xi = xOf(s.start + f.in);
    const xo = xOf(s.end - f.out);
    const curveY = (g) => bottom - g * (bottom - top);
    // at, for a length handle: where the fade really ends (the square sits a little inside when the fade is 0)
    const list = [
      { which: "in", part: "len", x: Math.max(xi, x0 + 5), at: xi, y: top + FADE_HANDLE_Y },
      { which: "out", part: "len", x: Math.min(xo, x1 - 5), at: xo, y: top + FADE_HANDLE_Y },
    ];
    if (xi - x0 >= 16) list.push({ which: "in", part: "curve", x: xOf(s.start + f.in / 2), y: curveY(fadeGain(0.5, f.inCurve)) });
    if (x1 - xo >= 16) list.push({ which: "out", part: "curve", x: xOf(s.end - f.out / 2), y: curveY(fadeGain(0.5, f.outCurve)) });
    return list;
  }

  /** The fade handle of the section under (x, y), if any. */
  function fadeHandleAt(x, y) {
    const index = sectionAt(x);
    const s = v.sections[index];
    if (!s || xOf(s.end) - xOf(s.start) < 14) return null;
    let best = null;
    let bestD = Infinity;
    for (const h of fadeHandles(s)) {
      const d = h.part === "len" ? (Math.abs(h.y - y) <= 7 ? Math.abs(h.x - x) : Infinity) : Math.hypot(h.x - x, h.y - y);
      if (d <= (h.part === "len" ? 6 : 7) && d < bestD) {
        // the nearest wins: a long fade-in brings its square next to the fade-out's
        bestD = d;
        best = { index, key: s.key, which: h.which, part: h.part, grab: h.part === "len" ? x - h.at : 0 };
      }
    }
    return best;
  }

  function drawFades(sections, top, bottom) {
    const w = size.w;
    const waveH = bottom - top;
    sections.forEach((s, i) => {
      const x0 = xOf(s.start);
      const x1 = xOf(s.end);
      if (x1 <= 0 || x0 >= w) return;
      const f = fadeOf(s);
      const hot = i === v.hover.section || v.fadeDrag?.key === s.key;
      if (f && hasFade(f)) {
        for (const which of ["in", "out"]) {
          const len = which === "in" ? f.in : f.out;
          if (len <= 0) continue;
          const curve = which === "in" ? f.inCurve : f.outCurve;
          const a = which === "in" ? s.start : s.end - len;
          const px = Math.max(8, Math.ceil(xOf(a + len) - xOf(a)));
          const line = new Path2D();
          const shade = new Path2D();
          for (let k = 0; k <= px; k++) {
            const t = a + (len * k) / px;
            const xn = which === "in" ? (t - s.start) / len : (s.end - t) / len;
            const y = bottom - fadeGain(xn, curve) * waveH;
            if (k === 0) {
              line.moveTo(xOf(t), y);
              shade.moveTo(xOf(t), top);
              shade.lineTo(xOf(t), y);
            } else {
              line.lineTo(xOf(t), y);
              shade.lineTo(xOf(t), y);
            }
          }
          shade.lineTo(xOf(a + len), top);
          shade.closePath();
          ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
          ctx.fill(shade);
          ctx.strokeStyle = hot ? colors.pinned : "rgba(255, 255, 255, 0.45)";
          ctx.lineWidth = 1.5;
          ctx.stroke(line);
        }
      }
      if (!hot || v.drag || v.press?.moved || x1 - x0 < 14) return;
      for (const h of fadeHandles(s)) {
        const active =
          (v.hover.fade && v.hover.fade.key === s.key && v.hover.fade.which === h.which && v.hover.fade.part === h.part) ||
          (v.fadeDrag && v.fadeDrag.key === s.key && v.fadeDrag.which === h.which && v.fadeDrag.part === h.part);
        ctx.fillStyle = active ? colors.active : colors.pinned;
        ctx.strokeStyle = "rgba(20, 20, 19, 0.9)";
        ctx.lineWidth = 1;
        if (h.part === "len") {
          ctx.fillRect(Math.round(h.x) - 4, h.y - 4, 8, 8);
          ctx.strokeRect(Math.round(h.x) - 4.5, h.y - 4.5, 9, 9);
        } else {
          ctx.beginPath();
          ctx.arc(h.x, h.y, active ? 5 : 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    });
  }

  function curveLabel(c) {
    if (Math.abs(c) < 0.05) return "linear";
    return `${c > 0 ? "agressiva" : "suave"} ${Math.round(Math.abs(c) * 100)}%`;
  }

  /** Live update while a fade handle is dragged (the undo step is recorded on release). */
  function moveFade(x, y) {
    const d = v.fadeDrag;
    const s = v.sections.find((x2) => x2.key === d.key);
    if (!s) return;
    const length = s.end - s.start;
    const f = { ...emptyFade(), ...(v.fades[d.key] || {}) };
    if (d.part === "len") {
      const t = tOf(x - d.grab); // keeps the distance between the pointer and the fade's edge
      let len = d.which === "in" ? t - s.start : s.end - t;
      const other = d.which === "in" ? f.out : f.in;
      len = clamp(len, 0, Math.max(0, length - other));
      if ((len / span()) * size.w < 3) len = 0; // back to the edge: no fade
      f[d.which] = len;
      showTip(xOf(d.which === "in" ? s.start + len : s.end - len), `Fade-${d.which === "in" ? "in" : "out"} ${Math.round(len * 1000)} ms`);
    } else {
      const key = d.which === "in" ? "inCurve" : "outCurve";
      f[key] = clamp(d.curve0 + (d.y0 - y) / CURVE_PX, -1, 1);
      if (Math.abs(f[key]) < 0.04) f[key] = 0;
      showTip(x, `Curva ${curveLabel(f[key])}`);
    }
    if (hasFade(f) || f.inCurve || f.outCurve) v.fades[d.key] = f;
    else delete v.fades[d.key];
    d.changed = true;
    draw();
    followPlaying(v.sections);
  }

  // ---- Overview -------------------------------------------------------------------

  const octx = ocanvas.getContext("2d");
  let osize = { w: 0, h: 0, dpr: 1 };
  let obase = null; // the waveform of the whole song, drawn once per size
  const EDGE_PX = 6;

  function resizeOverview() {
    const r = overview.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(50, Math.floor(r.width));
    const h = Math.max(16, Math.floor(r.height));
    if (w === osize.w && h === osize.h && dpr === osize.dpr) return;
    osize = { w, h, dpr };
    ocanvas.width = Math.round(w * dpr);
    ocanvas.height = Math.round(h * dpr);
    ocanvas.style.width = `${w}px`;
    ocanvas.style.height = `${h}px`;
    obase = null;
    drawOverview();
  }

  const oxOf = (t) => (t / v.analysis.duration) * osize.w;
  const otOf = (x) => clamp((x / osize.w) * v.analysis.duration, 0, v.analysis.duration);

  function overviewBase() {
    if (obase) return obase;
    const { w, h, dpr } = osize;
    const c = document.createElement("canvas");
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cols = Math.ceil(w);
    const peaks = columnPeaks(v.samples, v.peaks, 0, v.samples.length / w, cols);
    const mid = h / 2;
    const amp = (h / 2 - 2) * v.gain;
    const path = new Path2D();
    for (let x = 0; x < cols; x++) {
      const y1 = mid - peaks[2 * x + 1] * amp;
      const y2 = mid - peaks[2 * x] * amp;
      path.rect(x, y1, 1, Math.max(1, y2 - y1));
    }
    g.fillStyle = colors.waveOff;
    g.globalAlpha = 0.8;
    g.fill(path);
    obase = c;
    return c;
  }

  function drawOverview() {
    if (!v.analysis || !osize.w || overview.hidden) return;
    const { w, h, dpr } = osize;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, ocanvas.width, ocanvas.height);
    octx.drawImage(overviewBase(), 0, 0);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // what is playing: its range, and a bar where the sound is now
    if (v.play) {
      octx.fillStyle = "rgba(99, 194, 143, 0.18)";
      octx.fillRect(oxOf(v.play.start), 0, Math.max(1, oxOf(v.play.end) - oxOf(v.play.start)), h);
      octx.fillStyle = colors.play;
      octx.fillRect(Math.round(oxOf(playPosition())) - 1, 0, 2, h);
    } else if (v.paused) {
      octx.globalAlpha = 0.6;
      octx.fillStyle = colors.play;
      octx.fillRect(Math.round(oxOf(v.paused.at)) - 1, 0, 2, h);
      octx.globalAlpha = 1;
    }
    // the window on what the waveform above shows
    const x0 = oxOf(v.start);
    const x1 = Math.max(x0 + 3, oxOf(v.end));
    octx.fillStyle = "rgba(232, 116, 60, 0.16)";
    octx.fillRect(x0, 0, x1 - x0, h);
    octx.strokeStyle = colors.active;
    octx.lineWidth = 1.5;
    octx.strokeRect(x0 + 0.75, 0.75, Math.max(1, x1 - x0 - 1.5), h - 1.5);
    octx.fillStyle = colors.active;
    octx.fillRect(x0, h / 2 - 6, 3, 12);
    octx.fillRect(x1 - 3, h / 2 - 6, 3, 12);
  }

  /** What a press on the overview grabs: an edge of the window (zoom), the window (move) or elsewhere (jump). */
  function overviewGrab(x) {
    const x0 = oxOf(v.start);
    const x1 = oxOf(v.end);
    const narrow = x1 - x0 < 3 * EDGE_PX;
    if (!narrow && Math.abs(x - x0) <= EDGE_PX) return "left";
    if (!narrow && Math.abs(x - x1) <= EDGE_PX) return "right";
    if (x >= x0 - (narrow ? EDGE_PX : 0) && x <= x1 + (narrow ? EDGE_PX : 0)) return "move";
    return "jump";
  }

  let odrag = null;
  ocanvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !v.analysis) return;
    e.preventDefault();
    ocanvas.setPointerCapture(e.pointerId);
    const x = e.clientX - ocanvas.getBoundingClientRect().left;
    let mode = overviewGrab(x);
    if (mode === "jump") {
      // the window jumps there, centered, and keeps following the pointer
      const width = span();
      setView(otOf(x) - width / 2, otOf(x) + width / 2);
      mode = "move";
    }
    odrag = { mode, grab: otOf(x) - v.start };
    ocanvas.style.cursor = mode === "move" ? "grabbing" : "ew-resize";
  });
  ocanvas.addEventListener("pointermove", (e) => {
    if (!v.analysis) return;
    const x = e.clientX - ocanvas.getBoundingClientRect().left;
    if (!odrag) {
      const mode = overviewGrab(x);
      ocanvas.style.cursor = mode === "move" ? "grab" : mode === "jump" ? "pointer" : "ew-resize";
      return;
    }
    const t = otOf(x);
    const minSpan = Math.min(MIN_SPAN_S, v.analysis.duration);
    if (odrag.mode === "left") setView(Math.min(t, v.end - minSpan), v.end);
    else if (odrag.mode === "right") setView(v.start, Math.max(t, v.start + minSpan));
    else {
      const width = span();
      setView(t - odrag.grab, t - odrag.grab + width);
    }
    refreshHover();
  });
  const endOverview = () => {
    odrag = null;
    ocanvas.style.cursor = "grab";
  };
  ocanvas.addEventListener("pointerup", endOverview);
  ocanvas.addEventListener("pointercancel", endOverview);
  overview.addEventListener(
    "wheel",
    (e) => {
      if (!v.analysis) return;
      e.preventDefault();
      const x = e.clientX - ocanvas.getBoundingClientRect().left;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = ((e.deltaX || e.deltaY) / osize.w) * v.analysis.duration * 0.25;
        setView(v.start + d, v.end + d);
        return;
      }
      // zoom around the point of the song under the pointer, kept where it is in the waveform above
      const anchor = otOf(x);
      const rel = clamp((anchor - v.start) / span(), 0, 1);
      const factor = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
      const width = clamp(span() * factor, Math.min(MIN_SPAN_S, v.analysis.duration), v.analysis.duration);
      setView(anchor - rel * width, anchor - rel * width + width);
    },
    { passive: false },
  );

  // ---- View: zoom and pan -------------------------------------------------------

  function setView(start, end) {
    const duration = v.analysis.duration;
    const width = clamp(end - start, Math.min(MIN_SPAN_S, duration), duration);
    const s = clamp(start, 0, duration - width);
    v.start = s;
    v.end = s + width;
    node.classList.toggle("is-zoomed", width < duration - 1e-6);
    node.dataset.view = `${v.start},${v.end}`; // read by the end-to-end test
    draw();
  }

  wave.addEventListener(
    "wheel",
    (e) => {
      if (!v.analysis) return;
      e.preventDefault();
      const x = localX(e);
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = ((e.deltaX || e.deltaY) / size.w) * span();
        setView(v.start + d, v.end + d);
      } else {
        const factor = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
        const anchor = tOf(x);
        const width = clamp(span() * factor, Math.min(MIN_SPAN_S, v.analysis.duration), v.analysis.duration);
        setView(anchor - (x / size.w) * width, anchor - (x / size.w) * width + width);
      }
      refreshHover();
    },
    { passive: false },
  );

  // ---- Pointer: hover, drag dividers, pan, click to play --------------------------

  function localX(e) {
    return e.clientX - canvas.getBoundingClientRect().left;
  }

  function localY(e) {
    return e.clientY - canvas.getBoundingClientRect().top;
  }

  function dividerAt(x) {
    let best = -1;
    let bestD = HANDLE_PX + 1;
    v.dividers.forEach((d, i) => {
      const dist = Math.abs(xOf(d.time) - x);
      if (dist <= HANDLE_PX && dist < bestD) {
        best = i;
        bestD = dist;
      }
    });
    return best;
  }

  function sectionAt(x) {
    const t = tOf(x);
    return v.sections.findIndex((s) => t >= s.start && t < s.end);
  }

  function refreshHover() {
    if (v.pointerX < 0 || v.drag || v.shift || v.press || v.fadeDrag || v.originDrag || !v.analysis) return;
    const origin = originHandleAt(v.pointerX, v.pointerY);
    const slicesOn = v.settings.slices; // hidden slices: nothing to hover but the flag
    const fade = origin || !slicesOn ? null : fadeHandleAt(v.pointerX, v.pointerY);
    const divider = fade || origin || !slicesOn ? -1 : dividerAt(v.pointerX);
    const section = fade ? fade.index : divider >= 0 || origin || !slicesOn ? -1 : sectionAt(v.pointerX);
    const fadeId = (f) => (f ? `${f.key}:${f.which}:${f.part}` : "");
    if (divider !== v.hover.divider || section !== v.hover.section || fadeId(fade) !== fadeId(v.hover.fade) || origin !== Boolean(v.hover.origin)) {
      v.hover = { divider, section, fade, origin };
      draw();
    }
    canvas.style.cursor = origin || (fade && fade.part === "len") || divider >= 0 ? "ew-resize" : fade ? "ns-resize" : "pointer";
    canvas.title = origin ? ORIGIN_TITLE : "";
    placeTools();
    placeMerge(fade || origin || !slicesOn ? -1 : mergeCandidate(v.pointerX));
  }

  const MERGE_NEAR_PX = 16;

  /**
   * The inner divider (not the song's edges) within reach of the pointer, or -1. Reach shrinks with narrow
   * neighbours, so the middle of a short section stays free to click (and play).
   */
  function mergeCandidate(x) {
    let best = -1;
    let bestD = Infinity;
    v.dividers.forEach((d, i) => {
      if (d.kind === "start" || d.kind === "end") return;
      const xd = xOf(d.time);
      const narrowest = Math.min(xd - xOf(v.dividers[i - 1].time), xOf(v.dividers[i + 1].time) - xd);
      const reach = Math.max(3, Math.min(MERGE_NEAR_PX, narrowest * 0.3));
      const dist = Math.abs(xd - x);
      if (dist <= reach && dist < bestD) {
        best = i;
        bestD = dist;
      }
    });
    return best;
  }

  function placeMerge(index) {
    const d = v.dividers[index];
    if (!d || v.drag || v.shift || v.press || v.fadeDrag || v.busy) {
      mergeBtn.hidden = true;
      delete mergeBtn.dataset.index;
      return;
    }
    const x = xOf(d.time);
    if (x < 0 || x > size.w) {
      mergeBtn.hidden = true;
      return;
    }
    mergeBtn.dataset.index = String(index);
    mergeBtn.title = `Juntar as seções ${index} e ${index + 1}`;
    mergeBtn.setAttribute("aria-label", mergeBtn.title);
    mergeBtn.hidden = false;
    const bw = mergeBtn.offsetWidth || 22;
    const bh = mergeBtn.offsetHeight || 22;
    const top = LANE_TOP;
    const bottom = size.h - LANE_BOTTOM;
    mergeBtn.style.left = `${clamp(x - bw / 2, 1, size.w - bw - 1)}px`;
    mergeBtn.style.top = `${(top + bottom) / 2 - bh / 2}px`;
  }

  /** Removes divider `index`: the section after it joins the one before (fade-in of the first, fade-out of the second). */
  function merge(index) {
    const d = v.dividers[index];
    const left = v.sections[index - 1];
    const right = v.sections[index];
    if (!d || !left || !right || d.kind === "start" || d.kind === "end") return;
    change(() => {
      v.edits = removeDivider(v.edits, d);
      const fl = v.fades[left.key];
      const fr = v.fades[right.key];
      if (fl || fr) {
        const f = { ...emptyFade(), ...(fl || {}) };
        f.out = fr?.out || 0;
        f.outCurve = fr?.outCurve || 0;
        if (hasFade(f) || f.inCurve || f.outCurve) v.fades[left.key] = f;
        else delete v.fades[left.key];
      }
      delete v.fades[right.key];
      if (v.selected.delete(right.key)) v.selected.add(left.key);
      v.disabled.delete(right.key);
    });
    mergeBtn.hidden = true;
  }

  mergeBtn.addEventListener("click", () => merge(Number(mergeBtn.dataset.index)));

  /** The selected sections when they are two or more in a row (indexes first … last), else null. */
  function groupRange() {
    if (v.selected.size < 2 || !v.settings.slices) return null;
    const idx = v.sections.flatMap((x, i) => (v.selected.has(x.key) ? [i] : []));
    if (idx.length < 2 || idx[idx.length - 1] - idx[0] !== idx.length - 1) return null;
    return { first: idx[0], last: idx[idx.length - 1] };
  }

  function placeGroup() {
    const r = groupRange();
    if (!r || v.drag || v.shift || v.press || v.fadeDrag || v.originDrag || v.busy) {
      groupBtn.hidden = true;
      return;
    }
    const x0 = Math.max(0, xOf(v.sections[r.first].start));
    const x1 = Math.min(size.w, xOf(v.sections[r.last].end));
    if (x1 <= 0 || x0 >= size.w) {
      groupBtn.hidden = true;
      return;
    }
    const n = r.last - r.first + 1;
    groupBtn.title = `Agrupar as ${n} seções selecionadas numa só (Ctrl+G)`;
    groupBtn.setAttribute("aria-label", groupBtn.title);
    groupBtn.hidden = false;
    const bw = groupBtn.offsetWidth || 22;
    const bh = groupBtn.offsetHeight || 22;
    groupBtn.style.left = `${clamp((x0 + x1) / 2 - bw / 2, 1, size.w - bw - 1)}px`;
    // a quarter down the waveform: the middle stays free to hover the sections (and their tools at the bottom)
    groupBtn.style.top = `${LANE_TOP + (size.h - LANE_BOTTOM - LANE_TOP) / 4 - bh / 2}px`;
  }

  /** Joins the selected sections in a row into one: fade-in of the first, fade-out of the last, the first's on/off. */
  function group() {
    const r = groupRange();
    if (!r || v.drag || v.shift) return;
    const first = v.sections[r.first];
    const last = v.sections[r.last];
    const inner = v.dividers.slice(r.first + 1, r.last + 1); // the dividers between them
    change(() => {
      for (const d of inner) v.edits = removeDivider(v.edits, d);
      // and any automatic cut a removed divider was hiding
      for (const c of v.cuts) if (c > first.start + 1e-6 && c < last.end - 1e-6) v.edits = removeDivider(v.edits, { kind: "auto", time: c });
      const ff = v.fades[first.key];
      const fl = v.fades[last.key];
      if (ff || fl) {
        const f = { ...emptyFade(), ...(ff || {}) };
        f.out = fl?.out || 0;
        f.outCurve = fl?.outCurve || 0;
        if (hasFade(f) || f.inCurve || f.outCurve) v.fades[first.key] = f;
        else delete v.fades[first.key];
      }
      for (let i = r.first + 1; i <= r.last; i++) {
        const k = v.sections[i].key;
        delete v.fades[k];
        v.disabled.delete(k);
        v.selected.delete(k);
      }
      v.selected = new Set([first.key]);
    });
    groupBtn.hidden = true;
  }

  groupBtn.addEventListener("click", group);
  mergeBtn.addEventListener("pointerleave", (e) => {
    if (e.relatedTarget === canvas || tools.contains(e.relatedTarget)) return;
    mergeBtn.hidden = true;
  });

  /** The sections the hover buttons act on: the whole selection when the pointer is on it, else the hovered one. */
  function targets() {
    const hovered = v.sections[v.hover.section];
    if (!hovered) return [];
    if (v.selected.has(hovered.key) && v.selected.size > 1) return v.sections.filter((x) => v.selected.has(x.key));
    return [hovered];
  }

  function placeTools() {
    const list = targets();
    if (!list.length || v.drag || v.shift || v.press || v.fadeDrag || v.busy) {
      hideTools();
      return;
    }
    const many = list.length > 1;
    const n = list.length;
    const anyOn = list.some((x) => !v.disabled.has(x.key));
    toolToggle.replaceChildren(icon(anyOn ? ICONS.disable : ICONS.enable));
    let label = anyOn ? "Desativar esta seção" : "Ativar esta seção";
    if (many) label = anyOn ? `Desativar as ${n} seções selecionadas` : `Ativar as ${n} seções selecionadas`;
    toolToggle.title = label;
    toolToggle.setAttribute("aria-label", label);
    const edited = list.some((x) => isSectionEdited(v.edits, v.dividers, x.index));
    toolReset.disabled = !edited;
    if (!edited) toolReset.title = many ? "As seções selecionadas estão do tamanho detectado" : "A seção está do tamanho detectado";
    else toolReset.title = many ? `Voltar as ${n} seções selecionadas ao tamanho original` : "Voltar a seção ao tamanho original";
    toolReset.setAttribute("aria-label", toolReset.title);
    const s = list[0];
    toolDownload.title = many
      ? `Baixar as ${n} seções selecionadas (um arquivo cada)`
      : `Baixar a seção ${s.index + 1} (${formatTime(s.start)} – ${formatTime(s.end)})`;
    toolDownload.setAttribute("aria-label", toolDownload.title);
    toolSplit.title = many ? `Dividir cada uma das ${n} seções em duas partes iguais` : "Dividir a seção em duas partes iguais";
    toolDouble.title = many
      ? `Dobrar cada uma das ${n} seções (junta o que vier depois até o dobro)`
      : "Dobrar a seção (junta o que vier depois até o dobro do tamanho)";
    tools.hidden = false;
    const tw = tools.offsetWidth || 86;
    const x0 = Math.max(0, xOf(list[0].start));
    const x1 = Math.min(size.w, xOf(list[list.length - 1].end));
    const left = clamp((x0 + x1) / 2 - tw / 2, 2, size.w - tw - 2);
    const top = size.h - LANE_BOTTOM - 34; // low: the fade handles live at the top
    tools.style.left = `${left}px`;
    tools.style.top = `${top}px`;
    // one section at a time, and only when there is somewhere to go
    moveBtn.hidden = many || v.sections.length < 2;
    if (!moveBtn.hidden) {
      moveBtn.dataset.index = String(s.index);
      const bw = moveBtn.offsetWidth || 22;
      const bh = moveBtn.offsetHeight || 22;
      moveBtn.style.left = `${left + tw / 2 - bw / 2}px`;
      moveBtn.style.top = `${top - bh - 2}px`;
    }
  }

  function hideTools() {
    tools.hidden = true;
    moveBtn.hidden = true;
  }

  // ---- Moving a section (keeps its length) ---------------------------------------
  // The section slides along the song; whatever it lands on gives way (shrinks, or goes away when fully covered),
  // and the space it leaves behind becomes a new section, disabled. Its start or end snaps to the grid lines and to
  // the transient marks (Alt: free); an edge close to another divider or to the song's edges lands on it.

  /** Grid lines (the chosen division; Auto and the transient sections use 1/16) and the transient marks shown, sorted. */
  function shiftSnaps() {
    const a = gridded();
    const g = GRIDS.includes(v.settings.grid) && v.settings.grid !== "auto" ? v.settings.grid : "16";
    const threshold = thresholdFor(v.settings.sensitivity);
    const times = gridLines(a, g).map((l) => l.time);
    if (v.settings.detect) for (const o of a.onsets) if (o.strength >= threshold) times.push(o.time); // the marks show with it
    return times.sort((x, y) => x - y);
  }

  function nearestIn(sorted, t) {
    let lo = 0;
    let hi = sorted.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const after = sorted[lo];
    const before = lo > 0 ? sorted[lo - 1] : after;
    return Math.abs(before - t) <= Math.abs(after - t) ? before : after;
  }

  /** Where the dragged section starts for pointer x: inside the song, snapped unless free. */
  function shiftTime(x, free) {
    const { len, grab, lo, hi } = v.shift;
    let t = clamp(tOf(x) - grab, lo, hi);
    if (!free) {
      const tol = (SNAP_PX / size.w) * span();
      let best = null;
      let bestD = tol;
      for (const off of [0, len]) {
        const c = nearestIn(v.shift.snaps, t + off);
        const d = c === null ? Infinity : Math.abs(c - (t + off));
        if (d <= bestD && c - off >= lo - 1e-9 && c - off <= hi + 1e-9) {
          best = c - off;
          bestD = d;
        }
      }
      if (best !== null) t = best;
    }
    // no sliver of a section: an edge this close to another divider (or the song's edges) lands on it
    for (const d of v.shift.dividers) {
      if (Math.abs(d.time - t) < MIN_GAP_S) t = d.time;
      else if (Math.abs(d.time - (t + len)) < MIN_GAP_S) t = d.time - len;
    }
    return clamp(t, lo, hi);
  }

  /**
   * The song after moving the section to start at `t`, from the state the drag started on: edits (the dividers it now
   * covers removed, its two edges added), sections, and which of them are disabled and faded.
   */
  function shiftResult(state, t) {
    const { section, len, dividers, sections, disabled, fades } = state;
    const e = t + len;
    const inside = (time) => time > t + 1e-6 && time < e - 1e-6;
    let edits = state.edits;
    for (const d of dividers) {
      if (d.kind !== "start" && d.kind !== "end" && inside(d.time)) edits = removeDivider(edits, d);
    }
    // and any automatic cut a removed divider was hiding
    for (const c of v.cuts) if (inside(c)) edits = removeDivider(edits, { kind: "auto", time: c });
    const kept = (time) => dividers.some((d) => Math.abs(d.time - time) < 1e-6);
    if (!kept(t)) edits = addDivider(edits, t);
    if (!kept(e)) edits = addDivider(edits, e);
    const built = buildSections({ duration: v.analysis.duration, cuts: v.cuts, edits });
    const nextDisabled = new Set();
    const nextFades = {};
    for (const x of built.sections) {
      const mid = (x.start + x.end) / 2;
      let source = null;
      let off = false;
      if (Math.abs(x.start - t) < 1e-6) {
        source = section; // the moved one keeps its state and fades
        off = disabled.has(section.key);
      } else if (mid > section.start && mid < section.end) {
        off = true; // the space it left
      } else {
        source = sections.find((o) => mid >= o.start && mid < o.end) || null; // what is left of a section it covered
        off = Boolean(source && disabled.has(source.key));
      }
      if (off) nextDisabled.add(x.key);
      const f = source && fades[source.key];
      if (f) nextFades[x.key] = Math.abs(x.end - x.start - (source.end - source.start)) < 1e-6 ? f : fitFade(f, x.end - x.start);
    }
    return { edits, built, disabled: nextDisabled, fades: nextFades, key: sectionKey(t) };
  }

  moveBtn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !v.analysis || v.busy) return;
    const section = v.sections[Number(moveBtn.dataset.index)];
    if (!section) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(v.clickTimer);
    const first = v.dividers[0].time;
    const last = v.dividers[v.dividers.length - 1].time;
    const len = section.end - section.start;
    v.shift = {
      section,
      len,
      grab: tOf(localX(e)) - section.start,
      lo: first,
      hi: Math.max(first, last - len),
      time: section.start,
      moved: false,
      preview: null,
      snaps: shiftSnaps(),
      dividers: v.dividers,
      sections: v.sections,
      edits: v.edits,
      disabled: v.disabled,
      fades: v.fades,
    };
    canvas.setPointerCapture(e.pointerId); // the moves and the release go to the canvas
    hideTools();
    mergeBtn.hidden = true;
    canvas.style.cursor = "grabbing";
  });

  function moveShift(x, free) {
    const t = shiftTime(x, free);
    if (Math.abs(t - v.shift.time) < 1e-9 && v.shift.moved) return;
    if (!v.shift.moved && Math.abs(t - v.shift.section.start) < 1e-9) return;
    v.shift.time = t;
    v.shift.moved = true;
    const r = shiftResult(v.shift, t);
    v.shift.preview = r.built;
    // drawn as it would be: the space left disabled, what it covers shrunk (put back if the drag is cancelled)
    v.disabled = r.disabled;
    v.fades = r.fades;
    showTip(xOf(t), `${formatTime(t, 3)} – ${formatTime(t + v.shift.len, 3)}`);
    draw();
    followPlaying(r.built.sections);
  }

  function endShift(cancelled) {
    const state = v.shift;
    v.shift = null;
    tip.hidden = true;
    canvas.style.cursor = "";
    v.disabled = state.disabled;
    v.fades = state.fades;
    if (!state.moved || cancelled || Math.abs(state.time - state.section.start) < 1e-6) {
      draw();
      return;
    }
    const r = shiftResult(state, state.time);
    change(() => {
      v.edits = r.edits;
      v.disabled = r.disabled;
      v.fades = r.fades;
      const keys = new Set(r.built.sections.map((x) => x.key));
      const wasSelected = v.selected.delete(state.section.key);
      for (const k of [...v.selected]) if (!keys.has(k)) v.selected.delete(k);
      if (wasSelected) v.selected.add(r.key);
    });
  }

  /** Sections intersecting [a, b] (seconds), by key. */
  function keysBetween(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return v.sections.filter((x) => x.end > lo && x.start < hi).map((x) => x.key);
  }

  function showTip(x, text) {
    tip.hidden = false;
    tip.textContent = text;
    const tw = tip.offsetWidth || 60;
    tip.style.left = `${clamp(x - tw / 2, 2, size.w - tw - 2)}px`;
  }

  /** Where a dragged divider may go: between its neighbours, snapped to a transient unless Alt is held. */
  function dragTime(x, free) {
    const i = v.drag.index;
    const lo = i > 0 ? v.dividers[i - 1].time + MIN_GAP_S : 0;
    const hi = i < v.dividers.length - 1 ? v.dividers[i + 1].time - MIN_GAP_S : v.analysis.duration;
    let t = clamp(tOf(x), lo, hi);
    if (!free) {
      const o = nearestOnset(v.analysis.onsets, t, (SNAP_PX / size.w) * span());
      if (o && o.time >= lo && o.time <= hi) t = o.time;
    }
    return t;
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // the right button drags the view
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button > 2 || !v.analysis) return;
    e.preventDefault(); // the middle button would start the browser's autoscroll
    const x = localX(e);
    const y = localY(e);
    canvas.setPointerCapture(e.pointerId);
    hideTools();
    mergeBtn.hidden = true;
    if (e.button === 1 || e.button === 2) {
      v.press = { mode: "pan", x, start: v.start, end: v.end, moved: false };
      return;
    }
    // Alt + click plays from exactly that point, wherever it lands (a divider, a fade handle, the flag): the press
    // starts as usual (Alt also frees a drag from the snaps) and, released without moving, it is the click
    v.altClick = e.button === 0 && e.altKey ? { x } : null;
    if (originHandleAt(x, y)) {
      const at = flagTime();
      v.originDrag = { time: at, grab: x - xOf(at), moved: false }; // keeps where the flag was grabbed
      canvas.style.cursor = "ew-resize";
      return;
    }
    if (v.settings.slices) {
      const fade = fadeHandleAt(x, y);
      if (fade) {
        const f = v.fades[fade.key] || emptyFade();
        v.fadeDrag = { ...fade, y0: y, curve0: fade.which === "in" ? f.inCurve : f.outCurve, before: snapshot(), changed: false };
        return;
      }
      const di = dividerAt(x);
      if (di >= 0) {
        v.drag = { index: di, divider: v.dividers[di], time: v.dividers[di].time, moved: false };
        canvas.style.cursor = "ew-resize";
        return;
      }
    }
    // a drag selects (Ctrl/Shift adds); a click plays the section (the slices hidden: the song from there),
    // Ctrl + click adds the section next to the selection, Shift + click toggles any
    const near = e.ctrlKey || e.metaKey;
    const add = near || e.shiftKey;
    v.press = { mode: "select", x, t0: tOf(x), t1: tOf(x), add, near, base: add ? new Set(v.selected) : new Set(), moved: false };
  });

  canvas.addEventListener("pointermove", (e) => {
    v.pointerX = localX(e);
    v.pointerY = localY(e);
    if (v.altClick && Math.abs(v.pointerX - v.altClick.x) >= 4) v.altClick = null; // a drag, not a click
    if (!v.analysis) return;
    if (v.shift) {
      moveShift(v.pointerX, e.altKey);
      return;
    }
    if (v.originDrag) {
      // snaps to the nearest transient (Alt: free); the grid and its cuts follow live
      let t = clamp(tOf(v.pointerX - v.originDrag.grab), 0, v.analysis.duration - MIN_SPAN_S);
      if (!e.altKey) {
        const o = nearestOnset(v.analysis.onsets, t, (SNAP_PX / size.w) * span());
        if (o) t = o.time;
      }
      if (t !== v.originDrag.time) {
        v.originDrag.time = t;
        v.originDrag.moved = true;
        recompute();
        showTip(xOf(t), `Início ${formatTime(t, 3)}`);
        draw();
      }
      return;
    }
    if (v.fadeDrag) {
      moveFade(v.pointerX, v.pointerY);
      return;
    }
    if (v.drag) {
      const t = dragTime(v.pointerX, e.altKey);
      if (t !== v.drag.time || v.drag.moved) {
        v.drag.time = t;
        v.drag.moved = true;
        showTip(xOf(t), formatTime(t, 3));
        draw();
        followPlaying(layout().sections);
      }
      return;
    }
    if (v.press) {
      const dx = v.pointerX - v.press.x;
      if (!v.press.moved && Math.abs(dx) < 4) return;
      v.press.moved = true;
      if (v.press.mode === "pan") {
        canvas.style.cursor = "grabbing";
        const shift = (-dx / size.w) * (v.press.end - v.press.start);
        setView(v.press.start + shift, v.press.end + shift);
        return;
      }
      if (!v.settings.slices) return; // nothing to select
      v.press.t1 = clamp(tOf(v.pointerX), 0, v.analysis.duration);
      v.selected = new Set([...v.press.base, ...keysBetween(v.press.t0, v.press.t1)]);
      updateInfo();
      draw();
      return;
    }
    refreshHover();
  });

  /** The end of a press; an Alt + click (no move) puts back whatever it grabbed and plays from that point. */
  function endPointer(e, cancelled = false) {
    const alt = !cancelled && v.altClick;
    v.altClick = null;
    finishPress(cancelled || Boolean(alt));
    if (alt) {
      clearTimeout(v.clickTimer);
      playFrom(tOf(alt.x));
    }
  }

  function finishPress(cancelled) {
    if (v.shift) {
      endShift(cancelled);
      refreshHover();
      return;
    }
    if (v.originDrag) {
      const { time, moved } = v.originDrag;
      v.originDrag = null;
      tip.hidden = true;
      if (moved && !cancelled && Math.abs(time - (v.edits.origin ?? 0)) > 1e-6) {
        change(() => {
          v.edits = { ...v.edits, origin: time };
        });
      } else {
        recompute();
      }
      draw();
      refreshHover();
      return;
    }
    if (v.fadeDrag) {
      const { before, changed } = v.fadeDrag;
      v.fadeDrag = null;
      tip.hidden = true;
      if (changed && cancelled) {
        v.fades = before.fades;
      } else if (changed) {
        v.undo.push(before);
        v.redo = [];
        afterChange();
      }
      draw();
      refreshHover();
      return;
    }
    if (v.drag) {
      const { divider, time, moved } = v.drag;
      v.drag = null;
      tip.hidden = true;
      if (moved && !cancelled && Math.abs(time - divider.time) > 1e-6) {
        change(() => {
          if (divider.kind !== "end") rekey(sectionKey(divider.time), sectionKey(time));
          v.edits = moveDivider(v.edits, divider, time);
        });
      } else {
        draw();
      }
    } else if (v.press) {
      const { moved, x, mode, add, near } = v.press;
      v.press = null;
      if (!moved && !cancelled && mode === "select") {
        const section = sectionAt(x);
        clearTimeout(v.clickTimer);
        if (!v.settings.slices) {
          playFrom(tOf(x));
        } else if (near) {
          selectNext(section);
        } else if (add) {
          // Shift + click: the section joins or leaves the selection
          const key = v.sections[section]?.key;
          if (key !== undefined && !v.selected.delete(key)) v.selected.add(key);
        } else {
          v.selected.clear();
          v.clickTimer = setTimeout(() => togglePlay(section), CLICK_DELAY_MS);
        }
        updateInfo();
      }
      draw();
    }
    refreshHover();
  }

  /**
   * Ctrl + click: with nothing selected, any section; otherwise only one right next to a selected one, so the
   * selection grows in one piece. A selected one leaves it from the ends (one in the middle would split it).
   */
  function selectNext(index) {
    const s = v.sections[index];
    if (!s) return;
    const selectedAt = (k) => Boolean(v.sections[k] && v.selected.has(v.sections[k].key));
    if (v.selected.has(s.key)) {
      if (!(selectedAt(index - 1) && selectedAt(index + 1))) v.selected.delete(s.key);
      else flashTip(xOf((s.start + s.end) / 2), "Ctrl+clique: tire pelas pontas da seleção");
      return;
    }
    if (!v.selected.size || selectedAt(index - 1) || selectedAt(index + 1)) v.selected.add(s.key);
    else flashTip(xOf((s.start + s.end) / 2), "Ctrl+clique: só um trecho ao lado da seleção");
  }

  let tipTimer = 0;
  function flashTip(x, text) {
    showTip(x, text);
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (!v.drag && !v.shift && !v.fadeDrag && !v.originDrag) tip.hidden = true;
    }, 1400);
  }

  canvas.addEventListener("pointerup", (e) => endPointer(e));
  canvas.addEventListener("pointercancel", (e) => endPointer(e, true));
  canvas.addEventListener("pointerleave", (e) => {
    if (v.drag || v.shift || v.press || v.originDrag) return;
    if (tools.contains(e.relatedTarget) || mergeBtn.contains(e.relatedTarget) || moveBtn.contains(e.relatedTarget)) return;
    v.pointerX = -1;
    hideTools();
    mergeBtn.hidden = true;
    if (v.hover.section !== -1 || v.hover.divider !== -1 || v.hover.origin) {
      v.hover = { section: -1, divider: -1 };
      draw();
    }
  });
  const leaveTools = (e) => {
    if (v.shift || e.relatedTarget === canvas || mergeBtn.contains(e.relatedTarget)) return;
    if (tools.contains(e.relatedTarget) || moveBtn.contains(e.relatedTarget)) return;
    mergeBtn.hidden = true;
    v.pointerX = -1;
    hideTools();
    v.hover = { section: -1, divider: -1 };
    draw();
  };
  tools.addEventListener("pointerleave", leaveTools);
  moveBtn.addEventListener("pointerleave", leaveTools);

  canvas.addEventListener("dblclick", (e) => {
    if (!v.analysis) return;
    clearTimeout(v.clickTimer);
    if (e.ctrlKey || e.metaKey) return; // two Ctrl+clicks pick sections, they make no divider
    const x = localX(e);
    if (originHandleAt(x, localY(e))) {
      // back to where the analysis found the start
      if (v.edits.origin != null) {
        change(() => {
          v.edits = { ...v.edits, origin: null };
        });
        draw();
      }
      return;
    }
    if (!v.settings.slices) return; // no dividers to add or remove while they are hidden
    const fade = fadeHandleAt(x, localY(e));
    if (fade) {
      // length handle: no fade; curve dot: back to linear
      change(() => {
        const f = { ...emptyFade(), ...(v.fades[fade.key] || {}) };
        if (fade.part === "len") {
          f[fade.which] = 0;
          f[fade.which === "in" ? "inCurve" : "outCurve"] = 0;
        } else {
          f[fade.which === "in" ? "inCurve" : "outCurve"] = 0;
        }
        if (hasFade(f) || f.inCurve || f.outCurve) v.fades[fade.key] = f;
        else delete v.fades[fade.key];
      });
      return;
    }
    const di = dividerAt(x);
    if (di >= 0) {
      const d = v.dividers[di];
      change(() => {
        v.edits = removeDivider(v.edits, d);
      });
    } else {
      let t = tOf(x);
      if (!e.altKey) {
        const o = nearestOnset(v.analysis.onsets, t, (SNAP_PX / size.w) * span());
        if (o) t = o.time;
      }
      if (t <= MIN_GAP_S || t >= v.analysis.duration - MIN_GAP_S) return;
      change(() => {
        v.edits = addDivider(v.edits, t);
      });
    }
  });

  toolToggle.addEventListener("click", () => {
    const list = targets();
    if (!list.length) return;
    const disable = list.some((x) => !v.disabled.has(x.key));
    change(() => {
      for (const x of list) {
        if (disable) v.disabled.add(x.key);
        else v.disabled.delete(x.key);
      }
    });
  });

  /** After the dividers changed: the section that held `oldKey` now starting at `start` keeps its state. */
  const at = () => buildSections({ duration: v.analysis.duration, cuts: v.cuts, edits: v.edits });

  toolSplit.addEventListener("click", () => {
    const list = targets();
    if (!list.length) return;
    change(() => {
      for (const s of list) {
        v.edits = splitSection(v.edits, s);
        const half = s.start + (s.end - s.start) / 2;
        const rightKey = sectionKey(half);
        // the fade-out moves to the second half; a disabled or selected section stays so in both halves
        const f = v.fades[s.key];
        if (f && f.out > 0) {
          v.fades[rightKey] = { ...emptyFade(), out: f.out, outCurve: f.outCurve };
          v.fades[s.key] = { ...f, out: 0, outCurve: 0 };
        }
        if (v.disabled.has(s.key)) v.disabled.add(rightKey);
        if (v.selected.has(s.key)) v.selected.add(rightKey);
      }
    });
  });

  toolDouble.addEventListener("click", () => {
    const list = targets();
    if (!list.length) return;
    change(() => {
      // one by one, from the first: a section a previous one swallowed is skipped
      for (const s of list) {
        const now = at();
        const i = now.sections.findIndex((x) => Math.abs(x.start - s.start) < 1e-6);
        if (i < 0) continue;
        const before = now.sections;
        v.edits = multiplySection(v.edits, now.dividers, i, v.analysis.duration);
        const grown = at().sections.find((x) => Math.abs(x.start - s.start) < 1e-6);
        if (!grown) continue;
        // the sections it now covers hand it their fade-out and leave their state behind
        const swallowed = before.filter((x) => x.start > s.start + 1e-6 && x.start < grown.end - 1e-6);
        const lastF = swallowed.length ? v.fades[swallowed[swallowed.length - 1].key] : null;
        for (const x of swallowed) {
          delete v.fades[x.key];
          v.disabled.delete(x.key);
          v.selected.delete(x.key);
        }
        if (lastF && lastF.out > 0) v.fades[s.key] = { ...emptyFade(), ...(v.fades[s.key] || {}), out: lastF.out, outCurve: lastF.outCurve };
      }
    });
  });

  toolReset.addEventListener("click", () => {
    const list = targets().filter((x) => isSectionEdited(v.edits, v.dividers, x.index));
    if (!list.length) return;
    const wasSelected = list.map((x) => v.selected.has(x.key));
    change(() => {
      // one by one, each found again by its middle: resetting one moves the dividers of the next
      list.forEach((s, n) => {
        const mid = (s.start + s.end) / 2;
        const before = at();
        const i = before.sections.findIndex((x) => mid >= x.start && mid < x.end);
        if (i < 0) return;
        const key = before.sections[i].key;
        v.edits = resetSection(v.edits, before.dividers, i);
        const back = at().sections.find((x) => mid >= x.start && mid < x.end);
        if (!back) return;
        // a disabled or selected section, and its fades, stay so at its original size
        rekey(key, back.key);
        if (wasSelected[n]) {
          v.selected.delete(key);
          v.selected.add(back.key);
        }
      });
    });
  });

  /** A section that now starts elsewhere keeps being disabled and keeps its fades. */
  function rekey(from, to) {
    if (from === to) return;
    if (v.disabled.delete(from)) v.disabled.add(to);
    if (v.fades[from]) {
      v.fades[to] = v.fades[from];
      delete v.fades[from];
    }
  }

  // ---- Undo / redo ---------------------------------------------------------------
  // Every edit (dividers moved, added, removed, sections disabled or reset) can be undone with
  // Ctrl+Z and redone with Ctrl+Shift+Z or Ctrl+Y. Sensitivity and grid are settings, not edits.

  const MAX_UNDO = 200;
  // withGrid: the change also chose the grid (the transient recut), so undoing it puts the grid back too
  const snapshot = (withGrid = false) => ({
    edits: structuredClone(v.edits),
    disabled: [...v.disabled],
    fades: structuredClone(v.fades),
    ...(withGrid ? { grid: v.settings.grid } : {}),
  });

  function change(apply, { withGrid = false } = {}) {
    v.undo.push(snapshot(withGrid));
    if (v.undo.length > MAX_UNDO) v.undo.shift();
    v.redo = [];
    apply();
    afterChange();
  }

  function afterChange() {
    saveEdits();
    recompute();
    undoBtn.disabled = !v.undo.length;
    redoBtn.disabled = !v.redo.length;
  }

  function travel(from, to) {
    if (!v.analysis || !from.length || v.drag) return;
    const state = from.pop();
    to.push(snapshot(state.grid !== undefined));
    v.edits = state.edits;
    v.disabled = new Set(state.disabled);
    v.fades = state.fades || {};
    if (state.grid !== undefined) {
      applyGrid(state.grid);
      paintControls();
    }
    afterChange();
  }

  // the recut: the sections from the transient marks, the dividers the user placed or moved gone (trims and bar 1 stay)
  recutBtn.addEventListener("click", () => {
    if (!v.analysis || !v.settings.detect || v.drag) return;
    change(
      () => {
        v.edits = { ...emptyEdits(), start: v.edits.start, end: v.edits.end, origin: v.edits.origin };
        applyGrid(TRANSIENT_GRID);
        paintControls();
      },
      { withGrid: true },
    );
  });

  const undo = () => travel(v.undo, v.redo);
  const redo = () => travel(v.redo, v.undo);
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);

  function onKey(e) {
    if (e.key === " " && v.analysis && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target;
      // not while typing, and not on a button (Space clicks it already)
      if (!(target instanceof HTMLInputElement && target.type !== "range" && target.type !== "checkbox") && !(target instanceof HTMLButtonElement)) {
        e.preventDefault();
        playPause();
      }
      return;
    }
    if (!v.analysis || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "a" && v.settings.slices) {
      v.selected = new Set(v.sections.map((x) => x.key));
      updateInfo();
      draw();
      e.preventDefault();
      return;
    }
    if (key === "g" && !e.shiftKey && v.settings.slices) {
      e.preventDefault();
      group();
      return;
    }
    if (key === "z" && !e.shiftKey) undo();
    else if ((key === "z" && e.shiftKey) || key === "y") redo();
    else return;
    e.preventDefault();
  }
  document.addEventListener("keydown", onKey);

  // Alt held: the waveform plays from wherever it is clicked, so the buttons floating on it step aside
  const seeking = (on) => node.classList.toggle("is-seeking", Boolean(on));
  const onModifier = (e) => {
    if (e.key === "Alt") seeking(e.type === "keydown");
  };
  const onBlurWindow = () => seeking(false);
  document.addEventListener("keydown", onModifier);
  document.addEventListener("keyup", onModifier);
  window.addEventListener("blur", onBlurWindow);
  wave.addEventListener("pointermove", (e) => seeking(e.altKey));

  toolDownload.addEventListener("click", () => {
    // one file per section, numbered by its place in the song
    const list = targets().map((x) => segmentOf(x, x.index + 1));
    if (list.length) exportSections(list, false, toolDownload);
  });

  allBtn.addEventListener("click", () => {
    const list = activeSections().map((s, i) => segmentOf(s, i + 1));
    if (list.length) exportSections(list, true, allBtn);
  });

  /** What Cachalot cuts for a section: its range, number and fades. */
  function segmentOf(s, number) {
    const seg = { start: s.start, end: s.end, number };
    const f = fadeOf(s);
    if (f && hasFade(f)) Object.assign(seg, { fadeIn: f.in, fadeInCurve: f.inCurve, fadeOut: f.out, fadeOutCurve: f.outCurve });
    return seg;
  }

  // ---- Listening ---------------------------------------------------------------

  function audioOut() {
    if (v.audio) return v.audio;
    const actx = new AudioContext();
    const buffer = actx.createBuffer(1, v.samples.length, v.analysis.sampleRate);
    buffer.copyToChannel(v.samples, 0);
    v.audio = { ctx: actx, buffer };
    return v.audio;
  }

  function stopPlay() {
    if (!v.play) return;
    const { source } = v.play;
    v.play = null;
    paintPlay();
    delete node.dataset.playing;
    delete node.dataset.playRange;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // already ended
    }
    cancelAnimationFrame(v.raf);
    draw();
  }

  /** Where the section being heard is now (wraps around while looping). */
  function playPosition() {
    const p = v.play;
    const elapsed = p.ctx.currentTime - p.at;
    const length = p.end - p.start;
    return p.loop && length > 0 ? p.start + ((p.offset - p.start + elapsed) % length) : p.offset + elapsed;
  }

  /** Plays [start, end) of the song from `offset`; with Loop on it goes round until stopped. */
  function playRange(index, start, end, offset = start, section = v.sections[index]) {
    const { ctx: actx, buffer } = audioOut();
    actx.resume().catch(() => {});
    const source = actx.createBufferSource();
    source.connect(actx.destination);
    const looping = v.settings.loop;
    const s = section;
    const f = s && Math.abs(s.start - start) < 1e-6 ? fadeOf(s) : null;
    const whole = start <= 0 && end >= v.analysis.duration;
    if ((f && hasFade(f)) || !whole) {
      // a part of the song plays from its own copy, as it will be saved: its fades and the 2/3 ms anti-click ramps
      // at both edges (a cut rarely falls where the wave crosses zero: without them each loop starts with a pop)
      const rate = v.analysis.sampleRate;
      const part = applyFades(v.samples.subarray(Math.floor(start * rate), Math.ceil(end * rate)), rate, f && hasFade(f) ? f : null, {
        declick: true,
      });
      const own = actx.createBuffer(1, Math.max(1, part.length), rate);
      own.copyToChannel(part, 0);
      source.buffer = own;
      source.loop = looping;
      if (looping) source.start(0, offset - start);
      else source.start(0, offset - start);
    } else {
      source.buffer = buffer;
      source.loop = looping;
      source.loopStart = start;
      source.loopEnd = end;
      if (looping) source.start(0, offset);
      else source.start(0, offset, Math.max(0.005, end - offset));
    }
    v.play = { ctx: actx, source, start, end, offset, at: actx.currentTime, index, loop: looping, fadeKey: JSON.stringify(f && hasFade(f) ? f : null) };
    node.dataset.playing = looping ? "loop" : "once";
    paintPlay();
    node.dataset.playRange = `${start},${end}`; // read by the end-to-end test
    source.onended = () => {
      if (v.play?.source === source) stopPlay();
    };
    cancelAnimationFrame(v.raf);
    const tick = () => {
      if (!v.play || v.play.source !== source) return;
      draw();
      v.raf = requestAnimationFrame(tick);
    };
    v.raf = requestAnimationFrame(tick);
  }

  /**
   * The section playing in loop follows its new size or fades — a divider dragged (live), a merge, a reset,
   * an undo: it starts over from where it was, with exactly the new start and end.
   */
  function followPlaying(sections) {
    const p = v.play;
    if (!p || !p.loop || p.index < 0) return; // the song or a selection plays as it is
    let best = null;
    let overlap = 0;
    for (const x of sections) {
      const o = Math.min(x.end, p.end) - Math.max(x.start, p.start);
      if (o > overlap) {
        best = x;
        overlap = o;
      }
    }
    if (!best) return stopPlay();
    const fadeKey = JSON.stringify(fadeOf(best) && hasFade(fadeOf(best)) ? fadeOf(best) : null);
    if (Math.abs(best.start - p.start) < 1e-6 && Math.abs(best.end - p.end) < 1e-6 && fadeKey === p.fadeKey) return;
    let at = playPosition();
    if (at < best.start || at >= best.end) at = best.start;
    stopPlay();
    playRange(best.index, best.start, best.end, at, best);
  }

  function paintPlay() {
    const playing = Boolean(v.play);
    playBtn.replaceChildren(icon(playing ? ICONS.pause : ICONS.play));
    const label = playing ? "Pausar (Espaço)" : v.paused ? "Continuar (Espaço)" : "Tocar (Espaço)";
    playBtn.title = label;
    playBtn.setAttribute("aria-label", label);
    playBtn.classList.toggle("is-playing", playing);
    node.dataset.paused = v.paused ? String(v.paused.at) : "";
  }

  /** The header button: pause keeps the place; play goes on from it, or plays the selection, or the whole song. */
  function playPause() {
    if (!v.analysis) return;
    if (v.play) {
      const { start, end, index } = v.play;
      v.paused = { start, end, index, section: v.sections[index], at: playPosition() };
      stopPlay();
      draw();
      return;
    }
    if (v.paused) {
      const q = v.paused;
      v.paused = null;
      if (!v.settings.slices) playFrom(q.at); // the slices hidden: on through the whole song
      else playRange(q.index, q.start, q.end, Math.min(q.at, q.end - 0.005), q.section);
      return;
    }
    const picked = v.settings.slices ? v.sections.filter((x) => v.selected.has(x.key)) : [];
    if (picked.length) playRange(-1, picked[0].start, picked[picked.length - 1].end);
    else playRange(-1, 0, v.analysis.duration);
  }

  playBtn.addEventListener("click", playPause);

  /** The whole song from `t` (Alt + click, or any click with the slices hidden); Loop goes round the song. */
  function playFrom(t) {
    const end = v.analysis.duration;
    v.paused = null;
    stopPlay();
    playRange(-1, 0, end, clamp(t, 0, end - 0.005));
  }

  function togglePlay(index) {
    const s = v.sections[index];
    const same = v.play && v.play.index === index;
    v.paused = null; // a click on a section starts over there
    stopPlay();
    if (!s || same) return;
    playRange(index, s.start, s.end);
  }

  loopInput.addEventListener("change", () => {
    v.settings.loop = loopInput.checked;
    saveSettings();
    if (!v.play) return;
    // what is playing switches mode where it is: on → keeps going round, off → ends at the section's end
    const { index, start, end } = v.play;
    const at = playPosition();
    stopPlay();
    playRange(index, start, end, Math.min(at, end - 0.005));
  });

  slicesInput.addEventListener("change", () => {
    v.settings.slices = slicesInput.checked; // not remembered: every song opens with them shown
    paintControls();
    if (!v.analysis) return;
    if (!v.settings.slices) {
      hideTools();
      mergeBtn.hidden = true;
      v.hover = { section: -1, divider: -1 };
      // a section playing (or paused) carries on through the rest of the song, from where it is
      const whole = (p) => p.start <= 0 && p.end >= v.analysis.duration;
      if (v.play && !whole(v.play)) playFrom(playPosition());
      else if (v.paused && !whole(v.paused)) v.paused = { start: 0, end: v.analysis.duration, index: -1, section: undefined, at: v.paused.at };
    }
    draw();
    refreshHover();
  });

  // ---- Exporting -------------------------------------------------------------------

  /**
   * The format to save in: the one remembered in Cachalot's settings, else asked in a small popup next to the
   * button ("Lembrar escolha" stores it there). Resolves to { format, remember } or null when dismissed.
   */
  async function chooseFormat(button) {
    const anchor = button.getBoundingClientRect();
    hideTools();
    mergeBtn.hidden = true;
    const res = await message("transient", { op: "format", body: {} });
    if (!v.alive) return null;
    if (res?.ok && EXPORT_FORMATS.includes(res.format)) return { format: res.format, remember: false };
    return askFormat(anchor);
  }

  function askFormat(anchor) {
    closePicker();
    return new Promise((resolve) => {
      const box = el("div", "tr-format");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-label", "Formato do arquivo");
      const options = el("div", "tr-format-options");
      const remember = el("input");
      remember.type = "checkbox";
      const rememberLabel = el("label", "tr-format-remember");
      rememberLabel.title = "Não perguntar de novo (dá para mudar ou voltar a perguntar nas configurações do Cachalot)";
      rememberLabel.append(remember, el("span", "", "Lembrar escolha"));
      const buttons = EXPORT_FORMATS.map((f) => {
        const b = el("button", "tr-format-btn", f.toUpperCase());
        b.type = "button";
        b.dataset.format = f;
        b.title = FORMAT_HINTS[f];
        b.addEventListener("click", () => done({ format: f, remember: remember.checked }));
        options.append(b);
        return b;
      });
      box.append(el("div", "tr-format-title", "Salvar como"), options, rememberLabel);

      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done(null);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const i = buttons.indexOf(document.activeElement);
          if (i < 0) return;
          e.preventDefault();
          buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length].focus();
        }
      };
      const onDown = (e) => {
        if (!box.contains(e.target)) done(null);
      };
      function done(choice) {
        if (v.picker?.node !== box) return;
        v.picker = null;
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("pointerdown", onDown, true);
        box.remove();
        if (choice) v.lastFormat = choice.format;
        resolve(choice);
      }
      v.picker = { node: box, done };
      node.append(box);
      // under the button, right-aligned with it, kept inside the card
      const host = node.getBoundingClientRect();
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      let left = anchor.right - host.left - w;
      left = clamp(left, 0, Math.max(0, host.width - w));
      let top = anchor.bottom - host.top + 6;
      if (top + h > host.height && anchor.top - host.top - h - 6 >= 0) top = anchor.top - host.top - h - 6;
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      document.addEventListener("keydown", onKey, true);
      // the click that opened it is over; the next one outside closes it
      setTimeout(() => v.picker?.node === box && document.addEventListener("pointerdown", onDown, true), 0);
      (buttons.find((b) => b.dataset.format === v.lastFormat) || buttons[0]).focus();
    });
  }

  function closePicker() {
    v.picker?.done(null);
  }

  async function exportSections(segments, folder, button) {
    if (v.busy || v.picker) return;
    v.busy = true; // nothing else exports while the format is being picked
    const choice = await chooseFormat(button);
    if (!v.alive) return;
    if (!choice) {
      v.busy = false;
      return;
    }
    hideTools();
    updateInfo();
    button.classList.add("is-busy");
    footFolder.hidden = true;
    footText.className = "tr-foot-text";
    footText.textContent = segments.length === 1 ? "Cortando a seção…" : `Cortando ${segments.length} seções…`;
    const res = await message("transient", {
      op: "export",
      body: { id: v.jobId, title: v.title, folder, segments, format: choice.format, remember: choice.remember },
    });
    if (!v.alive) return;
    v.busy = false;
    button.classList.remove("is-busy");
    updateInfo();
    if (res.ok) {
      footText.className = "tr-foot-text is-ok";
      const n = Number(res.files) || segments.length;
      if (folder) footText.textContent = `✓ ${n} ${n === 1 ? "arquivo" : "arquivos"} em “${res.saved || "seções"}”`;
      else footText.textContent = n > 1 ? `✓ ${n} arquivos salvos na pasta de downloads` : `✓ Salvo: ${res.saved || "seção"}`;
      footText.title = footText.textContent;
      footFolder.hidden = false;
    } else {
      footText.className = "tr-foot-text is-error";
      footText.textContent = errorText(res);
      footText.title = footText.textContent;
    }
  }

  footFolder.addEventListener("click", async () => {
    const res = await message("transient", { op: "open", body: { id: v.jobId } });
    if (!res.ok) {
      footText.className = "tr-foot-text is-error";
      footText.textContent = "A pasta não está mais lá";
    }
  });

  retryBtn.addEventListener("click", () => {
    retryBtn.hidden = true;
    start();
  });

  closeBtn.addEventListener("click", () => {
    destroy();
    onClose?.();
  });

  const observer = new ResizeObserver(() => {
    resize();
    refreshHover();
  });
  observer.observe(wave);
  const overviewObserver = new ResizeObserver(() => resizeOverview());
  overviewObserver.observe(overview);

  function destroy() {
    if (!v.alive) return;
    closePicker();
    v.alive = false;
    clearTimeout(v.pollTimer);
    clearTimeout(v.clickTimer);
    stopPlay();
    observer.disconnect();
    overviewObserver.disconnect();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keydown", onModifier);
    document.removeEventListener("keyup", onModifier);
    window.removeEventListener("blur", onBlurWindow);
    v.audio?.ctx.close().catch(() => {});
    if (v.saveTimer) {
      clearTimeout(v.saveTimer);
      if (v.jobId && v.analysis) {
        chrome.storage.session
          .set({ [EDITS_PREFIX + v.jobId]: { edits: v.edits, disabled: [...v.disabled], fades: v.fades } })
          .catch(() => {});
      }
    }
  }

  paintControls();
  start();
  return { node, destroy };
}
