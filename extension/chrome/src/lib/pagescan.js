// Injected into every frame of the tab when the popup opens (chrome.scripting,
// allFrames). Must stay self-contained: it is serialized and runs in the page.
// Reads only what a preview needs: media elements and the page's cover image.

export function scanFrame() {
  const absolute = (value) => {
    try {
      return value ? new URL(value, document.baseURI).href : "";
    } catch {
      return "";
    }
  };
  const meta = (selector) => absolute(document.querySelector(selector)?.getAttribute("content") || "");
  // Single-page apps leave og:image from the first page loaded: the artwork the page shows wins.
  const hero = document.querySelector(".listenArtworkWrapper [style*='background-image'], .fullHero__artwork [style*='background-image']");
  const heroUrl = (/url\(["']?([^"')]+)["']?\)/.exec(hero?.style?.backgroundImage || "") || [])[1] || "";
  const stale = /(^|\.)soundcloud\.com$/.test(location.hostname); // never updates its og:image when navigating
  const pageImage =
    absolute(heroUrl) ||
    (stale ? "" : meta('meta[property="og:image:secure_url"]')) ||
    (stale ? "" : meta('meta[property="og:image"]')) ||
    (stale ? "" : meta('meta[name="og:image"]')) ||
    (stale ? "" : meta('meta[name="twitter:image"]')) ||
    (stale ? "" : meta('meta[property="twitter:image"]')) ||
    (stale ? "" : absolute(document.querySelector('link[rel="image_src"]')?.getAttribute("href") || ""));

  const elements = [...document.querySelectorAll("video, audio")].slice(0, 30).map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible =
      el.tagName === "VIDEO" &&
      r.width >= 48 &&
      r.height >= 27 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) > 0.1;
    return {
      tag: el.tagName.toLowerCase(),
      src: el.currentSrc || el.src || el.querySelector("source")?.src || "",
      poster: el.poster || "",
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      visible,
      playing: !el.paused && !el.ended,
      started: el.currentTime > 0,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    };
  });

  // YouTube videos shown with a thumbnail (feeds, recommendations, Shorts) or embedded in this frame.
  const ytId = (href) => {
    try {
      const u = new URL(href, document.baseURI);
      const host = u.hostname.replace(/^(www|m|music)\./, "");
      let id = "";
      if (host === "youtu.be") id = u.pathname.split("/")[1] || "";
      else if (host === "youtube.com" || host === "youtube-nocookie.com") {
        id = u.searchParams.get("v") || (/^\/(shorts|live|embed)\/([^/?#]+)/.exec(u.pathname) || [])[2] || "";
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
    } catch {
      return "";
    }
  };
  const CONTAINERS = [
    "ytd-rich-item-renderer", "ytd-compact-video-renderer", "ytd-video-renderer", "ytd-grid-video-renderer",
    "ytd-playlist-panel-video-renderer", "ytd-playlist-video-renderer", "ytd-reel-item-renderer", "ytd-rich-grid-media",
    "yt-lockup-view-model", "ytm-shorts-lockup-view-model", "ytm-shorts-lockup-view-model-v2", "ytd-endscreen-element-renderer",
  ].join(",");
  const TIME = /^\d{1,2}(:\d{2}){1,2}$/;
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const videos = new Map();
  for (const a of document.querySelectorAll('a[href*="watch?v="], a[href*="/shorts/"], a[href*="youtu.be/"]')) {
    if (videos.size >= 200) break;
    const id = ytId(a.getAttribute("href"));
    if (!id) continue;
    // A YouTube card, or (other sites) a link wrapping its picture.
    const container = a.closest(CONTAINERS);
    const box = container || a;
    const img = a.querySelector("img") || container?.querySelector("img") || null;
    const known = videos.get(id);
    if (!img && !known) continue; // text links (descriptions, comments) are not thumbnails
    const title =
      clean(box.querySelector("#video-title, [id='video-title']")?.textContent) ||
      clean(box.querySelector("h3")?.textContent) ||
      clean(a.getAttribute("title")) ||
      clean((a.getAttribute("aria-label") || "").split(/\s+(?:by|de|-)\s+/)[0]) ||
      clean(img?.alt);
    const duration = [...box.querySelectorAll("*")].find((e) => !e.children.length && TIME.test(clean(e.textContent)));
    const thumb = img && /^https?:/.test(img.currentSrc || img.src) ? img.currentSrc || img.src : "";
    if (known) {
      known.title ||= title;
      known.duration ||= duration ? clean(duration.textContent) : "";
      known.thumb ||= thumb;
    } else {
      videos.set(id, {
        id,
        short: /\/shorts\//.test(a.getAttribute("href")),
        title,
        duration: duration ? clean(duration.textContent) : "",
        thumb,
      });
    }
  }
  const embedded = /\/embed\//.test(location.pathname) ? ytId(location.href) : "";
  if (embedded && !videos.has(embedded)) {
    videos.set(embedded, { id: embedded, short: false, title: clean(document.title.replace(/\s*-\s*YouTube$/, "")), duration: "", thumb: "" });
  }

  // Music tracks shown on the page: SoundCloud cards, Bandcamp albums (their own
  // data, with the stream of each track) and schema.org MusicRecording data.
  const clock = (seconds) => {
    const s = Math.floor(Number(seconds) || 0); // as players show it: 200.5 s is 3:20
    if (s <= 0) return "";
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60));
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
  };
  // ISO 8601 durations, including Bandcamp's "P00H03M21S" (no T)
  const isoClock = (value) => {
    const m = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i.exec(String(value || "").trim());
    return m ? clock((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0)) : "";
  };
  const bgUrl = (node) => {
    const m = /url\(["']?([^"')]+)["']?\)/.exec(node?.style?.backgroundImage || "");
    return m ? absolute(m[1]) : "";
  };
  const tracks = new Map();
  const addTrack = (t) => {
    if (!t.url || tracks.size >= 200) return;
    const known = tracks.get(t.url);
    if (!known) tracks.set(t.url, t);
    else for (const k of Object.keys(t)) known[k] ||= t[k];
  };
  if (/(^|\.)soundcloud\.com$/.test(location.hostname)) {
    // SoundCloud renders many card layouts (feed, tiles, sidebar badges, track lists) and renames
    // their classes; what they share: a link to the track (/user/track) or playlist
    // (/user/sets/name), its artwork as a background image, and a link to the user (/user).
    const SYSTEM = /^(discover|you|search|stream|upload|pages|terms-of-use|charts|feed|settings|messages|notifications|getstarted|company|jobs|people|tags|imprint|mobile|popular|artist-pro|pro|creator|home|signin|login|logout)$/;
    const NOT_TRACK = /^(sets|tracks|albums|reposts|likes|followers|following|popular-tracks|comments|spotlight|toptracks|playlists)$/;
    const pathOf = (href) => {
      if (!href || href.startsWith("#")) return null; // play buttons: href="" would read as this page
      try {
        const u = new URL(href, location.href);
        if (!/(^|\.)soundcloud\.com$/.test(u.hostname)) return null;
        const p = u.pathname.split("/").filter(Boolean);
        if (!p.length || SYSTEM.test(p[0])) return null;
        if (p.length === 1) return { kind: "user", path: `/${p[0]}` };
        if (p.length === 2 && !NOT_TRACK.test(p[1])) return { kind: "track", path: `/${p.join("/")}` };
        if (p.length === 3 && p[1] === "sets") return { kind: "set", path: `/${p.join("/")}` };
      } catch {
        // not a URL
      }
      return null;
    };
    const isUserLink = (a) => pathOf(a.getAttribute("href"))?.kind === "user" && clean(a.textContent);
    for (const a of document.querySelectorAll("a[href]")) {
      const target = pathOf(a.getAttribute("href"));
      if (!target || target.kind === "user") continue;
      // the card: the nearest ancestor with an artwork, preferably one that also names the user
      let box = null;
      for (let n = a, i = 0; n && i < 8; n = n.parentElement, i++) {
        const links = [...n.querySelectorAll("a[href]")];
        // an ancestor holding another track's link is the list, not this card
        if (links.some((x) => { const p = pathOf(x.getAttribute("href")); return p && p.kind !== "user" && p.path !== target.path; })) break;
        if (!n.querySelector("[style*='background-image']")) continue;
        box = n;
        if (links.some(isUserLink)) break;
      }
      if (!box) continue;
      const art = box.querySelector("[style*='background-image']");
      const own = [...box.querySelectorAll("a[href]")].filter((x) => pathOf(x.getAttribute("href"))?.path === target.path);
      const title = clean(art?.getAttribute("aria-label")) || own.map((x) => clean(x.textContent)).sort((x, y) => y.length - x.length)[0];
      const duration = [...box.querySelectorAll("span, div")].find((n) => !n.children.length && TIME.test(clean(n.textContent)));
      addTrack({
        url: `${location.origin}${target.path}`,
        title,
        artist: clean(
          ([...box.querySelectorAll("a[href]")].find((x) => isUserLink(x) && /username/i.test(x.className)) ||
            [...box.querySelectorAll("a[href]")].find(isUserLink))?.textContent,
        ),
        duration: duration ? clean(duration.textContent) : "",
        artwork: bgUrl(art).replace(/-t\d+x\d+\./, "-t300x300."),
        stream: "",
        playlist: target.kind === "set",
      });
    }
  }
  for (const holder of document.querySelectorAll("[data-tralbum]")) {
    try {
      const data = JSON.parse(holder.getAttribute("data-tralbum"));
      const art = absolute(document.querySelector("#tralbumArt img, a.popupImage img")?.getAttribute("src") || "") || pageImage;
      for (const t of data.trackinfo || []) {
        if (!t.title_link && !t.file) continue;
        addTrack({
          url: absolute(t.title_link || ""),
          title: clean(t.title),
          artist: clean(t.artist || data.artist),
          duration: clock(t.duration),
          artwork: art,
          stream: absolute(t.file?.["mp3-128"] || Object.values(t.file || {})[0] || ""),
        });
      }
    } catch {
      // not JSON: skip
    }
  }
  const visit = (node, artistHint = "", imageHint = "") => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, artistHint, imageHint));
    const type = [].concat(node["@type"] || []).join(" ");
    const artist = clean(node.byArtist?.name || [].concat(node.byArtist || [])[0]?.name || artistHint);
    const image = absolute([].concat(node.image || [])[0]?.url || [].concat(node.image || [])[0] || "") || imageHint;
    if (/MusicRecording/.test(type) && (node.url || node["@id"])) {
      addTrack({
        url: absolute(node.url || node["@id"]),
        title: clean(node.name),
        artist,
        duration: isoClock(node.duration),
        artwork: image,
        stream: absolute([].concat(node.audio || [])[0]?.contentUrl || ""),
      });
    }
    for (const key of ["@graph", "track", "tracks", "itemListElement", "item", "hasPart"]) {
      if (node[key]) visit(node[key], artist, image);
    }
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.textContent));
    } catch {
      // invalid JSON-LD: skip
    }
  }

  return {
    top: window === window.top,
    dpr: window.devicePixelRatio || 1,
    viewport: { w: innerWidth, h: innerHeight },
    pageImage,
    elements,
    videos: [...videos.values()],
    tracks: [...tracks.values()].filter((t) => t.title),
  };
}

/**
 * What the page says is playing (Media Session API: title, artist, album, artwork).
 * Runs in the page's own world (chrome.scripting, world MAIN). Self-contained.
 */
export function readMediaSession() {
  const m = navigator.mediaSession?.metadata;
  if (!m || !m.title) return null;
  const area = (a) =>
    Math.max(
      0,
      ...String(a.sizes || "")
        .split(/\s+/)
        .map((s) => {
          const [w, h] = s.split("x").map(Number);
          return w * h || 0;
        }),
    );
  const art = [...(m.artwork || [])].sort((a, b) => area(b) - area(a))[0];
  let artwork = "";
  try {
    artwork = art?.src ? new URL(art.src, document.baseURI).href : "";
  } catch {
    artwork = "";
  }
  return { title: String(m.title), artist: String(m.artist || ""), album: String(m.album || ""), artwork };
}
