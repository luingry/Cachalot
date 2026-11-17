// Client for Cachalot's local HTTP bridge (http://127.0.0.1:<port>).
// fetch and storage are injected so the logic runs (and is tested) in Node.

export const DEFAULT_PORT = 47821;
export const LAST_PORT = 47830;
export const PING_TIMEOUT_MS = 1500;
export const REQUEST_TIMEOUT_MS = 15000;
/** Transient mode: preparing may start the backend, exporting cuts every section with ffmpeg. */
export const TRANSIENT_TIMEOUTS_MS = Object.freeze({ prepare: 100000, status: 25000, pcm: 60000, export: 320000, open: 15000, format: 5000 });

export const STORAGE_KEYS = Object.freeze({
  code: "pairingCode",
  port: "bridgePort",
  portOverride: "portOverride",
});

export function bridgeUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

export function isValidPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Ports to try, in order of preference: the override alone when set;
 * otherwise the remembered port, then 47821..47830.
 */
export function candidatePorts({ override = null, remembered = null } = {}) {
  if (isValidPort(override)) return [Number(override)];
  const ports = [];
  if (isValidPort(remembered)) ports.push(Number(remembered));
  for (let p = DEFAULT_PORT; p <= LAST_PORT; p++) if (!ports.includes(p)) ports.push(p);
  return ports;
}

function authHeaders(code) {
  return code ? { Authorization: `Bearer ${code}` } : {};
}

async function fetchWithTimeout(fetchFn, url, init, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("timeout"));
      if (controller) controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchFn(url, { ...init, signal: controller?.signal }), timeout]);
  } catch (err) {
    // An aborted fetch rejects with AbortError; report it as the timeout it is.
    if (timedOut) throw new Error("timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Pings one port. Resolves to { ok: true, port, version, paired } when Cachalot
 * answers, { ok: false } on any other response, error or timeout.
 */
export async function pingPort(fetchFn, port, code, timeoutMs = PING_TIMEOUT_MS) {
  try {
    const res = await fetchWithTimeout(
      fetchFn,
      bridgeUrl(port, "/ping"),
      { method: "GET", headers: authHeaders(code), cache: "no-store" },
      timeoutMs,
    );
    if (!res || res.status !== 200) return { ok: false };
    const body = await readJson(res);
    if (!body || body.app !== "cachalot") return { ok: false };
    return { ok: true, port, version: String(body.version || ""), paired: body.paired === true };
  } catch {
    return { ok: false };
  }
}

/**
 * Pings every candidate port in parallel and resolves with the first one, in
 * preference order, that answers as Cachalot (so the wait is bounded by one
 * timeout, not one per port). Resolves to null when none answers.
 */
export async function probePorts(fetchFn, ports, code, timeoutMs = PING_TIMEOUT_MS) {
  const attempts = ports.map((p) => pingPort(fetchFn, p, code, timeoutMs));
  for (const attempt of attempts) {
    const result = await attempt;
    if (result.ok) return result;
  }
  return null;
}

/**
 * storage: { get(keys) -> Promise<object>, set(object) -> Promise } (the
 * chrome.storage.local shape).
 */
export function createBridgeClient({
  fetchFn = (...args) => fetch(...args),
  storage,
  pingTimeoutMs = PING_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!storage) throw new Error("storage is required");

  async function readConfig() {
    const data = (await storage.get([STORAGE_KEYS.code, STORAGE_KEYS.port, STORAGE_KEYS.portOverride])) || {};
    return {
      code: typeof data[STORAGE_KEYS.code] === "string" ? data[STORAGE_KEYS.code] : "",
      remembered: isValidPort(data[STORAGE_KEYS.port]) ? Number(data[STORAGE_KEYS.port]) : null,
      override: isValidPort(data[STORAGE_KEYS.portOverride]) ? Number(data[STORAGE_KEYS.portOverride]) : null,
    };
  }

  async function locate(code, cfg) {
    const found = await probePorts(fetchFn, candidatePorts(cfg), code, pingTimeoutMs);
    if (found && found.port !== cfg.remembered) {
      await storage.set({ [STORAGE_KEYS.port]: found.port });
    }
    return found;
  }

  /**
   * Current connection state:
   *   { state: "closed" }
   *   { state: "unpaired", port, version, hasCode }   (no code, or code rejected)
   *   { state: "paired", port, version }
   */
  async function status() {
    const cfg = await readConfig();
    const found = await locate(cfg.code, cfg);
    if (!found) return { state: "closed" };
    if (cfg.code && found.paired) return { state: "paired", port: found.port, version: found.version };
    return { state: "unpaired", port: found.port, version: found.version, hasCode: Boolean(cfg.code) };
  }

  /**
   * Checks a candidate code against the running app and stores it when valid.
   * Resolves to { ok: true, state: "paired", ... } or { ok: false, error }
   * with error "closed" | "rejected".
   */
  async function pair(code) {
    const cfg = await readConfig();
    const found = await locate(code, cfg);
    if (!found) return { ok: false, error: "closed" };
    if (!found.paired) return { ok: false, error: "rejected", port: found.port, version: found.version };
    await storage.set({ [STORAGE_KEYS.code]: code });
    return { ok: true, state: "paired", port: found.port, version: found.version };
  }

  async function call(method, path, body, { timeoutMs = requestTimeoutMs, binary = false } = {}) {
    const cfg = await readConfig();
    if (!cfg.code) return { ok: false, error: "unauthorized" };
    let port = cfg.override || cfg.remembered;
    // Attempt 0 uses the known port (probing only when none is known);
    // attempt 1 runs after a network failure: the app may have restarted on
    // another port, so probe again and retry once.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!port || attempt > 0) {
        const found = await locate(cfg.code, cfg);
        if (!found) return { ok: false, error: "closed" };
        port = found.port;
      }
      try {
        const res = await fetchWithTimeout(
          fetchFn,
          bridgeUrl(port, path),
          method === "GET"
            ? { method, headers: authHeaders(cfg.code), cache: "no-store" }
            : {
                method,
                headers: { ...authHeaders(cfg.code), "Content-Type": "application/json" },
                body: JSON.stringify(body),
                cache: "no-store",
              },
          timeoutMs,
        );
        if (binary && res.status === 200) return { ok: true, status: 200, data: await res.arrayBuffer() };
        const data = await readJson(res);
        if (res.status === 401) return { ok: false, error: "unauthorized" };
        if (res.status === 400) return { ok: false, error: "bad_request", message: data?.error || "" };
        if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, ...(data || {}) };
        return { ok: false, error: "http", status: res.status, message: data?.error || "" };
      } catch (err) {
        // A timeout may mean the request did reach the app: never resend it.
        if (err && err.message === "timeout") return { ok: false, error: "timeout" };
        // Connection error: fall through to the re-probe attempt.
      }
    }
    return { ok: false, error: "closed" };
  }

  /** POST /download. Resolves to { ok: true, queued } or { ok: false, error, message }. */
  async function download(payload) {
    const result = await call("POST", "/download", payload);
    if (result.ok) return { ok: true, queued: Number(result.queued) || 0 };
    return result;
  }

  /**
   * POST /audio-format: whether a download comes out as audio and the format remembered for its site.
   * Resolves to { ok: true, audio, format ("" = ask), site } or { ok: false, error } (an older Cachalot answers 404).
   */
  async function audioFormat({ url, pageUrl = "", mode = null }) {
    const result = await call("POST", "/audio-format", { url, pageUrl, mode: mode || "" });
    if (result.ok) return { ok: true, audio: result.audio === true, format: String(result.format || ""), site: String(result.site || "") };
    return result;
  }

  /** POST /cookies. Resolves to { ok: true, count } or { ok: false, error, message }. */
  async function sendCookies(domain, cookies) {
    const result = await call("POST", "/cookies", { domain, cookies });
    if (result.ok) return { ok: true, count: Number(result.count) || 0 };
    return result;
  }

  /**
   * GET /downloads: Cachalot's queue and recent history, to show the progress of
   * what the extension sent. Resolves to { ok: true, items } or { ok: false, error }.
   */
  async function downloads() {
    const result = await call("GET", "/downloads");
    if (result.ok) return { ok: true, items: Array.isArray(result.items) ? result.items : [] };
    return result;
  }

  /**
   * POST /open-folder: Cachalot shows a finished download (an id from GET /downloads)
   * selected in Explorer. Resolves to { ok: true } or { ok: false, error }
   * ("http" with status 404 when the item or its folder is gone).
   */
  async function openFolder(id) {
    const result = await call("POST", "/open-folder", { id: String(id || "") });
    if (result.ok) return { ok: true };
    return result;
  }

  /** POST /show: Cachalot brings the SwissTechKnife window forward on its page. */
  async function show() {
    const result = await call("POST", "/show", {});
    if (result.ok) return { ok: true };
    return result;
  }

  /** POST /cancel: cancels a queued or running download (an id from GET /downloads). */
  async function cancel(id) {
    const result = await call("POST", "/cancel", { id: String(id || "") });
    if (result.ok) return { ok: true };
    return result;
  }

  /**
   * POST /transient/<op> (prepare, status, export, open, format): transient mode. Resolves to { ok: true, ...answer } or
   * { ok: false, error, message } — "http" 422 carries the backend's own message (pt-BR) in message.
   */
  async function transient(op, body = {}) {
    return call("POST", `/transient/${op}`, body, { timeoutMs: TRANSIENT_TIMEOUTS_MS[op] || requestTimeoutMs });
  }

  /** POST /transient/pcm: the analysis audio (mono PCM s16le) as { ok: true, data: ArrayBuffer }. */
  async function transientPcm(id) {
    return call("POST", "/transient/pcm", { id: String(id || "") }, { timeoutMs: TRANSIENT_TIMEOUTS_MS.pcm, binary: true });
  }

  return { readConfig, status, pair, download, audioFormat, sendCookies, downloads, openFolder, show, cancel, transient, transientPcm };
}

/** pt-BR message for a failed bridge call. */
export function describeBridgeError(result) {
  switch (result?.error) {
    case "closed":
      return "Cachalot fechado — abra o SwissTechKnife";
    case "unauthorized":
      return "Código de pareamento inválido — pareie novamente";
    case "rejected":
      return "Código não reconhecido pelo Cachalot";
    case "invalid_code":
      return "O código tem 8 caracteres (letras e números 2–9)";
    case "bad_request":
      return result.message ? `Cachalot recusou: ${result.message}` : "Cachalot recusou o pedido";
    case "unsupported_page":
      return "Esta página não pode ser enviada";
    case "not_found":
      return "Mídia não encontrada — recarregue a página";
    case "http":
      if (result.status === 404) return "Atualize o módulo Cachalot no SwissTechKnife";
      if (result.status === 503) return "O Cachalot ainda está iniciando — tente de novo em instantes";
      return result.message ? `Erro do Cachalot: ${result.message}` : `Erro do Cachalot (HTTP ${result.status})`;
    case "timeout":
      return "O Cachalot não respondeu a tempo";
    default:
      return "Não foi possível enviar ao Cachalot";
  }
}
