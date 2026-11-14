// Stream previews for the popup. HLS plays natively (Chrome plays .m3u8 in a
// <video> element) through its lightest variant; DASH has no native player, so
// a small Media Source loader appends the init segment and the first segments
// of the lightest video representation.

/** Variants of an HLS master playlist ([] for a media playlist, null when not HLS). */
export function parseHlsMaster(text, baseUrl) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim());
  if (!lines[0]?.startsWith("#EXTM3U")) return null;
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = lines[i].slice("#EXT-X-STREAM-INF:".length);
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (!uri) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
    try {
      variants.push({
        url: new URL(uri, baseUrl).href,
        bandwidth: Number(/(?:^|,)BANDWIDTH=(\d+)/i.exec(attrs)?.[1] || 0),
        height: res ? Number(res[2]) : 0,
      });
    } catch {
      // unparsable URI: skip the variant
    }
  }
  return variants;
}

/** Lightest variant that still looks like video (≥ 240 lines when the height is known). */
export function pickVariant(variants, minHeight = 240) {
  if (!Array.isArray(variants) || !variants.length) return null;
  const byWeight = [...variants].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
  return byWeight.find((v) => !v.height || v.height >= minHeight) || byWeight[byWeight.length - 1];
}

/** Fills $RepresentationID$, $Number$, $Time$, $Bandwidth$ (with %0Nd widths) of a DASH template. */
export function expandTemplate(template, vars) {
  return String(template || "")
    .replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (_, name, width) => {
      const value = String(vars[name] ?? "");
      return width ? value.padStart(Number(width), "0") : value;
    })
    .replace(/\$\$/g, "$");
}

function children(node, name) {
  return node ? [...node.children].filter((c) => c.localName === name) : [];
}

function child(node, name) {
  return children(node, name)[0] || null;
}

function withBase(node, url) {
  const base = child(node, "BaseURL")?.textContent.trim();
  try {
    return base ? new URL(base, url).href : url;
  } catch {
    return url;
  }
}

/**
 * Plan for previewing a DASH manifest (an XML Document):
 *   { kind: "mse", mime, codecs, init, segments: [url…] }  segment template or list
 *   { kind: "file", url }                                  one fMP4 file (SegmentBase)
 *   null                                                   nothing playable
 * canPlay(type) filters codecs (MediaSource.isTypeSupported in the popup).
 */
export function dashPlan(doc, mpdUrl, { maxSegments = 4, canPlay = () => true } = {}) {
  const mpd = doc?.documentElement;
  if (!mpd || mpd.localName !== "MPD") return null;
  const period = child(mpd, "Period");
  if (!period) return null;
  const periodUrl = withBase(period, withBase(mpd, mpdUrl));

  const reps = [];
  for (const set of children(period, "AdaptationSet")) {
    for (const rep of children(set, "Representation")) {
      const mime = rep.getAttribute("mimeType") || set.getAttribute("mimeType") || "";
      const type = set.getAttribute("contentType") || mime.split("/")[0];
      if (type !== "video") continue;
      const codecs = rep.getAttribute("codecs") || set.getAttribute("codecs") || "";
      const full = `${mime || "video/mp4"}; codecs="${codecs}"`;
      if (!canPlay(full)) continue;
      reps.push({
        set,
        rep,
        mime: mime || "video/mp4",
        codecs,
        bandwidth: Number(rep.getAttribute("bandwidth") || 0),
        height: Number(rep.getAttribute("height") || set.getAttribute("height") || 0),
      });
    }
  }
  const chosen = pickVariant(reps);
  if (!chosen) return null;
  const { set, rep, mime, codecs } = chosen;
  const setUrl = withBase(set, periodUrl);
  const repUrl = withBase(rep, setUrl);
  const vars = { RepresentationID: rep.getAttribute("id") || "", Bandwidth: rep.getAttribute("bandwidth") || "" };
  const resolve = (u) => new URL(expandTemplate(u, vars), repUrl).href;

  const template = child(rep, "SegmentTemplate") || child(set, "SegmentTemplate") || child(period, "SegmentTemplate");
  if (template?.getAttribute("media")) {
    const media = template.getAttribute("media");
    const start = Number(template.getAttribute("startNumber") || 1);
    const segments = [];
    const timeline = child(template, "SegmentTimeline");
    if (timeline) {
      let t = 0;
      let n = start;
      for (const s of children(timeline, "S")) {
        if (s.hasAttribute("t")) t = Number(s.getAttribute("t"));
        const d = Number(s.getAttribute("d") || 0);
        const r = Number(s.getAttribute("r") || 0);
        for (let k = 0; k <= (r < 0 ? maxSegments : r) && segments.length < maxSegments; k++) {
          segments.push(new URL(expandTemplate(media, { ...vars, Number: n, Time: t }), repUrl).href);
          t += d;
          n++;
        }
        if (segments.length >= maxSegments) break;
      }
    } else {
      for (let k = 0; k < maxSegments; k++) segments.push(new URL(expandTemplate(media, { ...vars, Number: start + k }), repUrl).href);
    }
    const init = template.getAttribute("initialization");
    return { kind: "mse", mime, codecs, init: init ? resolve(init) : null, segments };
  }

  const list = child(rep, "SegmentList") || child(set, "SegmentList");
  if (list) {
    const init = child(list, "Initialization")?.getAttribute("sourceURL");
    const segments = children(list, "SegmentURL")
      .slice(0, maxSegments)
      .map((s) => s.getAttribute("media"))
      .filter(Boolean)
      .map(resolve);
    return segments.length ? { kind: "mse", mime, codecs, init: init ? resolve(init) : null, segments } : null;
  }

  // SegmentBase: the representation is one fragmented MP4 the <video> plays by itself.
  return repUrl !== periodUrl || child(rep, "BaseURL") ? { kind: "file", url: repUrl } : null;
}

/**
 * Feeds an MSE plan into a <video>. Resolves once the first media segment is
 * appended (a frame can show); the rest keeps loading in the background until
 * signal aborts. Rejects when nothing could be appended.
 */
export function attachMse(video, plan, { signal, fetchImpl = fetch } = {}) {
  return new Promise((resolve, reject) => {
    const ms = new MediaSource();
    const objectUrl = URL.createObjectURL(ms);
    video.src = objectUrl;
    signal?.addEventListener("abort", () => URL.revokeObjectURL(objectUrl), { once: true });
    ms.addEventListener(
      "sourceopen",
      async () => {
        let appended = 0;
        try {
          const sb = ms.addSourceBuffer(`${plan.mime}; codecs="${plan.codecs}"`);
          const append = (buf) =>
            new Promise((ok, fail) => {
              sb.addEventListener("updateend", ok, { once: true });
              sb.addEventListener("error", fail, { once: true });
              sb.appendBuffer(buf);
            });
          const get = async (url) => {
            const res = await fetchImpl(url, { signal, credentials: "include" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.arrayBuffer();
          };
          if (plan.init) await append(await get(plan.init));
          for (const url of plan.segments) {
            if (signal?.aborted) return;
            await append(await get(url));
            if (++appended === 1) resolve();
          }
          if (ms.readyState === "open") ms.endOfStream();
        } catch (err) {
          if (!appended) reject(err);
        }
      },
      { once: true },
    );
  });
}
