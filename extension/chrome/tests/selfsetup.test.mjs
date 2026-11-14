import test from "node:test";
import assert from "node:assert/strict";
import {
  LAST_RELOAD_KEY,
  LOADED_BUILD_KEY,
  RELOAD_COOLDOWN_MS,
  adoptPackagedPairing,
  readPackagedJson,
  recordLoadedBuild,
  shouldReloadForNewBuild,
} from "../src/lib/selfsetup.js";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
  };
}

function packagedFiles(files) {
  return async (url) => {
    const name = url.replace("chrome-extension://id/", "");
    if (!(name in files)) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => JSON.parse(files[name]) };
  };
}

const getURL = (path) => `chrome-extension://id/${path}`;

test("readPackagedJson: missing, broken and valid files", async () => {
  const fetchFn = packagedFiles({ "a.json": '{"x":1}', "b.json": "not json" });
  assert.deepEqual(await readPackagedJson(fetchFn, getURL("a.json")), { x: 1 });
  assert.equal(await readPackagedJson(fetchFn, getURL("b.json")), null);
  assert.equal(await readPackagedJson(fetchFn, getURL("c.json")), null);
  assert.equal(await readPackagedJson(async () => { throw new Error("offline"); }, getURL("a.json")), null);
});

test("adoptPackagedPairing stores a new valid code once", async () => {
  const storage = memoryStorage();
  const env = { fetchFn: packagedFiles({ "pairing.json": '{"code":"abcd 2345"}' }), storage, getURL, codeKey: "pairingCode" };
  assert.equal(await adoptPackagedPairing(env), "ABCD2345");
  assert.equal(storage.data.pairingCode, "ABCD2345");
  assert.equal(await adoptPackagedPairing(env), null, "same code: nothing to do");
});

test("adoptPackagedPairing ignores a missing or invalid file", async () => {
  const storage = memoryStorage({ pairingCode: "ZZZZ9999" });
  assert.equal(await adoptPackagedPairing({ fetchFn: packagedFiles({}), storage, getURL, codeKey: "pairingCode" }), null);
  assert.equal(await adoptPackagedPairing({ fetchFn: packagedFiles({ "pairing.json": '{"code":"12"}' }), storage, getURL, codeKey: "pairingCode" }), null);
  assert.equal(storage.data.pairingCode, "ZZZZ9999");
});

test("shouldReloadForNewBuild: first run records, a new build reloads once", async () => {
  const files = { "build.json": '{"build":"one"}' };
  const storage = memoryStorage();
  const env = { fetchFn: packagedFiles(files), storage, getURL };
  assert.equal(await shouldReloadForNewBuild({ ...env, now: 1000 }), false, "first run");
  assert.equal(storage.data[LOADED_BUILD_KEY], "one");
  assert.equal(await shouldReloadForNewBuild({ ...env, now: 2000 }), false, "unchanged");

  files["build.json"] = '{"build":"two"}';
  const start = 10 * RELOAD_COOLDOWN_MS;
  assert.equal(await shouldReloadForNewBuild({ ...env, now: start }), true, "module copied a new version");
  assert.equal(storage.data[LOADED_BUILD_KEY], "two", "recorded before reloading: no loop");
  assert.equal(storage.data[LAST_RELOAD_KEY], start);
  assert.equal(await shouldReloadForNewBuild({ ...env, now: start + 10 }), false);

  files["build.json"] = '{"build":"three"}';
  assert.equal(await shouldReloadForNewBuild({ ...env, now: start + 1000 }), false, "cooldown");
  assert.equal(await shouldReloadForNewBuild({ ...env, now: start + RELOAD_COOLDOWN_MS + 1 }), true);
});

test("shouldReloadForNewBuild: no build file (loaded from the repository) never reloads", async () => {
  const storage = memoryStorage({ [LOADED_BUILD_KEY]: "old" });
  assert.equal(await shouldReloadForNewBuild({ fetchFn: packagedFiles({}), storage, getURL, now: 1e12 }), false);
});

test("recordLoadedBuild keeps what is on disk", async () => {
  const storage = memoryStorage({ [LOADED_BUILD_KEY]: "old" });
  await recordLoadedBuild({ fetchFn: packagedFiles({ "build.json": '{"build":"new"}' }), storage, getURL });
  assert.equal(storage.data[LOADED_BUILD_KEY], "new");
});
