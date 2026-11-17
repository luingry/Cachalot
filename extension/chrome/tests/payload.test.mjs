import test from "node:test";
import assert from "node:assert/strict";
import { MENU_AUDIO, MENU_DOWNLOAD, buildDownloadPayload, contextMenuMode, contextMenuTarget } from "../src/lib/payload.js";
import { createBadgeFeedback } from "../src/lib/feedback.js";

test("buildDownloadPayload follows the bridge contract", () => {
  const body = buildDownloadPayload({
    urls: ["https://cdn.x.com/a.m3u8", "javascript:alert(1)"],
    mode: "video",
    title: "  Meu vídeo  ",
    pageUrl: "https://x.com/watch",
    headers: { Referer: "https://x.com/watch", "User-Agent": "UA", Cookie: "nope", Origin: "" },
    cookies: [{ name: "a" }],
  });
  assert.deepEqual(body, {
    urls: ["https://cdn.x.com/a.m3u8"],
    mode: "video",
    quality: null,
    title: "Meu vídeo",
    pageUrl: "https://x.com/watch",
    headers: { Referer: "https://x.com/watch", "User-Agent": "UA" },
    cookies: [{ name: "a" }],
  });
});

test("buildDownloadPayload omits optional fields and normalizes mode", () => {
  assert.deepEqual(buildDownloadPayload({ urls: "https://x.com/v", mode: "weird" }), { urls: ["https://x.com/v"], mode: null, quality: null });
  assert.deepEqual(buildDownloadPayload({ urls: ["https://x.com/v"], mode: "audio", headers: {}, cookies: [] }), { urls: ["https://x.com/v"], mode: "audio", quality: null });
  assert.equal(buildDownloadPayload({ urls: ["https://x"], title: "t".repeat(500) }).title.length, 300);
  assert.equal(buildDownloadPayload({ urls: ["https://x"], pageUrl: "chrome://newtab" }).pageUrl, undefined);
});

test("contextMenuTarget prefers link, then src, then frame, then page", () => {
  const tab = { url: "https://site.com/page" };
  assert.deepEqual(contextMenuTarget({ linkUrl: "https://a.com/l", srcUrl: "https://a.com/s.mp4", pageUrl: tab.url }, tab), { url: "https://a.com/l", source: "link" });
  assert.deepEqual(contextMenuTarget({ srcUrl: "https://a.com/s.mp4", pageUrl: tab.url }, tab), { url: "https://a.com/s.mp4", source: "src" });
  assert.deepEqual(contextMenuTarget({ srcUrl: "blob:https://site.com/1", pageUrl: tab.url }, tab), { url: tab.url, source: "page" });
  assert.deepEqual(contextMenuTarget({ frameUrl: "https://www.youtube.com/embed/x", pageUrl: tab.url }, tab), { url: "https://www.youtube.com/embed/x", source: "frame" });
  assert.deepEqual(contextMenuTarget({}, tab), { url: tab.url, source: "page" });
  assert.equal(contextMenuTarget({ pageUrl: "chrome://extensions" }, null), null);
  const magnet = "magnet:?xt=urn:btih:abc&dn=x";
  assert.deepEqual(contextMenuTarget({ linkUrl: magnet, pageUrl: tab.url }, tab), { url: magnet, source: "link" });
  assert.deepEqual(contextMenuTarget({ linkUrl: "mailto:a@b.c", pageUrl: tab.url }, tab), { url: tab.url, source: "page" });
});

test("buildDownloadPayload keeps magnet links (Cachalot accepts them)", () => {
  const magnet = "magnet:?xt=urn:btih:abc";
  assert.deepEqual(buildDownloadPayload({ urls: [magnet, "ftp://x/y"] }).urls, [magnet]);
});

test("contextMenuMode", () => {
  assert.equal(contextMenuMode({ menuItemId: MENU_AUDIO, mediaType: "video" }), "audio");
  assert.equal(contextMenuMode({ menuItemId: MENU_DOWNLOAD, mediaType: "video" }), "video");
  assert.equal(contextMenuMode({ menuItemId: MENU_DOWNLOAD, mediaType: "audio" }), "audio");
  assert.equal(contextMenuMode({ menuItemId: MENU_DOWNLOAD, mediaType: "image" }), null);
  assert.equal(contextMenuMode({ menuItemId: MENU_DOWNLOAD }), null);
});

test("badge feedback shows ✓ / ! and restores after the delay", async () => {
  const painted = [];
  const restored = [];
  const timers = [];
  const fb = createBadgeFeedback({
    setBadge: async (tabId, text, color) => painted.push([tabId, text, color]),
    restore: (tabId) => restored.push(tabId),
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimeoutFn: (h) => {
      timers[h].cleared = true;
    },
  });
  await fb.show(7, true);
  assert.deepEqual(painted[0], [7, "✓", "#63C28F"]);
  assert.equal(timers[0].ms, 2000);
  assert.ok(fb.isActive(7));
  await fb.show(7, false);
  assert.deepEqual(painted[1], [7, "!", "#E5675B"]);
  assert.ok(timers[0].cleared, "a new feedback replaces the pending one");
  timers[1].fn();
  assert.deepEqual(restored, [7]);
  assert.ok(!fb.isActive(7));
  await fb.show(undefined, true);
  await fb.show(-1, true);
  assert.equal(painted.length, 2, "no tab, no badge");
});

test("buildDownloadPayload carries the picked audio format and the remember flag", async () => {
  const { buildDownloadPayload } = await import("../src/lib/payload.js");
  const url = "https://soundcloud.com/forss/flickermood";
  const picked = buildDownloadPayload({ urls: [url], mode: "audio", audioFormat: "mp3", rememberFormat: true });
  assert.equal(picked.audioFormat, "mp3");
  assert.equal(picked.rememberFormat, true);
  const notRemembered = buildDownloadPayload({ urls: [url], audioFormat: "wav" });
  assert.equal(notRemembered.audioFormat, "wav");
  assert.equal("rememberFormat" in notRemembered, false);
  const unknown = buildDownloadPayload({ urls: [url], audioFormat: "exe", rememberFormat: true });
  assert.equal("audioFormat" in unknown, false);
  assert.equal("rememberFormat" in unknown, false);
});
