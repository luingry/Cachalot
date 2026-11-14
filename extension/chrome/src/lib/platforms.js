// Known platforms whose page URLs Cachalot can download directly. Detection is
// host based: any page on a listed host lights the toolbar icon.

import { hostMatchesDomain, normalizeHost, registrableDomain } from "./domain.js";

export const PLATFORMS = Object.freeze([
  { id: "youtube", name: "YouTube", hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"] },
  { id: "instagram", name: "Instagram", hosts: ["instagram.com"] },
  { id: "tiktok", name: "TikTok", hosts: ["tiktok.com"] },
  { id: "twitter", name: "X / Twitter", hosts: ["x.com", "twitter.com"] },
  { id: "reddit", name: "Reddit", hosts: ["reddit.com", "redd.it"] },
  { id: "twitch", name: "Twitch", hosts: ["twitch.tv"] },
  { id: "pinterest", name: "Pinterest", hosts: ["pin.it"], registrableLabel: "pinterest" },
  { id: "bluesky", name: "Bluesky", hosts: ["bsky.app"] },
  { id: "threads", name: "Threads", hosts: ["threads.net", "threads.com"] },
  { id: "vimeo", name: "Vimeo", hosts: ["vimeo.com"] },
  { id: "soundcloud", name: "SoundCloud", hosts: ["soundcloud.com"] },
  { id: "facebook", name: "Facebook", hosts: ["facebook.com", "fb.watch", "fb.com"] },
  { id: "bilibili", name: "Bilibili", hosts: ["bilibili.com", "bilibili.tv", "b23.tv"] },
  { id: "dailymotion", name: "Dailymotion", hosts: ["dailymotion.com", "dai.ly"] },
  { id: "kick", name: "Kick", hosts: ["kick.com"] },
  { id: "bandcamp", name: "Bandcamp", hosts: ["bandcamp.com"] },
  { id: "tumblr", name: "Tumblr", hosts: ["tumblr.com"] },
  { id: "douyin", name: "Douyin", hosts: ["douyin.com", "iesdouyin.com"] },
  { id: "mixcloud", name: "Mixcloud", hosts: ["mixcloud.com"] },
  { id: "audiomack", name: "Audiomack", hosts: ["audiomack.com"] },
]);

/** Platforms whose pages must only offer the page URL (no sniffed streams). */
const PAGE_ONLY_PLATFORMS = new Set(["youtube"]);

/** Music platforms: their streams are audio, even HLS/DASH ones. */
const MUSIC_PLATFORMS = new Set(["soundcloud", "bandcamp", "mixcloud", "audiomack"]);

export function isMusicPlatform(pageUrl) {
  const p = detectPlatform(pageUrl);
  return Boolean(p && MUSIC_PLATFORMS.has(p.id));
}

/** Hosts whose traffic is never offered as a sniffed media row. */
const IGNORED_MEDIA_HOSTS = ["googlevideo.com", "youtube.com", "ytimg.com"];

function parseHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

export function isHttpUrl(url) {
  return parseHttpUrl(url) !== null;
}

/** URLs Cachalot accepts in /download: http(s) and magnet links. */
export function isSendableUrl(url) {
  return isHttpUrl(url) || (typeof url === "string" && /^magnet:\?/i.test(url.trim()));
}

/** Returns { id, name } of the platform a host belongs to, or null. */
export function detectPlatformByHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return null;
  const regLabel = registrableDomain(host).split(".")[0];
  for (const p of PLATFORMS) {
    if (p.hosts.some((d) => hostMatchesDomain(host, d)) || (p.registrableLabel && p.registrableLabel === regLabel)) {
      return { id: p.id, name: p.name };
    }
  }
  return null;
}

/** Returns { id, name } of the platform a page URL belongs to, or null. */
export function detectPlatform(url) {
  const u = parseHttpUrl(url);
  return u ? detectPlatformByHost(u.hostname) : null;
}

/** True when sniffed media must not be offered for this page (YouTube). */
export function isPageOnlyPlatform(pageUrl) {
  const p = detectPlatform(pageUrl);
  return Boolean(p && PAGE_ONLY_PLATFORMS.has(p.id));
}

/** True when a media request URL belongs to a host we never list. */
export function isIgnoredMediaHost(mediaUrl) {
  const u = parseHttpUrl(mediaUrl);
  if (!u) return true;
  return IGNORED_MEDIA_HOSTS.some((d) => hostMatchesDomain(u.hostname, d));
}

/**
 * Toolbar icon state: "active" on known platforms or when media was sniffed in
 * the tab, "inactive" otherwise.
 */
export function iconStateFor(pageUrl, mediaCount = 0) {
  if (!isHttpUrl(pageUrl)) return "inactive";
  if (detectPlatform(pageUrl) || mediaCount > 0) return "active";
  return "inactive";
}
