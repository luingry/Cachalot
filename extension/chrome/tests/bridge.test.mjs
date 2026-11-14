import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PORT,
  STORAGE_KEYS,
  candidatePorts,
  createBridgeClient,
  describeBridgeError,
  pingPort,
  probePorts,
} from "../src/lib/bridge.js";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(obj) {
      Object.assign(data, obj);
    },
  };
}

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

/**
 * Fake fetch: `ports` maps a port to a handler(path, init) returning a
 * response, "hang" (never resolves until aborted) or undefined (refused).
 */
function fakeFetch(ports) {
  const calls = [];
  const fn = (url, init = {}) => {
    const u = new URL(url);
    calls.push({ port: Number(u.port), path: u.pathname, init });
    const handler = ports[Number(u.port)];
    if (!handler) return Promise.reject(new TypeError("Failed to fetch"));
    const res = handler(u.pathname, init);
    if (res === "hang") {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return Promise.resolve(res);
  };
  fn.calls = calls;
  return fn;
}

const cachalot = (code, extra = {}) => (path, init) => {
  const auth = init.headers?.Authorization;
  const paired = auth === `Bearer ${code}`;
  if (path === "/ping") return jsonResponse(200, { app: "cachalot", version: "1.2.3", paired });
  if (!paired) return jsonResponse(401, { error: "unauthorized" });
  if (extra[path]) return extra[path](init);
  return jsonResponse(404, { error: "nope" });
};

test("candidatePorts: override alone, else remembered then 47821..47830", () => {
  assert.deepEqual(candidatePorts({ override: 5000 }), [5000]);
  const auto = candidatePorts({});
  assert.equal(auto.length, 10);
  assert.equal(auto[0], DEFAULT_PORT);
  assert.equal(auto[9], 47830);
  const remembered = candidatePorts({ remembered: 47825 });
  assert.equal(remembered[0], 47825);
  assert.equal(remembered.length, 10, "no duplicate entry");
  assert.equal(candidatePorts({ remembered: 47900 })[0], 47900);
  assert.equal(candidatePorts({ override: "abc" })[0], DEFAULT_PORT);
});

test("pingPort sends the bearer code and validates the app id", async () => {
  const fetchFn = fakeFetch({ 47821: cachalot("ABCD2345"), 47822: () => jsonResponse(200, { app: "other" }), 47823: () => jsonResponse(500, {}) });
  assert.deepEqual(await pingPort(fetchFn, 47821, "ABCD2345"), { ok: true, port: 47821, version: "1.2.3", paired: true });
  assert.equal(fetchFn.calls[0].init.headers.Authorization, "Bearer ABCD2345");
  assert.deepEqual(await pingPort(fetchFn, 47821, ""), { ok: true, port: 47821, version: "1.2.3", paired: false });
  assert.equal(fetchFn.calls[1].init.headers.Authorization, undefined, "no header without a code");
  assert.deepEqual(await pingPort(fetchFn, 47822, ""), { ok: false });
  assert.deepEqual(await pingPort(fetchFn, 47823, ""), { ok: false });
  assert.deepEqual(await pingPort(fetchFn, 47829, ""), { ok: false });
});

test("pingPort times out", async () => {
  const fetchFn = fakeFetch({ 47821: () => "hang" });
  const started = Date.now();
  assert.deepEqual(await pingPort(fetchFn, 47821, "", 50), { ok: false });
  assert.ok(Date.now() - started < 1000);
});

test("probePorts returns the first port in preference order, in parallel", async () => {
  const fetchFn = fakeFetch({ 47821: () => "hang", 47824: cachalot("X"), 47826: cachalot("X") });
  const started = Date.now();
  const found = await probePorts(fetchFn, candidatePorts({}), "", 100);
  assert.equal(found.port, 47824);
  assert.ok(Date.now() - started < 1000, "bounded by a single timeout");
  assert.equal(await probePorts(fakeFetch({}), candidatePorts({}), "", 50), null);
});

test("status: closed / unpaired / paired, remembering the working port", async () => {
  const storage = memoryStorage();
  let client = createBridgeClient({ fetchFn: fakeFetch({}), storage, pingTimeoutMs: 50 });
  assert.deepEqual(await client.status(), { state: "closed" });

  client = createBridgeClient({ fetchFn: fakeFetch({ 47823: cachalot("ABCD2345") }), storage, pingTimeoutMs: 50 });
  assert.deepEqual(await client.status(), { state: "unpaired", port: 47823, version: "1.2.3", hasCode: false });
  assert.equal(storage.data[STORAGE_KEYS.port], 47823);

  storage.data[STORAGE_KEYS.code] = "WRONG234";
  assert.equal((await client.status()).hasCode, true);

  storage.data[STORAGE_KEYS.code] = "ABCD2345";
  assert.deepEqual(await client.status(), { state: "paired", port: 47823, version: "1.2.3" });
});

test("status honours the port override", async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.portOverride]: 5555, [STORAGE_KEYS.code]: "ABCD2345" });
  const fetchFn = fakeFetch({ 47821: cachalot("ABCD2345"), 5555: cachalot("ABCD2345") });
  const client = createBridgeClient({ fetchFn, storage, pingTimeoutMs: 50 });
  assert.equal((await client.status()).port, 5555);
  assert.ok(fetchFn.calls.every((c) => c.port === 5555));
});

test("pair stores the code only when Cachalot accepts it", async () => {
  const storage = memoryStorage();
  const client = createBridgeClient({ fetchFn: fakeFetch({ 47821: cachalot("ABCD2345") }), storage, pingTimeoutMs: 50 });
  const bad = await client.pair("ZZZZ9999");
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "rejected");
  assert.equal(storage.data[STORAGE_KEYS.code], undefined);
  const good = await client.pair("ABCD2345");
  assert.equal(good.ok, true);
  assert.equal(storage.data[STORAGE_KEYS.code], "ABCD2345");

  const closed = createBridgeClient({ fetchFn: fakeFetch({}), storage: memoryStorage(), pingTimeoutMs: 50 });
  assert.deepEqual(await closed.pair("ABCD2345"), { ok: false, error: "closed" });
});

test("download posts JSON with the bearer code and maps responses", async () => {
  const received = [];
  const fetchFn = fakeFetch({
    47821: cachalot("ABCD2345", {
      "/download": (init) => {
        const body = JSON.parse(init.body);
        received.push({ body, init });
        if (body.urls[0] === "bad") return jsonResponse(400, { error: "no urls" });
        return jsonResponse(202, { ok: true, queued: body.urls.length });
      },
      "/cookies": (init) => jsonResponse(200, { ok: true, count: JSON.parse(init.body).cookies.length }),
    }),
  });
  const storage = memoryStorage({ [STORAGE_KEYS.code]: "ABCD2345", [STORAGE_KEYS.port]: 47821 });
  const client = createBridgeClient({ fetchFn, storage, pingTimeoutMs: 50 });

  const ok = await client.download({ urls: ["https://a/1", "https://a/2"], mode: null });
  assert.deepEqual(ok, { ok: true, queued: 2 });
  assert.equal(received[0].init.method, "POST");
  assert.equal(received[0].init.headers["Content-Type"], "application/json");
  assert.equal(received[0].init.headers.Authorization, "Bearer ABCD2345");

  const bad = await client.download({ urls: ["bad"] });
  assert.deepEqual(bad, { ok: false, error: "bad_request", message: "no urls" });

  const notReady = createBridgeClient({
    fetchFn: fakeFetch({ 47821: cachalot("ABCD2345", { "/download": () => jsonResponse(503, { error: "not ready" }) }) }),
    storage,
    pingTimeoutMs: 50,
  });
  assert.deepEqual(await notReady.download({ urls: ["https://a/1"] }), { ok: false, error: "http", status: 503, message: "not ready" });

  assert.deepEqual(await client.sendCookies("site.com", [{ name: "a" }, { name: "b" }]), { ok: true, count: 2 });

  storage.data[STORAGE_KEYS.code] = "WRONG234";
  assert.deepEqual(await client.download({ urls: ["https://a/1"] }), { ok: false, error: "unauthorized" });

  delete storage.data[STORAGE_KEYS.code];
  assert.deepEqual(await client.download({ urls: ["https://a/1"] }), { ok: false, error: "unauthorized" });
});

test("openFolder posts the download id and maps a missing item", async () => {
  const received = [];
  const fetchFn = fakeFetch({
    47821: cachalot("ABCD2345", {
      "/open-folder": (init) => {
        const body = JSON.parse(init.body);
        received.push(body);
        return body.id === "dl-1" ? jsonResponse(200, { ok: true }) : jsonResponse(404, { error: "not found" });
      },
    }),
  });
  const storage = memoryStorage({ [STORAGE_KEYS.code]: "ABCD2345", [STORAGE_KEYS.port]: 47821 });
  const client = createBridgeClient({ fetchFn, storage, pingTimeoutMs: 50 });

  assert.deepEqual(await client.openFolder("dl-1"), { ok: true });
  assert.deepEqual(received, [{ id: "dl-1" }]);
  assert.deepEqual(await client.openFolder("gone"), { ok: false, error: "http", status: 404, message: "not found" });
});

test("download re-probes once when the remembered port stopped answering", async () => {
  const fetchFn = fakeFetch({
    47827: cachalot("ABCD2345", { "/download": () => jsonResponse(202, { ok: true, queued: 1 }) }),
  });
  const storage = memoryStorage({ [STORAGE_KEYS.code]: "ABCD2345", [STORAGE_KEYS.port]: 47821 });
  const client = createBridgeClient({ fetchFn, storage, pingTimeoutMs: 50 });
  assert.deepEqual(await client.download({ urls: ["https://a/1"] }), { ok: true, queued: 1 });
  assert.equal(storage.data[STORAGE_KEYS.port], 47827);

  const down = createBridgeClient({ fetchFn: fakeFetch({}), storage: memoryStorage({ [STORAGE_KEYS.code]: "ABCD2345" }), pingTimeoutMs: 50 });
  assert.deepEqual(await down.download({ urls: ["https://a/1"] }), { ok: false, error: "closed" });
});

test("download never resends after a timeout", async () => {
  let posts = 0;
  const fetchFn = fakeFetch({
    47821: cachalot("ABCD2345", {
      "/download": () => {
        posts++;
        return "hang";
      },
    }),
  });
  const storage = memoryStorage({ [STORAGE_KEYS.code]: "ABCD2345", [STORAGE_KEYS.port]: 47821 });
  const client = createBridgeClient({ fetchFn, storage, pingTimeoutMs: 50, requestTimeoutMs: 60 });
  assert.deepEqual(await client.download({ urls: ["https://a/1"] }), { ok: false, error: "timeout" });
  assert.equal(posts, 1);
});

test("describeBridgeError gives pt-BR messages", () => {
  assert.match(describeBridgeError({ error: "closed" }), /Cachalot fechado/);
  assert.match(describeBridgeError({ error: "unauthorized" }), /pareamento/);
  assert.match(describeBridgeError({ error: "bad_request", message: "x" }), /recusou: x/);
  assert.match(describeBridgeError({ error: "http", status: 500 }), /HTTP 500/);
  assert.match(describeBridgeError({ error: "http", status: 500, message: "boom" }), /Erro do Cachalot: boom/);
  assert.match(describeBridgeError({ error: "http", status: 503 }), /iniciando/);
  assert.match(describeBridgeError({ error: "http", status: 404 }), /Atualize o módulo/);
  assert.match(describeBridgeError({ error: "timeout" }), /não respondeu/);
  assert.ok(describeBridgeError({}).length > 0);
});
