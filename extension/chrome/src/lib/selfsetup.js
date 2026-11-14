// Files the Cachalot module writes next to the extension when it copies it to the folder Chrome loads it from:
//   pairing.json  {"code": "ABCD1234"}  the bridge code, so a fresh install pairs itself;
//   build.json    {"build": "..."}      a stamp that changes with every new copy, so an already
//                                       loaded (unpacked) extension notices the update and reloads.
// Neither is web-accessible. Without them (extension loaded from the repository) nothing happens.
// fetch, storage and the clock are injected so this runs (and is tested) in Node.

import { parsePairingCode } from "./pairing.js";

export const PAIRING_FILE = "pairing.json";
export const BUILD_FILE = "build.json";
export const LOADED_BUILD_KEY = "loadedBuild";
export const LAST_RELOAD_KEY = "lastSelfReload";
/** Never reload twice within this window, whatever the files say (guards against a reload loop). */
export const RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

export async function readPackagedJson(fetchFn, url) {
  try {
    const res = await fetchFn(url, { cache: "no-store" });
    if (!res || !res.ok) return null;
    const body = await res.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/**
 * Stores the code from pairing.json when it is valid and differs from the stored one.
 * Resolves to the adopted code, or null when nothing changed.
 */
export async function adoptPackagedPairing({ fetchFn, storage, getURL, codeKey }) {
  const body = await readPackagedJson(fetchFn, getURL(PAIRING_FILE));
  const parsed = parsePairingCode(typeof body?.code === "string" ? body.code : "");
  if (!parsed.valid) return null;
  const stored = (await storage.get(codeKey))?.[codeKey];
  if (stored === parsed.code) return null;
  await storage.set({ [codeKey]: parsed.code });
  return parsed.code;
}

/** onInstalled (install, update, manual reload): the files on disk are the ones now running. */
export async function recordLoadedBuild({ fetchFn, storage, getURL }) {
  const body = await readPackagedJson(fetchFn, getURL(BUILD_FILE));
  if (typeof body?.build === "string") await storage.set({ [LOADED_BUILD_KEY]: body.build });
}

/**
 * Worker start: true when build.json changed since this copy was loaded and a reload is due. Records the new
 * build before answering, so the reloaded worker does not reload again.
 */
export async function shouldReloadForNewBuild({ fetchFn, storage, getURL, now = Date.now() }) {
  const body = await readPackagedJson(fetchFn, getURL(BUILD_FILE));
  const onDisk = typeof body?.build === "string" ? body.build : "";
  if (!onDisk) return false;
  const data = (await storage.get([LOADED_BUILD_KEY, LAST_RELOAD_KEY])) || {};
  const loaded = typeof data[LOADED_BUILD_KEY] === "string" ? data[LOADED_BUILD_KEY] : "";
  if (!loaded) {
    // First run with a build file: whatever is on disk is what is running.
    await storage.set({ [LOADED_BUILD_KEY]: onDisk });
    return false;
  }
  if (loaded === onDisk) return false;
  const last = Number(data[LAST_RELOAD_KEY]) || 0;
  if (now - last < RELOAD_COOLDOWN_MS) return false;
  await storage.set({ [LOADED_BUILD_KEY]: onDisk, [LAST_RELOAD_KEY]: now });
  return true;
}
