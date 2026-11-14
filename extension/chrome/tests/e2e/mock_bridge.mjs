// Mock of Cachalot's local bridge for the end-to-end test.
//   node mock_bridge.mjs --port 47821 --code ABCD2345 [--version 9.9.9]
// Implements GET /ping, GET /downloads, POST /download, POST /cookies, POST /open-folder, POST /show, POST /cancel,
// POST /transient/{prepare,status,pcm,export,open,format}, plus test controls:
//   GET /__log (received requests), POST /__reset, POST /__mode {"revoked":bool, "transientFormat":""|"mp3"|...}

import http from "node:http";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "47821"));
const CODE = arg("code", "ABCD2345");
const VERSION = arg("version", "9.9.9");

let revoked = false;
let transientFormat = ""; // the module's remembered section format ("" = ask)

// Transient mode: one job per URL; "downloads" for ~1.2 s, then serves a drum loop
// (120 BPM, 8 bars after 0.37 s of quiet) as mono PCM s16le at 22 050 Hz.
const RATE = 22050;
const jobs = new Map(); // id -> { url, at, title }
function drumLoop() {
  const bpm = 120;
  const beat = 60 / bpm;
  const lead = 0.37;
  const length = Math.ceil((lead + 32 * beat + 1) * RATE);
  const out = new Float32Array(length);
  let seed = 7;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5);
  for (let i = 0; i < length; i++) out[i] = 0.02 * Math.sin((2 * Math.PI * 220 * i) / RATE) + 0.002 * noise();
  const add = (t, dur, fn) => {
    const a = Math.round(t * RATE);
    for (let i = 0; i < dur * RATE && a + i < length; i++) out[a + i] += fn(i / RATE);
  };
  for (let b = 0; b < 32; b++) {
    const t = lead + b * beat;
    add(t, 0.25, (x) => 0.8 * Math.exp(-x * 18) * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-x * 40)) * x));
    if (b % 4 === 1 || b % 4 === 3) add(t, 0.18, (x) => 0.45 * Math.exp(-x * 25) * noise());
    for (const h of [0, 0.5]) {
      let prev = 0;
      add(t + h * beat, 0.05, (x) => {
        const n = noise();
        const hp = n - prev;
        prev = n;
        return 0.18 * Math.exp(-x * 90) * hp;
      });
    }
  }
  const pcm = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767))), i * 2);
  return pcm;
}
const LOOP = drumLoop();
function jobState(id) {
  const job = jobs.get(id);
  const t = (Date.now() - job.at) / 1000;
  if (t < 1.2) return { ok: true, id, state: "baixando", progress: Math.round((t / 1.2) * 100), phase: "", title: job.title };
  return { ok: true, id, state: "pronto", progress: 100, title: "Loop de teste", duration: LOOP.length / 2 / RATE, rate: RATE, bytes: LOOP.length };
}
const log = [];
const queue = new Map(); // url -> when it was sent

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const raw = await readBody(req);
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  const auth = req.headers.authorization || "";
  const authorized = !revoked && auth === `Bearer ${CODE}`;

  if (url.pathname === "/__log") return send(res, 200, log);
  if (url.pathname === "/__reset") {
    log.length = 0;
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/__mode") {
    revoked = Boolean(body?.revoked);
    if (typeof body?.transientFormat === "string") transientFormat = body.transientFormat;
    return send(res, 200, { ok: true, revoked });
  }
  // The queue (not logged: the popup polls it). Each sent URL waits 1 s, downloads for 3 s, then is done.
  if (url.pathname === "/downloads" && req.method === "GET") {
    if (/^https?:/i.test(req.headers.origin || "")) return send(res, 403, { error: "forbidden" });
    if (!authorized) return send(res, 401, { error: "unauthorized" });
    const now = Date.now();
    const items = [...queue.entries()].map(([u, at], index) => {
      const t = (now - at) / 1000;
      const status = t < 1 ? "pendente" : t < 4 ? "baixando" : "concluido";
      return { id: `dl-${index + 1}`, url: u, status, progress: status === "baixando" ? Math.round(((t - 1) / 3) * 1000) / 10 : status === "concluido" ? 100 : 0, title: "", speed: "1,2MiB/s", eta: "00:02", phase: "", error: "", created: at / 1000 };
    });
    return send(res, 200, { items: items.reverse() });
  }

  const entry = {
    method: req.method,
    path: url.pathname,
    authorization: auth,
    contentType: req.headers["content-type"] || "",
    origin: req.headers.origin || "",
    body,
  };
  log.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);

  // Like the real bridge: web pages (http/https origins) are never served.
  if (/^https?:/i.test(entry.origin)) return send(res, 403, { error: "forbidden" });

  if (url.pathname === "/ping" && req.method === "GET") {
    return send(res, 200, { app: "cachalot", version: VERSION, paired: authorized });
  }
  if (url.pathname === "/download" && req.method === "POST") {
    if (!authorized) return send(res, 401, { error: "unauthorized" });
    if (!body || !Array.isArray(body.urls) || body.urls.length === 0) return send(res, 400, { error: "urls is required" });
    for (const u of body.urls) queue.set(u, Date.now());
    return send(res, 202, { ok: true, queued: body.urls.length });
  }
  if (url.pathname === "/cancel" && req.method === "POST") {
    if (!authorized) return send(res, 401, { error: "unauthorized" });
    const entry = [...queue.keys()][Number(String(body?.id || "").slice(3)) - 1];
    if (!entry) return send(res, 404, { error: "not found" });
    queue.delete(entry);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/show" && req.method === "POST") {
    if (!authorized) return send(res, 401, { error: "unauthorized" });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/open-folder" && req.method === "POST") {
    if (!authorized) return send(res, 401, { error: "unauthorized" });
    const known = typeof body?.id === "string" && /^dl-\d+$/.test(body.id) && Number(body.id.slice(3)) <= queue.size;
    return known ? send(res, 200, { ok: true }) : send(res, 404, { error: "not found" });
  }
  if (url.pathname.startsWith("/transient/") && req.method === "POST") {
    if (!authorized) return send(res, 401, { error: "unauthorized" });
    const op = url.pathname.slice("/transient/".length);
    if (op === "format") return send(res, 200, { ok: true, format: transientFormat });
    if (op === "prepare") {
      if (!/^https?:/.test(body?.url || "")) return send(res, 400, { error: "url is required" });
      const id = `job-${Buffer.from(body.url).toString("hex").slice(-10)}`;
      if (!jobs.has(id)) jobs.set(id, { url: body.url, at: Date.now(), title: body.title || "" });
      return send(res, 200, jobState(id));
    }
    if (!jobs.has(body?.id)) return send(res, 404, { error: "not found" });
    if (op === "status") return send(res, 200, jobState(body.id));
    if (op === "pcm") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": LOOP.length });
      return res.end(LOOP);
    }
    if (op === "export") {
      const segments = Array.isArray(body.segments) ? body.segments : [];
      if (!segments.length) return send(res, 400, { error: "no sections" });
      const format = ["mp3", "wav", "flac"].includes(body.format) ? body.format : "wav";
      if (body.remember) transientFormat = format;
      const saved = body.folder ? `${body.title} - seções` : `${body.title} - ${String(segments[0].number).padStart(2, "0")}.${format}`;
      return send(res, 200, { ok: true, files: segments.length, saved });
    }
    if (op === "open") return send(res, 200, { ok: true });
    return send(res, 404, { error: "not found" });
  }
  if (url.pathname === "/cookies" && req.method === "POST") {
    if (!authorized) return send(res, 401, { error: "unauthorized" });
    if (!body || typeof body.domain !== "string" || !Array.isArray(body.cookies)) return send(res, 400, { error: "bad body" });
    return send(res, 200, { ok: true, count: body.cookies.length });
  }
  return send(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`mock bridge listening on 127.0.0.1:${PORT} (code ${CODE})\n`);
});
