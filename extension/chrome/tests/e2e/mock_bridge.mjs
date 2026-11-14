// Mock of Cachalot's local bridge for the end-to-end test.
//   node mock_bridge.mjs --port 47821 --code ABCD2345 [--version 9.9.9]
// Implements GET /ping, GET /downloads, POST /download, POST /cookies, POST /open-folder, POST /show, POST /cancel, plus test controls:
//   GET /__log (received requests), POST /__reset, POST /__mode {"revoked":bool}

import http from "node:http";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "47821"));
const CODE = arg("code", "ABCD2345");
const VERSION = arg("version", "9.9.9");

let revoked = false;
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
