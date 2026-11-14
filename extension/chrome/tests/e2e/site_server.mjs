// Static test site for the end-to-end test. Answers for any host name (the
// browser maps www/cdn.cachalot-test.com, other-site.com and www.youtube.com
// to 127.0.0.1 with --host-resolver-rules).
//   node site_server.mjs --port 47900 --media-dir <dir> [--https-port 47943 --key k.pem --cert c.pem]

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "47900"));
const HTTPS_PORT = Number(arg("https-port", "0"));
const MEDIA_DIR = arg("media-dir", ".");
const KEY = arg("key", "");
const CERT = arg("cert", "");
const BIG_SIZE = 5_000_000;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#5b8def"/><path d="M12 9v14l11-7z" fill="#fff"/></svg>`;

function testPage(port) {
  const cdn = `http://cdn.cachalot-test.com:${port}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Página de teste do Cachalot</title><link rel="icon" href="/favicon.svg">
<meta property="og:image" content="/media/cover.png"></head>
<body style="font-family:sans-serif">
<h1>Página de teste</h1>
<video id="v" muted autoplay playsinline width="320" src="${cdn}/media/clip.webm"></video>
<audio id="a" preload="auto" src="${cdn}/media/song.mp3"></audio>
<p><a id="link" href="http://www.cachalot-test.com:${port}/watch/123">link para outro vídeo</a></p>
<script>
(async () => {
  const get = (u, init) => fetch(u, init).then((r) => r.arrayBuffer()).catch(() => null);
  await get("${cdn}/hls/v42/master.m3u8");
  await get("${cdn}/hls/v42/720p/index.m3u8");
  await get("${cdn}/hls/v42/720p/seg-001.ts");
  await get("${cdn}/dash/show/manifest.mpd");
  await get("${cdn}/dash/show/chunk-1.m4s");
  await get("/media/big.mp4", { headers: { Range: "bytes=2000000-2099999" } });
  await get("/media/init.mp4");
  await get("/api/data.json");
  document.getElementById("v").play().catch(() => {});
  window.__done = true;
})();
</script></body></html>`;
}

function floodPage(n) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Rolagem infinita</title></head><body><p>feed</p>
<script>
(async () => {
  const cdn = location.origin.replace("//www.", "//cdn.");
  for (let i = 0; i < ${n}; i += 10) {
    await Promise.all(Array.from({ length: 10 }, (_, k) => fetch(cdn + "/media/f/" + (i + k) + ".mp4").then((r) => r.arrayBuffer()).catch(() => null)));
  }
  window.__done = true;
})();
</script></body></html>`;
}

/** SoundCloud look-alike: a playing HLS stream announced through Media Session, and track cards. */
function soundcloudLikePage() {
  const card = (slug, title, artist, duration) => `<li class="soundList__item"><div class="sound">
    <span class="sc-artwork" style="background-image: url(&quot;/media/cover.png&quot;)"></span>
    <a class="soundTitle__username" href="/${artist.toLowerCase().replace(/ /g, "-")}"><span>${artist}</span></a>
    <a class="soundTitle__title" href="/${artist.toLowerCase().replace(/ /g, "-")}/${slug}"><span>${title}</span></a>
    <div class="playbackTimeline__duration"><span aria-hidden="true">${duration}</span></div></div></li>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Stream - SoundCloud</title>
<meta property="og:image" content="/media/cover.png"></head><body>
<audio id="player" preload="auto"></audio>
<div class="listenArtworkWrapper"><div><span style="background-image: url(&quot;/media/cover.png&quot;)" aria-label="Stream"></span></div></div>
<ul id="feed">${card("faixa-um", "Faixa Um", "Artista Um", "3:05")}${card("faixa-dois", "Faixa Dois", "Artista Dois", "4:10")}</ul>
<script>
navigator.mediaSession.metadata = new MediaMetadata({
  title: "Música Atual", artist: "Artista Teste", album: "Disco",
  artwork: [{ src: "/media/cover.png", sizes: "640x360", type: "image/png" }],
});
const audio = document.getElementById("player");
audio.src = "/hls/sc/stream.m3u8";
audio.play().catch(() => {});
setTimeout(() => { window.__done = true; }, 500);
window.__more = () => document.getElementById("feed").insertAdjacentHTML("beforeend", ${JSON.stringify(card("faixa-tres", "Faixa Três", "Artista Três", "2:30"))});
</script></body></html>`;
}

/** Bandcamp look-alike album: its tracks and their streams in data-tralbum. */
function bandcampLikePage(port) {
  const tralbum = {
    artist: "Banda Teste",
    trackinfo: [
      { title: "Faixa A", duration: 6.0, file: { "mp3-128": `http://artista.bandcamp.com:${port}/media/song.mp3` }, title_link: "/track/faixa-a" },
      { title: "Faixa B", duration: 200.5, file: null, title_link: "/track/faixa-b" },
    ],
  };
  const attr = JSON.stringify(tralbum).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Disco Teste | Banda Teste</title></head><body>
<div id="tralbumArt"><img src="/media/cover.png" alt=""></div>
<div id="pagedata" data-tralbum="${attr}"></div>
<script>window.__done = true;</script></body></html>`;
}

function youtubeLikePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Vídeo de teste - YouTube</title>
<meta property="og:image" content="/media/cover.png"></head>
<body><video muted autoplay src="/media/clip.webm"></video>
<div id="secondary">
  <ytd-compact-video-renderer>
    <a id="thumbnail" href="/watch?v=AAAAAAAAAAA"><img src="/media/cover.png" alt=""><span class="time">3:21</span></a>
    <a href="/watch?v=AAAAAAAAAAA"><span id="video-title" title="Outro vídeo um">Outro vídeo um</span></a>
  </ytd-compact-video-renderer>
  <ytd-compact-video-renderer>
    <a id="thumbnail" href="/watch?v=BBBBBBBBBBB&amp;list=RDx"><img src="/media/cover.png" alt=""><span>12:05</span></a>
    <h3>Outro vídeo dois</h3>
  </ytd-compact-video-renderer>
  <ytm-shorts-lockup-view-model><a href="/shorts/CCCCCCCCCCC"><img src="/media/cover.png" alt="Um short"></a></ytm-shorts-lockup-view-model>
  <ytd-compact-video-renderer>
    <a id="thumbnail" href="/watch?v=e2eTestVid1&amp;t=10"><img src="/media/cover.png" alt=""></a><span id="video-title">Este mesmo vídeo</span>
  </ytd-compact-video-renderer>
  <p>Descrição com um <a href="/watch?v=DDDDDDDDDDD">link de texto</a>.</p>
</div>
<script>
(async () => {
  await fetch("/hls/v42/master.m3u8").then((r) => r.text()).catch(() => null);
  window.__done = true;
})();
// What scrolling does on YouTube: more cards arrive.
window.__more = () => {
  const card = document.createElement("ytd-rich-item-renderer");
  card.innerHTML = '<a id="thumbnail" href="/watch?v=EEEEEEEEEEE"><img src="/media/cover.png" alt=""><span>0:45</span></a><h3>Vídeo que apareceu ao rolar</h3>';
  document.getElementById("secondary").append(card);
};
</script></body></html>`;
}

function simplePage(title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p></body></html>`;
}

const MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720p/index.m3u8\n";
const VARIANT = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg-001.ts\n#EXT-X-ENDLIST\n";
const MPD = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"></MPD>`;

function sendBuffer(req, res, status, type, buffer, extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Content-Length": buffer.length, ...extra });
  res.end(req.method === "HEAD" ? undefined : buffer);
}

/** Serves a (possibly virtual) file honouring a single "bytes=a-b" range. */
function sendRanged(req, res, type, size, readRange) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  if (!range) {
    return sendBuffer(req, res, 200, type, readRange(0, size - 1), { "Accept-Ranges": "bytes" });
  }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || end < start) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  return sendBuffer(req, res, 206, type, readRange(start, end), {
    "Accept-Ranges": "bytes",
    "Content-Range": `bytes ${start}-${end}/${size}`,
  });
}

function serveFile(req, res, file, type) {
  let data;
  try {
    data = fs.readFileSync(path.join(MEDIA_DIR, file));
  } catch {
    res.writeHead(404);
    return res.end();
  }
  return sendRanged(req, res, type, data.length, (s, e) => data.subarray(s, e + 1));
}

const STREAM_TYPES = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".mpd": "application/dash+xml",
  ".m4s": "video/iso.segment",
};

/** Streams generated by the test (media-dir/hls, media-dir/dash), when present. */
function streamFile(pathname) {
  const file = path.resolve(MEDIA_DIR, ...pathname.split("/").filter(Boolean));
  if (!file.startsWith(path.resolve(MEDIA_DIR)) || !fs.existsSync(file)) return null;
  return { file: path.relative(MEDIA_DIR, file), type: STREAM_TYPES[path.extname(file)] || "application/octet-stream" };
}

let refused = 0;

function handler(port) {
  return (req, res) => {
    const url = new URL(req.url, "http://x");
    const host = (req.headers.host || "").split(":")[0];
    // Hotlink protection on streams, like many video CDNs: the page's Referer is required.
    if (/^\/(hls|dash)\//.test(url.pathname) && !/cachalot-test\.com|youtube\.com|soundcloud\.com/.test(req.headers.referer || "")) {
      refused++;
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("hotlink");
    }
    if (url.pathname === "/__refused") return sendBuffer(req, res, 200, "application/json", Buffer.from(JSON.stringify({ refused })));
    if (url.pathname !== "/hls/v42/master.m3u8" && /^\/(hls|dash)\//.test(url.pathname)) {
      const stream = streamFile(url.pathname);
      if (stream) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        return serveFile(req, res, stream.file, stream.type);
      }
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const html = (body, cookies = []) => {
      const buf = Buffer.from(body, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length, ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
      res.end(buf);
    };

    if (/^\/media\/f\/\d+\.mp4$/.test(url.pathname)) return sendBuffer(req, res, 200, "video/mp4", Buffer.alloc(40_000));

    switch (url.pathname) {
      case "/musica":
      case "/artista-teste/musica-atual":
        return html(soundcloudLikePage());
      case "/album/teste":
        return html(bandcampLikePage(port));
      case "/flood":
        return html(floodPage(Math.min(1000, Number(url.searchParams.get("n")) || 150)));
      case "/":
      case "/index.html":
        if (host === "www.youtube.com") return html(youtubeLikePage());
        return html(testPage(port), [
          "site_session=abc123; Path=/; Domain=cachalot-test.com",
          "www_only=1; Path=/",
        ]);
      case "/watch":
        return html(youtubeLikePage());
      case "/other":
        return html(simplePage("Outro site"), ["other_cookie=nope; Path=/"]);
      case "/empty":
        return html(simplePage("Página sem mídia"));
      case "/favicon.svg":
        return sendBuffer(req, res, 200, "image/svg+xml", Buffer.from(FAVICON));
      case "/media/clip.webm":
        return serveFile(req, res, "clip.webm", "video/webm");
      case "/media/song.mp3":
        return serveFile(req, res, "song.mp3", "audio/mpeg");
      case "/media/cover.png":
        return serveFile(req, res, "cover.png", "image/png");
      case "/media/big.mp4":
        return sendRanged(req, res, "video/mp4", BIG_SIZE, (s, e) => Buffer.alloc(e - s + 1));
      case "/media/init.mp4":
        return sendBuffer(req, res, 200, "video/mp4", Buffer.alloc(50_000));
      case "/hls/v42/master.m3u8":
        return sendBuffer(req, res, 200, "application/vnd.apple.mpegurl", Buffer.from(MASTER));
      case "/hls/v42/720p/index.m3u8":
        return sendBuffer(req, res, 200, "application/vnd.apple.mpegurl", Buffer.from(VARIANT));
      case "/hls/v42/720p/seg-001.ts":
        return sendBuffer(req, res, 200, "video/mp2t", Buffer.alloc(200_000));
      case "/dash/show/manifest.mpd":
        return sendBuffer(req, res, 200, "application/dash+xml", Buffer.from(MPD));
      case "/dash/show/chunk-1.m4s":
        return sendBuffer(req, res, 200, "video/iso.segment", Buffer.alloc(300_000));
      case "/api/data.json":
        return sendBuffer(req, res, 200, "application/json", Buffer.from('{"ok":true}'));
      default:
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
    }
  };
}

http.createServer(handler(PORT)).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`site listening on 127.0.0.1:${PORT}\n`);
});

if (HTTPS_PORT && KEY && CERT) {
  https
    .createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, handler(HTTPS_PORT))
    .listen(HTTPS_PORT, "127.0.0.1", () => {
      process.stdout.write(`site (https) listening on 127.0.0.1:${HTTPS_PORT}\n`);
    });
}
