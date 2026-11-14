// Registrable-domain helpers (a tiny, dependency-free stand-in for the Public
// Suffix List). Only multi-label public suffixes that are common for the
// platforms Cachalot targets are listed; everything else falls back to the
// last two labels, which is right for the vast majority of hosts.

const MULTI_LABEL_SUFFIXES = new Set([
  // United Kingdom
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk", "ltd.uk", "plc.uk",
  // Brazil
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br", "blog.br", "tv.br", "eco.br", "app.br",
  // Portugal, Spain, Latin America
  "com.pt", "org.pt", "com.es", "org.es", "com.mx", "org.mx", "gob.mx", "com.ar", "org.ar", "gob.ar",
  "com.co", "com.pe", "com.ve", "com.uy", "com.py", "com.bo", "com.ec", "cl.cl",
  // Asia / Pacific
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "ne.kr",
  "com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "org.hk", "com.tw", "org.tw",
  "com.sg", "com.my", "com.ph", "co.id", "co.in", "net.in", "org.in", "co.th", "com.vn",
  // Others
  "co.za", "org.za", "com.tr", "org.tr", "com.ua", "com.ru", "com.pl", "co.il", "org.il",
  "com.eg", "com.sa", "com.ng", "co.ke",
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Lower-cases a hostname and strips a trailing dot and IPv6 brackets. */
export function normalizeHost(hostname) {
  if (typeof hostname !== "string") return "";
  let host = hostname.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

export function isIpAddress(host) {
  const h = normalizeHost(host);
  return IPV4.test(h) || h.includes(":");
}

/**
 * Returns the registrable domain ("eTLD+1") of a hostname:
 * www.youtube.com -> youtube.com, m.facebook.co.uk -> facebook.co.uk.
 * IP addresses and single-label hosts (localhost) are returned unchanged.
 */
export function registrableDomain(hostname) {
  const host = normalizeHost(hostname);
  if (!host || isIpAddress(host) || !host.includes(".")) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/** Registrable domain of a URL string, or "" when the URL is not http(s). */
export function registrableDomainOfUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return registrableDomain(u.hostname);
  } catch {
    return "";
  }
}

/** True when `host` equals `domain` or is one of its subdomains. */
export function hostMatchesDomain(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/**
 * True when a cookie (chrome.cookies.Cookie) belongs to `domain` or one of its
 * subdomains. Cookie domains may carry a leading dot.
 */
export function cookieBelongsTo(cookie, domain) {
  if (!cookie || typeof cookie.domain !== "string") return false;
  const cookieHost = cookie.domain.replace(/^\./, "");
  return hostMatchesDomain(cookieHost, domain);
}

/** Maps a chrome.cookies.Cookie to the shape the bridge expects. */
export function toBridgeCookie(cookie) {
  const out = {
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    hostOnly: Boolean(cookie.hostOnly),
    name: cookie.name,
    value: cookie.value,
  };
  if (typeof cookie.expirationDate === "number") out.expirationDate = cookie.expirationDate;
  return out;
}

/** Keeps only the cookies of `domain` (and subdomains) in bridge format. */
export function cookiesForDomain(cookies, domain) {
  if (!Array.isArray(cookies) || !domain) return [];
  return cookies.filter((c) => cookieBelongsTo(c, domain)).map(toBridgeCookie);
}
