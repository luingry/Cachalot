import test from "node:test";
import assert from "node:assert/strict";
import {
  PLATFORMS,
  detectPlatform,
  iconStateFor,
  isIgnoredMediaHost,
  isMusicPlatform,
  isPageOnlyPlatform,
} from "../src/lib/platforms.js";

const CASES = [
  ["https://www.youtube.com/watch?v=abc", "youtube"],
  ["https://youtu.be/abc", "youtube"],
  ["https://m.youtube.com/shorts/abc", "youtube"],
  ["https://www.instagram.com/reel/abc/", "instagram"],
  ["https://www.tiktok.com/@u/video/1", "tiktok"],
  ["https://x.com/u/status/1", "twitter"],
  ["https://twitter.com/u/status/1", "twitter"],
  ["https://old.reddit.com/r/videos/comments/x", "reddit"],
  ["https://www.twitch.tv/videos/1", "twitch"],
  ["https://br.pinterest.com/pin/1/", "pinterest"],
  ["https://www.pinterest.co.uk/pin/1/", "pinterest"],
  ["https://pin.it/abc", "pinterest"],
  ["https://bsky.app/profile/a/post/b", "bluesky"],
  ["https://www.threads.net/@a/post/b", "threads"],
  ["https://www.threads.com/@a/post/b", "threads"],
  ["https://vimeo.com/123", "vimeo"],
  ["https://player.vimeo.com/video/123", "vimeo"],
  ["https://soundcloud.com/a/b", "soundcloud"],
  ["https://www.facebook.com/watch/?v=1", "facebook"],
  ["https://fb.watch/abc", "facebook"],
  ["https://www.bilibili.com/video/BV1", "bilibili"],
  ["https://www.dailymotion.com/video/x1", "dailymotion"],
  ["https://kick.com/a", "kick"],
  ["https://artist.bandcamp.com/track/x", "bandcamp"],
  ["https://someone.tumblr.com/post/1", "tumblr"],
  ["https://www.douyin.com/video/1", "douyin"],
  ["https://www.mixcloud.com/dj/set/", "mixcloud"],
  ["https://audiomack.com/artist/song/faixa", "audiomack"],
];

test("detectPlatform recognizes every listed platform", () => {
  for (const [url, id] of CASES) {
    assert.equal(detectPlatform(url)?.id, id, url);
  }
  const covered = new Set(CASES.map(([, id]) => id));
  for (const p of PLATFORMS) assert.ok(covered.has(p.id), `test case missing for ${p.id}`);
});

test("detectPlatform rejects look-alikes and non-http URLs", () => {
  assert.equal(detectPlatform("https://notyoutube.com/watch"), null);
  assert.equal(detectPlatform("https://youtube.com.evil.net/"), null);
  assert.equal(detectPlatform("https://example.com/"), null);
  assert.equal(detectPlatform("chrome://newtab"), null);
  assert.equal(detectPlatform("file:///C:/video.mp4"), null);
  assert.equal(detectPlatform("garbage"), null);
});

test("YouTube pages only offer the page URL", () => {
  assert.ok(isPageOnlyPlatform("https://www.youtube.com/watch?v=1"));
  assert.ok(!isPageOnlyPlatform("https://vimeo.com/1"));
  assert.ok(isIgnoredMediaHost("https://rr3---sn-abc.googlevideo.com/videoplayback?itag=18"));
  assert.ok(!isIgnoredMediaHost("https://cdn.example.com/a.mp4"));
  assert.ok(isIgnoredMediaHost("blob:https://x.com/123"));
});

test("music platforms", () => {
  assert.ok(isMusicPlatform("https://soundcloud.com/discover"));
  assert.ok(isMusicPlatform("https://artista.bandcamp.com/album/x"));
  assert.ok(isMusicPlatform("https://www.mixcloud.com/dj/"));
  assert.ok(!isMusicPlatform("https://www.youtube.com/watch?v=1"));
  assert.ok(!isMusicPlatform("https://example.com/"));
});

test("iconStateFor: active on platforms or with sniffed media", () => {
  assert.equal(iconStateFor("https://www.youtube.com/", 0), "active");
  assert.equal(iconStateFor("https://example.com/", 0), "inactive");
  assert.equal(iconStateFor("https://example.com/", 2), "active");
  assert.equal(iconStateFor("chrome://extensions", 3), "inactive");
  assert.equal(iconStateFor(undefined), "inactive");
});
