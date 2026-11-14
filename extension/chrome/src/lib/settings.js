// User preferences kept in chrome.storage.local (storage is injected).

export const SETTINGS_KEYS = Object.freeze({
  cookiesDefault: "sendCookiesDefault",
  cookieOverrides: "cookieSiteOverrides",
});

/** Default for "Enviar cookies deste site" on sites without a choice. */
export async function getCookiesDefault(storage) {
  const data = (await storage.get(SETTINGS_KEYS.cookiesDefault)) || {};
  return data[SETTINGS_KEYS.cookiesDefault] !== false;
}

export async function setCookiesDefault(storage, enabled) {
  await storage.set({ [SETTINGS_KEYS.cookiesDefault]: Boolean(enabled) });
}

export async function getCookieOverrides(storage) {
  const data = (await storage.get(SETTINGS_KEYS.cookieOverrides)) || {};
  const value = data[SETTINGS_KEYS.cookieOverrides];
  return value && typeof value === "object" ? value : {};
}

/** Whether cookies are attached for a registrable domain (site choice, else default). */
export async function cookiesEnabledFor(storage, domain) {
  const [def, overrides] = await Promise.all([getCookiesDefault(storage), getCookieOverrides(storage)]);
  if (domain && typeof overrides[domain] === "boolean") return overrides[domain];
  return def;
}

/** Remembers the popup switch for one site; a choice equal to the default is dropped. */
export async function setCookiesEnabledFor(storage, domain, enabled) {
  if (!domain) return;
  const [def, overrides] = await Promise.all([getCookiesDefault(storage), getCookieOverrides(storage)]);
  const next = { ...overrides };
  if (Boolean(enabled) === def) delete next[domain];
  else next[domain] = Boolean(enabled);
  await storage.set({ [SETTINGS_KEYS.cookieOverrides]: next });
}

export async function clearCookieOverrides(storage) {
  await storage.set({ [SETTINGS_KEYS.cookieOverrides]: {} });
}
