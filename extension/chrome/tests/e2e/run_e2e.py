"""End-to-end test of the Cachalot Chrome extension.

Starts the mock bridge and the test site (Node), launches Playwright's
Chromium with the unpacked extension, drives the popup and options pages and
asserts what the bridge received. Screenshots go to <work>/screens.

    py -3 extension/chrome/tests/e2e/run_e2e.py --work <scratch dir> [--headed] [--ext <dir>] [--wait-ports 120]

Needs: node, Python Playwright with a downloaded Chromium, optionally ffmpeg
(real test clips) and the `cryptography` package (HTTPS YouTube look-alike).
"""

import argparse
import datetime
import json
import os
import pathlib
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
import zlib

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXT = HERE.parent.parent
BRIDGE_PORT = 47821
SITE_PORT = 47900
HTTPS_PORT = 47943
CODE = "ABCD2345"
SITE = f"http://www.cachalot-test.com:{SITE_PORT}"
CDN = f"http://cdn.cachalot-test.com:{SITE_PORT}"
PAGE_URL = SITE + "/"
PAGE_TITLE = "Página de teste do Cachalot"
HOST_RULES = ", ".join(
    f"MAP {h} 127.0.0.1"
    # i.ytimg.com: YouTube's pictures must not reach the internet in the test (refused at once)
    for h in ("www.cachalot-test.com", "cdn.cachalot-test.com", "other-site.com", "www.youtube.com", "i.ytimg.com",
              "soundcloud.com", "w.soundcloud.com", "artista.bandcamp.com")
)


# ---- small helpers -----------------------------------------------------------


class Checks:
    def __init__(self):
        self.results = []

    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok), detail))
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {name}" + (f" -- {detail}" if detail and not ok else ""), flush=True)
        return bool(ok)

    def skip(self, name, why):
        self.results.append((name, None, why))
        print(f"[SKIP] {name} -- {why}", flush=True)

    def summary(self):
        passed = sum(1 for _, ok, _ in self.results if ok is True)
        failed = [r for r in self.results if r[1] is False]
        skipped = sum(1 for _, ok, _ in self.results if ok is None)
        return passed, failed, skipped


def chromium_executable():
    explicit = os.environ.get("CACHALOT_CHROMIUM")
    if explicit:
        return explicit
    base = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
    found = sorted(base.glob("chromium-*/chrome-win64/chrome.exe"), key=lambda p: int(p.parts[-3].split("-")[1]))
    return str(found[-1]) if found else None


def wait_port(port, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(0.3)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.1)
    return False


def port_free(port):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) != 0


def start_node(script, args, log_path):
    log = open(log_path, "w", encoding="utf-8")
    return subprocess.Popen(["node", str(HERE / script), *args], stdout=log, stderr=subprocess.STDOUT)


def bridge(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{BRIDGE_PORT}{path}", data=data, method="POST" if body is not None else "GET",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read().decode())


def bridge_site(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{SITE_PORT}{path}", timeout=5) as res:
        return json.loads(res.read().decode())


def poll(fn, cond, timeout=10.0, interval=0.2):
    deadline = time.time() + timeout
    value = fn()
    while not cond(value) and time.time() < deadline:
        time.sleep(interval)
        value = fn()
    return value


def generate_media(media_dir):
    """Real WebM/MP3 clips via ffmpeg when available, otherwise filler bytes."""
    media_dir.mkdir(parents=True, exist_ok=True)
    clip, song = media_dir / "clip.webm", media_dir / "song.mp3"
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg and not clip.exists():
        for codec in ("libvpx-vp9", "libvpx"):
            r = subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
                                "-t", "4", "-c:v", codec, "-b:v", "900k", "-an", str(clip)])
            if r.returncode == 0:
                break
    if ffmpeg and not song.exists():
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
                        "-c:a", "libmp3lame", "-b:a", "128k", str(song)])
    # Real streams for the popup previews (the page itself only fetches them).
    hls_dir = media_dir / "hls" / "v42" / "720p"
    if ffmpeg and not (hls_dir / "index.m3u8").exists():
        hls_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
                        "-f", "lavfi", "-i", "sine=frequency=330:duration=6", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-g", "48", "-c:a", "aac", "-hls_time", "2", "-hls_list_size", "0", "-start_number", "1",
                        "-hls_segment_filename", str(hls_dir / "seg-%03d.ts"), str(hls_dir / "index.m3u8")])
    sc_dir = media_dir / "hls" / "sc"
    if ffmpeg and not (sc_dir / "stream.m3u8").exists():  # an audio-only HLS stream, like SoundCloud's
        sc_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=520:duration=20",
                        "-c:a", "aac", "-b:a", "96k", "-hls_time", "2", "-hls_list_size", "0",
                        "-hls_segment_filename", "seg-%03d.ts", "stream.m3u8"], cwd=sc_dir)
    dash_dir = media_dir / "dash" / "show"
    if ffmpeg and not (dash_dir / "manifest.mpd").exists():
        dash_dir.mkdir(parents=True, exist_ok=True)
        # cwd: on Windows the dash muxer writes the segments to the working directory, not next to the manifest
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "6",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "48", "-an", "-f", "dash", "-seg_duration", "2",
                        "-use_template", "1", "-use_timeline", "1", "-init_seg_name", "init-$RepresentationID$.m4s",
                        "-media_seg_name", "chunk-$RepresentationID$-$Number$.m4s", "manifest.mpd"], cwd=dash_dir)
    cover = media_dir / "cover.png"
    if ffmpeg and not cover.exists():
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360", "-frames:v", "1", str(cover)])
    if not cover.exists():  # 1x1 PNG
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        cover.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
                          + chunk(b"IDAT", zlib.compress(b"\x00\xe8\x74\x3c\xff")) + chunk(b"IEND", b""))
    if not clip.exists():
        clip.write_bytes(os.urandom(600_000))
    if not song.exists():
        song.write_bytes(os.urandom(200_000))
    return clip.stat().st_size, song.stat().st_size, bool(ffmpeg)


def make_cert(cert_dir):
    """Self-signed certificate for www.youtube.com, or None without `cryptography`."""
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        return None
    cert_dir.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "www.youtube.com")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=7))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("www.youtube.com")]), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path, cert_path = cert_dir / "key.pem", cert_dir / "cert.pem"
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                           serialization.NoEncryption()))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return key_path, cert_path


# ---- the test ------------------------------------------------------------------


def run(args):
    work = pathlib.Path(args.work).resolve()
    ext_dir = pathlib.Path(args.ext).resolve() if args.ext else EXT
    print(f"extension under test: {ext_dir}")
    screens = work / "screens"
    screens.mkdir(parents=True, exist_ok=True)
    profile = work / "profile"
    shutil.rmtree(profile, ignore_errors=True)
    checks = Checks()

    global BRIDGE_PORT
    BRIDGE_PORT = args.bridge_port
    # A bridge port outside 47821–47830 (with --only) lets the test run while Cachalot itself is open: the
    # extension is pointed at the mock with its port override and never probes the real app.
    probing = 47821 <= BRIDGE_PORT <= 47830
    ports = [*(range(47821, 47831) if probing else [BRIDGE_PORT]), SITE_PORT, HTTPS_PORT]
    deadline = time.time() + args.wait_ports
    busy = [port for port in ports if not port_free(port)]
    if busy:
        print(f"waiting up to {args.wait_ports}s for ports {busy} (Cachalot itself running?)", flush=True)
    while busy and time.time() < deadline:
        time.sleep(2)
        busy = [port for port in ports if not port_free(port)]
    if busy:
        print(f"ports {busy} are busy: stop whatever listens there (Cachalot itself?) and retry")
        return 2

    clip_size, song_size, real_media = generate_media(work / "media")
    print(f"media: clip.webm {clip_size} B, song.mp3 {song_size} B ({'ffmpeg' if real_media else 'filler bytes'})")
    cert = make_cert(work / "cert")

    site_args = ["--port", str(SITE_PORT), "--media-dir", str(work / "media")]
    if cert:
        site_args += ["--https-port", str(HTTPS_PORT), "--key", str(cert[0]), "--cert", str(cert[1])]
    site = start_node("site_server.mjs", site_args, work / "site.log")
    mock = start_node("mock_bridge.mjs", ["--port", str(BRIDGE_PORT), "--code", CODE], work / "bridge.log")
    procs = [site, mock]
    page_errors = []
    try:
        if not (wait_port(SITE_PORT) and wait_port(BRIDGE_PORT)):
            print("servers did not start; see site.log / bridge.log")
            return 2

        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                str(profile),
                executable_path=chromium_executable(),
                headless=not args.headed,
                args=[
                    f"--disable-extensions-except={ext_dir}",
                    f"--load-extension={ext_dir}",
                    f"--host-resolver-rules={HOST_RULES}",
                    "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable",
                    "--autoplay-policy=no-user-gesture-required",
                ],
                ignore_https_errors=True,
                viewport={"width": 1000, "height": 800},
            )
            try:
                _scenario(ctx, checks, screens, work, clip_size, song_size, cert, mock, page_errors, real_media, only=args.only)
            except Exception:
                traceback.print_exc()
                checks.check("scenario finished without exceptions", False, "see traceback")
            finally:
                ctx.close()
    finally:
        for proc in procs:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    passed, failed, skipped = checks.summary()
    print("\n==== summary ====")
    print(f"passed: {passed}  failed: {len(failed)}  skipped: {skipped}")
    for name, _, detail in failed:
        print(f"  FAILED: {name} -- {detail}")
    print(f"screenshots: {screens}")
    return 0 if not failed else 1


def _scenario(ctx, checks, screens, work, clip_size, song_size, cert, mock, page_errors, real_media=True, only=None):
    c = checks.check

    def get_sw():
        for w in ctx.service_workers:
            if w.url.startswith("chrome-extension://"):
                return w
        return ctx.wait_for_event("serviceworker", timeout=15000)

    sw = get_sw()
    ext_id = sw.url.split("/")[2]
    print(f"extension id: {ext_id}")

    def sw_eval(expr, arg=None):
        return get_sw().evaluate(expr, arg)

    def tab_id_for(prefix):
        tabs = sw_eval("async () => (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url || t.pendingUrl }))")
        return next((t["id"] for t in tabs if (t["url"] or "").startswith(prefix)), None)

    def items(tab_id):
        return sw_eval(
            "async (id) => ((await chrome.storage.session.get('media:' + id))['media:' + id] || { items: [] }).items",
            tab_id,
        )

    def badge(tab_id):
        return sw_eval("(id) => chrome.action.getBadgeText({ tabId: id })", tab_id)

    def icon_state(tab_id):
        return sw_eval("(id) => globalThis.cachalot.iconState(id)", tab_id)

    def local_storage():
        return sw_eval("() => chrome.storage.local.get(null)")

    def log():
        return bridge("/__log")

    def wait_request(path, count_before, timeout=6.0):
        entries = poll(lambda: [e for e in log() if e["path"] == path], lambda v: len(v) > count_before, timeout)
        return entries[-1] if len(entries) > count_before else None

    def count(path):
        return len([e for e in log() if e["path"] == path])

    def watch(page):
        # Only the extension's own pages count; the test site may 404 its favicon.
        def ours():
            return page.url.startswith("chrome-extension://")

        page.on("pageerror", lambda e: ours() and page_errors.append(f"{page.url}: {e}"))
        page.on("console", lambda m: m.type == "error" and ours() and page_errors.append(f"{page.url}: {m.text}"))
        return page

    def shot(page, name, full=False):
        path = screens / name
        if full:
            page.screenshot(path=str(path), full_page=True)
        else:
            page.locator("body").screenshot(path=str(path))
        print(f"  screenshot {path}")

    # On install the worker calls chrome.runtime.openOptionsPage(); here the
    # options tab is usually replaced by Playwright's initial about:blank, so
    # it is closed if present and not asserted.
    time.sleep(0.5)
    for pg in list(ctx.pages):
        if pg.url.startswith(f"chrome-extension://{ext_id}/pages/options.html"):
            pg.close()

    # 1. Cookies of another site that must never be sent.
    page = watch(ctx.pages[0] if ctx.pages else ctx.new_page())
    page.goto(f"http://other-site.com:{SITE_PORT}/other")

    # 2. Test page with video, audio, HLS, DASH and noise requests.
    page.goto(PAGE_URL)
    page.wait_for_function("() => window.__done === true", timeout=15000)
    tab_id = tab_id_for(SITE)
    c("test page tab found", tab_id is not None)

    def kinds_ready(v):
        k = sorted(e["kind"] for e in v)
        return k.count("hls") >= 2 and "dash" in k and "video" in k and "audio" in k

    got = poll(lambda: items(tab_id), kinds_ready, timeout=12)
    urls = [e["url"] for e in got]
    c("sniffer lists HLS master + variant, DASH, video and audio", kinds_ready(got), f"got {urls}")
    noise = [u for u in urls if any(s in u for s in ("seg-001.ts", "chunk-1.m4s", "big.mp4", "init.mp4", "data.json"))]
    c("sniffer hides segments, range fragments, init chunks and JSON", not noise, f"noise {noise}")
    c("sniffer keeps a single entry per origin+path", len(urls) == len({u.split("?")[0] for u in urls}), str(urls))
    by_url = {e["url"]: e for e in got}
    master = by_url.get(CDN + "/hls/v42/master.m3u8", {})
    mh = master.get("headers", {})
    c("HLS entry captured Referer", mh.get("Referer", "").startswith(SITE), str(mh))
    c("HLS entry captured Origin", mh.get("Origin") == SITE, str(mh))
    c("HLS entry captured User-Agent", len(mh.get("User-Agent", "")) > 10, str(mh))
    clip = by_url.get(CDN + "/media/clip.webm", {})
    c("video entry size comes from Content-Length/Content-Range", clip.get("size") == clip_size, f"{clip.get('size')} vs {clip_size}")
    c("video entry captured Referer", clip.get("headers", {}).get("Referer", "").startswith(SITE), str(clip.get("headers")))
    song = by_url.get(CDN + "/media/song.mp3", {})
    c("audio entry size", song.get("size") == song_size, f"{song.get('size')} vs {song_size}")
    c("toolbar badge shows grouped media count (4)", poll(lambda: badge(tab_id), lambda v: v == "4") == "4", badge(tab_id))
    c("toolbar icon is active on a page with media", icon_state(tab_id) == "active", str(icon_state(tab_id)))

    # 3. Popup, unpaired.
    popup = watch(ctx.new_page())
    popup.set_viewport_size({"width": 360, "height": 640})
    popup_url = f"chrome-extension://{ext_id}/popup/popup.html?tab={tab_id}"

    def open_popup(url=popup_url):
        popup.goto(url)
        popup.wait_for_selector("body[data-ready='1']", timeout=15000)
        popup.wait_for_function("() => document.getElementById('status').dataset.state !== 'checking'", timeout=15000)

    if only:
        # Just one part, already paired with the mock (on its own port when Cachalot itself is running).
        sw_eval("([code, port]) => chrome.storage.local.set({ pairingCode: code, portOverride: port })", [CODE, BRIDGE_PORT])
        open_popup()
        c("popup paired with the mock", popup.eval_on_selector("#status", "e => e.dataset.state") == "paired")
        AUDIO = "Áudio"

        def row_css(label):
            return f'.media-row:has(.chip:text-is("{label}"))'

        if only == "transient":
            _transient(c, popup, open_popup, row_css, AUDIO, count, wait_request, shot)
        relevant = [e for e in page_errors if "favicon" not in e and "ERR_CONNECTION_REFUSED" not in e]
        c("no errors in extension pages", not relevant, "; ".join(relevant[:5]))
        return

    def status_state():
        return popup.eval_on_selector("#status", "e => e.dataset.state")

    def text(sel):
        return popup.locator(sel).inner_text().strip()

    open_popup()
    c("popup: unpaired state without a code", status_state() == "unpaired", status_state())
    c("popup: status text asks for the code", text("#statusText") == "Cole o código de pareamento", text("#statusText"))
    c("popup: inline pairing field visible", popup.locator("#pairInput").is_visible())
    c("popup: send buttons disabled while unpaired", popup.locator("#sendPage").is_disabled())
    HLS, DASH, VIDEO, AUDIO = "Vídeo HLS", "DASH", "Vídeo", "Áudio"

    def row_css(label):
        return f'.media-row:has(.chip:text-is("{label}"))'

    def row_labels():
        return popup.locator(".media-row .chip").all_inner_texts()

    labels = row_labels()
    c("popup: one row per media (HLS variants grouped)", sorted(labels) == sorted([HLS, DASH, VIDEO, AUDIO]), str(labels))
    # Newest first by default, by the detection times the worker stored (an HLS group: its first playlist).
    first_seen = {}
    for e in items(tab_id):
        label = {"hls": HLS, "dash": DASH, "video": VIDEO, "audio": AUDIO}[e["kind"]]
        first_seen[label] = min(first_seen.get(label, e["detectedAt"]), e["detectedAt"])
    # oldest → newest (ties keep detection order), then reversed: what the popup does
    newest = list(reversed(sorted(first_seen, key=lambda k: first_seen[k])))
    c("popup: newest media first by default", labels == newest, f"{labels} vs {newest}")
    c("popup: order toggle next to the count",
      popup.locator(".section-tools #sortOrder + #mediaCount").count() == 1 and popup.locator("#sortOrder").is_visible()
      and popup.get_attribute("#sortOrder", "aria-pressed") == "false")
    popup.click("#sortOrder")
    c("popup: the toggle shows the oldest first", row_labels() == newest[::-1], str(row_labels()))
    c("popup: toggle state exposed (aria-pressed, title)",
      popup.get_attribute("#sortOrder", "aria-pressed") == "true" and "antigas" in popup.get_attribute("#sortOrder", "title"))
    open_popup()
    c("popup: the chosen order is remembered", row_labels() == newest[::-1], str(row_labels()))
    popup.click("#sortOrder")
    c("popup: toggling again restores newest first", row_labels() == newest, str(row_labels()))
    meta_hls = popup.locator(row_css(HLS) + " .media-meta").inner_text()
    c("popup: HLS row shows +1 variante", meta_hls.startswith("+1 variante"), meta_hls)
    meta_video = popup.locator(row_css(VIDEO) + " .media-meta").inner_text()
    c("popup: video row shows the size", "KB" in meta_video or "MB" in meta_video, meta_video)
    c("popup: page title shown", text("#pageTitle") == PAGE_TITLE, text("#pageTitle"))
    c("popup: cookie switch on by default", popup.locator("#cookieSwitch").is_checked())
    c("popup: cookie meta shows the registrable domain", text("#cookieMeta").startswith("cachalot-test.com · 2 cookies"), text("#cookieMeta"))

    # Thumbnails and previews by media type. The streams are hotlink-protected
    # (Referer required): they only load through the popup's Referer rule.
    def previews():
        return popup.eval_on_selector_all(
            ".media-row",
            "rs => rs.map(r => { const t = r.querySelector('.thumb'); return { label: r.querySelector('.chip').textContent,"
            " kind: t.dataset.preview || '', src: (t.querySelector('.thumb-media') || {}).src || '' }; })",
        )

    def by_label(v):
        return {p["label"]: {"kind": p["kind"], "src": p["src"]} for p in v}

    def previews_settled(v):
        return len(v) == 4 and all(p["kind"] for p in v)

    def pop_state():
        return popup.eval_on_selector(
            "#previewPop",
            "p => ({ open: p.classList.contains('is-open'), tag: p.firstElementChild ? p.firstElementChild.tagName : '',"
            " playing: p.dataset.playing === '1', frame: p.firstElementChild && p.firstElementChild.videoWidth > 0 })",
        )

    def hover_preview(label):
        popup.hover(row_css(label) + " .thumb")
        return poll(pop_state, lambda s: s["playing"], timeout=12)

    def unhover():
        popup.mouse.move(5, 5)
        popup.wait_for_function("() => !document.getElementById('previewPop').classList.contains('is-open')", timeout=3000)

    popup.wait_for_function("() => Number(document.body.dataset.previews || 0) >= 1", timeout=15000)
    pv = by_label(poll(previews, previews_settled, timeout=20))
    cover_url = SITE + "/media/cover.png"
    if real_media:
        c("thumbs: HLS row shows a frame of the stream (native HLS, lightest variant)",
          pv[HLS]["kind"] == "stream" and pv[HLS]["src"] == CDN + "/hls/v42/720p/index.m3u8", str(pv.get(HLS)))
        c("thumbs: DASH row shows a frame of the stream (MSE)", pv[DASH]["kind"] == "stream" and pv[DASH]["src"].startswith("blob:"), str(pv.get(DASH)))
        c("thumbs: direct video shows a frame of the file", pv[VIDEO]["kind"] == "video" and pv[VIDEO]["src"].startswith(CDN + "/media/clip.webm"), str(pv.get(VIDEO)))
    c("thumbs: audio row shows the page cover", pv[AUDIO] == {"kind": "image", "src": cover_url}, str(pv.get(AUDIO)))
    popup.wait_for_function("() => document.querySelectorAll('.thumb.has-media').length === 4", timeout=5000)
    shot(popup, "01-unpaired.png")

    if real_media:
        st = hover_preview(HLS)
        c("preview: hovering HLS plays the stream", st["open"] and st["tag"] == "VIDEO" and st["playing"] and st["frame"], str(st))
        time.sleep(0.6)
        shot(popup, "01b-hover-hls.png")
        unhover()
        st = hover_preview(DASH)
        c("preview: hovering DASH plays the stream", st["open"] and st["tag"] == "VIDEO" and st["playing"] and st["frame"], str(st))
        unhover()
        st = hover_preview(VIDEO)
        c("preview: hovering a video file plays it", st["open"] and st["tag"] == "VIDEO" and st["playing"], str(st))
        unhover()
    c("thumbs: leaving the thumbnail closes the preview", not pop_state()["open"])
    popup.hover(row_css(AUDIO) + " .thumb")
    st = poll(pop_state, lambda s: s["open"], timeout=3)
    c("preview: hovering audio shows its cover, silently", st["open"] and st["tag"] == "IMG" and not st["playing"], str(st))
    popup.click(row_css(AUDIO) + " .thumb")
    listening = poll(lambda: popup.eval_on_selector(row_css(AUDIO) + " .thumb", "t => t.classList.contains('is-playing')"),
                     lambda v: v, timeout=8)
    c("preview: clicking an audio thumbnail plays it", listening is True, str(listening))
    shot(popup, "01c-audio-playing.png")
    popup.click(row_css(AUDIO) + " .thumb")
    stopped = poll(lambda: popup.eval_on_selector(row_css(AUDIO) + " .thumb", "t => t.classList.contains('is-playing')"),
                   lambda v: v is False, timeout=4)
    c("preview: clicking again pauses it", stopped is False, str(stopped))
    unhover()
    refused = bridge_site("/__refused").get("refused", -1)
    c("previews went through the hotlink check (Referer rule)", refused == 0, f"{refused} requests refused")
    rules = sw_eval("async () => (await chrome.declarativeNetRequest.getSessionRules()).map(r => r.id)")
    c("Referer rule active while the popup is open", rules == [1], str(rules))

    # With the test page in front, a playing MSE-like <video> (no http src, no poster) is
    # captured from the tab for the HLS row. A canvas stream stands in for hls.js.
    page.evaluate("""() => {
      const cv = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
      const g = cv.getContext('2d');
      let hue = 0;
      setInterval(() => { g.fillStyle = 'hsl(' + (hue = (hue + 7) % 360) + ' 70% 50%)'; g.fillRect(0, 0, 320, 180); }, 100);
      const live = Object.assign(document.createElement('video'), { id: 'live', muted: true, autoplay: true, playsInline: true, width: 320, height: 180 });
      document.querySelector('h1').after(live);
      live.srcObject = cv.captureStream(10);
      return live.play().catch(() => {});
    }""")
    page.bring_to_front()
    open_popup(popup_url + "&nostreams=1")
    popup.wait_for_function("() => Number(document.body.dataset.previews || 0) >= 1", timeout=15000)
    pv = by_label(poll(previews, lambda v: len(v) == 4 and by_label(v)[HLS]["kind"] != "", timeout=10))
    c("thumbs: visible playing video is captured for the HLS row",
      pv[HLS]["kind"] == "capture" and pv[HLS]["src"].startswith("data:image/jpeg"), f"{pv[HLS]['kind']} {pv[HLS]['src'][:40]}")
    popup.bring_to_front()

    popup.fill("#pairInput", "abc")
    popup.click("#pairButton")
    c("popup: malformed code rejected locally", "8 caracteres" in text("#pairError"), text("#pairError"))
    popup.fill("#pairInput", "zzzz-9999")
    popup.click("#pairButton")
    popup.wait_for_function("() => document.getElementById('pairError').textContent.includes('não reconhecido')", timeout=8000)
    c("popup: wrong code reported", "não reconhecido" in text("#pairError"))
    shot(popup, "02-wrong-code.png")

    popup.fill("#pairInput", "  abcd 2345 ")
    popup.click("#pairButton")
    popup.wait_for_function("() => document.getElementById('status').dataset.state === 'paired'", timeout=8000)
    c("popup: pairing normalizes the code and connects", text("#statusText") == "Conectado ao Cachalot")
    c("popup: version shown", text("#statusMeta") == "v9.9.9", text("#statusMeta"))
    stored = local_storage()
    c("code stored normalized", stored.get("pairingCode") == CODE, str(stored.get("pairingCode")))
    c("working port remembered", stored.get("bridgePort") == BRIDGE_PORT, str(stored.get("bridgePort")))
    pings = [e for e in log() if e["path"] == "/ping"]
    c("ping carries the bearer code", pings and pings[-1]["authorization"] == f"Bearer {CODE}", str(pings[-1:]))
    shot(popup, "03-paired.png")

    # 4. Sending sniffed media rows.
    n = count("/download")
    popup.locator(row_css(HLS) + " button.btn").click()
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("HLS row: POST /download received", req is not None)
    if req:
        c("HLS row: bearer + JSON", req["authorization"] == f"Bearer {CODE}" and req["contentType"].startswith("application/json"), str(req))
        c("HLS row: sends the master playlist", body.get("urls") == [CDN + "/hls/v42/master.m3u8"], str(body.get("urls")))
        c("HLS row: mode video, quality null", body.get("mode") == "video" and body.get("quality") is None and "quality" in body, str(body))
        c("HLS row: pageUrl and title", body.get("pageUrl") == PAGE_URL and body.get("title") == PAGE_TITLE, f"{body.get('pageUrl')} / {body.get('title')}")
        h = body.get("headers", {})
        c("HLS row: replays Referer/Origin/User-Agent", h.get("Referer", "").startswith(SITE) and h.get("Origin") == SITE and h.get("User-Agent"), str(h))
        names = sorted(ck["name"] for ck in body.get("cookies", []))
        c("HLS row: cookies of the page domain only", names == ["site_session", "www_only"], str(names))
        ck_fields = sorted(body.get("cookies", [{}])[0].keys())
        c("cookies use the contract fields", set(ck_fields) <= {"domain", "path", "secure", "httpOnly", "hostOnly", "expirationDate", "name", "value"}, str(ck_fields))
    hls_button = popup.locator(row_css(HLS) + " button.btn")
    seen = set()

    def watch_button():
        t = hls_button.inner_text().strip()
        seen.add("%" if t.endswith("%") else t)
        return t

    final = poll(watch_button, lambda t: t == "✓ Baixado", timeout=10, interval=0.1)
    c("progress: the clicked row follows its download (queue → % → done)",
      final == "✓ Baixado" and "%" in seen and ("Na fila…" in seen or "✓ Na fila" in seen), f"{final} via {sorted(seen)}")
    c("progress: a downloaded item stays marked and can be sent again", not hls_button.is_disabled()
      and popup.eval_on_selector(row_css(HLS) + " button.btn", "b => b.dataset.dl") == "done")
    open_popup()
    again = poll(lambda: popup.locator(row_css(HLS) + " button.btn").inner_text().strip(), lambda t: t == "✓ Baixado", timeout=5)
    c("progress: reopening the popup still shows it downloaded", again == "✓ Baixado", again)
    folder_css = row_css(HLS) + " button.folder-btn"
    c("folder: a folder button sits left of ✓ Baixado", popup.locator(folder_css).count() == 1
      and popup.eval_on_selector(row_css(HLS) + " button.btn", "b => b.previousElementSibling?.classList.contains('folder-btn')"))
    shot(popup, "04a-progress.png")
    n = count("/open-folder")
    popup.locator(folder_css).click()
    req = wait_request("/open-folder", n)
    folder_id = str(((req or {}).get("body") or {}).get("id", ""))
    c("folder: click asks Cachalot to open the download's folder by id",
      req is not None and folder_id.startswith("dl-") and req["authorization"] == f"Bearer {CODE}", str(req))
    c("folder: no error shown after a successful open",
      not popup.eval_on_selector(folder_css, "b => b.classList.contains('is-error')"))

    n = count("/download")
    popup.locator(row_css(VIDEO) + " button.btn").click()
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("video row: sends clip.webm with mode video", body.get("urls") == [CDN + "/media/clip.webm"] and body.get("mode") == "video", str(body.get("urls")))
    c("video row: replays Referer + User-Agent", body.get("headers", {}).get("Referer", "").startswith(SITE) and body.get("headers", {}).get("User-Agent"), str(body.get("headers")))

    n = count("/download")
    popup.locator(row_css(AUDIO) + " button.btn").click()
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("audio row: mode audio", body.get("urls") == [CDN + "/media/song.mp3"] and body.get("mode") == "audio", str(body))

    # 5. Page card.
    n = count("/download")
    popup.click("#sendPage")
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("page Baixar: sends the page URL, mode null", body.get("urls") == [PAGE_URL] and body.get("mode") is None and "mode" in body, str(body))
    c("page Baixar: no replay headers for page URLs", "headers" not in body, str(body.get("headers")))
    c("page Baixar: cookies attached", len(body.get("cookies", [])) == 2, str(body.get("cookies")))
    popup.wait_for_selector("#pageFeedback:not([hidden])", timeout=5000)
    c("page Baixar: no extra message below the button (it shows the queue itself)", popup.locator("#pageFeedback").is_hidden())
    shot(popup, "04-sent.png")

    popup.click(".cookies .switch")
    time.sleep(0.3)
    c("cookie switch off stored per site", local_storage().get("cookieSiteOverrides") == {"cachalot-test.com": False}, str(local_storage().get("cookieSiteOverrides")))
    n = count("/download")
    popup.click("#sendAudio")
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("Só áudio: mode audio", body.get("mode") == "audio" and body.get("urls") == [PAGE_URL], str(body))
    c("Só áudio with switch off: no cookies", "cookies" not in body, str(body.get("cookies")))
    shot(popup, "04b-cookies-off.png")
    popup.click(".cookies .switch")
    time.sleep(0.3)
    c("cookie switch back on clears the site choice", local_storage().get("cookieSiteOverrides") == {}, str(local_storage().get("cookieSiteOverrides")))

    n = count("/cookies")
    popup.click("#syncCookies")
    req = wait_request("/cookies", n)
    body = req["body"] if req else {}
    c("Sincronizar: POST /cookies with the page domain", body.get("domain") == "cachalot-test.com" and len(body.get("cookies", [])) == 2, str(body))
    popup.wait_for_function("() => document.getElementById('cookieMeta').textContent.includes('sincronizados')", timeout=5000)
    c("Sincronizar: inline confirmation", "sincronizados" in text("#cookieMeta"), text("#cookieMeta"))

    # 5b. Transient mode: the waveform icon right of "Baixar" turns the card into its waveform.
    _transient(c, popup, open_popup, row_css, AUDIO, count, wait_request, shot)

    # 6. Context menu and keyboard shortcut (handlers invoked directly: native
    # menus cannot be clicked from automation).
    def context_click(info):
        return sw_eval(
            "async ([info, id]) => globalThis.cachalot.handleContextClick(info, await chrome.tabs.get(id))",
            [info, tab_id],
        )

    n = count("/download")
    res = context_click({"menuItemId": "cachalot-audio", "linkUrl": SITE + "/watch/123", "pageUrl": PAGE_URL})
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("context menu (link, só áudio): link URL + mode audio", res.get("ok") and body.get("urls") == [SITE + "/watch/123"] and body.get("mode") == "audio", str(body))
    c("context menu: badge shows ✓", badge(tab_id) == "✓", badge(tab_id))
    time.sleep(2.4)
    c("context menu: badge back to the count after 2 s", badge(tab_id) == "4", badge(tab_id))

    n = count("/download")
    context_click({"menuItemId": "cachalot-download", "srcUrl": CDN + "/media/clip.webm?x=1", "mediaType": "video", "pageUrl": PAGE_URL})
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("context menu (video src): sniffed headers attached", body.get("urls") == [CDN + "/media/clip.webm?x=1"] and body.get("headers", {}).get("Referer", "").startswith(SITE) and body.get("mode") == "video", str(body))

    magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=teste"
    n = count("/download")
    context_click({"menuItemId": "cachalot-download", "linkUrl": magnet, "pageUrl": PAGE_URL})
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("context menu (magnet link): magnet URL sent", body.get("urls") == [magnet], str(body.get("urls")))

    n = count("/download")
    context_click({"menuItemId": "cachalot-download", "pageUrl": PAGE_URL})
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("context menu (page): page URL, mode null, cookies", body.get("urls") == [PAGE_URL] and body.get("mode") is None and len(body.get("cookies", [])) == 2, str(body))

    n = count("/download")
    sw_eval("async (id) => globalThis.cachalot.handleCommand('send-page', await chrome.tabs.get(id))", tab_id)
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("shortcut command: sends the page", body.get("urls") == [PAGE_URL], str(body))
    commands = sw_eval("() => chrome.commands.getAll()")
    cmd = next((x for x in commands if x["name"] == "send-page"), {})
    c("shortcut registered as Alt+Shift+D", cmd.get("shortcut", "").replace(" ", "") in ("Alt+Shift+D", "Shift+Alt+D"), str(cmd))

    # 7. 401 -> pairing UI.
    bridge("/__mode", {"revoked": True})
    res = context_click({"menuItemId": "cachalot-download", "pageUrl": PAGE_URL})
    c("context menu with revoked code: error result", res.get("ok") is False and res.get("error") == "unauthorized", str(res))
    c("context menu failure: badge shows !", badge(tab_id) == "!", badge(tab_id))
    time.sleep(2.4)
    c("context menu failure: badge back to the count after 2 s", badge(tab_id) == "4", badge(tab_id))
    popup.click("#sendAudio")  # Baixar shows the page's finished download now
    popup.wait_for_function("() => document.getElementById('status').dataset.state === 'unpaired'", timeout=8000)
    c("401: popup switches to the pairing UI", popup.locator("#pairInput").is_visible())
    c("401: explains the code is no longer valid", "pareie novamente" in text("#pairError"), text("#pairError"))
    c("401: page feedback says it was not sent", text("#pageFeedback") == "Não enviado: pareie de novo acima.", text("#pageFeedback"))
    shot(popup, "05-unauthorized.png")
    bridge("/__mode", {"revoked": False})

    # 8. Options page.
    options = watch(ctx.new_page())
    options.set_viewport_size({"width": 900, "height": 1000})
    options.goto(f"chrome-extension://{ext_id}/pages/options.html")
    options.wait_for_selector("body[data-ready='1']")
    c("options: shows the stored code", options.input_value("#code") == "ABCD-2345", options.input_value("#code"))
    options.click("#test")
    options.wait_for_function("() => document.getElementById('result').textContent.includes('Conectado')", timeout=8000)
    c("options: Testar conexão reports the version and port", "v9.9.9 na porta 47821" in options.inner_text("#result"), options.inner_text("#result"))
    shot(options, "07-options.png", full=True)
    options.locator("#portAuto").uncheck()
    options.fill("#port", "47822")
    options.press("#port", "Tab")
    time.sleep(0.3)
    c("options: fixed port stored", local_storage().get("portOverride") == 47822, str(local_storage().get("portOverride")))
    options.click("#test")
    options.wait_for_function("() => document.getElementById('result').textContent.includes('fechado')", timeout=8000)
    c("options: fixed wrong port -> Cachalot fechado", "fechado" in options.inner_text("#result"), options.inner_text("#result"))
    shot(options, "07b-options-port.png", full=True)
    options.locator("#portAuto").check()
    time.sleep(0.3)
    c("options: automatic port clears the override", local_storage().get("portOverride") is None, str(local_storage().get("portOverride")))
    options.fill("#code", "wxyz-6789")
    options.click("#save")
    options.wait_for_function("() => document.getElementById('result').textContent.includes('não reconhecido')", timeout=8000)
    c("options: wrong code is not saved", local_storage().get("pairingCode") == CODE, str(local_storage().get("pairingCode")))
    options.fill("#code", CODE.lower())
    options.click("#save")
    options.wait_for_function("() => document.getElementById('result').textContent.includes('Pareado')", timeout=8000)
    c("options: valid code paired", "Pareado" in options.inner_text("#result"), options.inner_text("#result"))

    # 9. Service-worker restart keeps the sniffed list (chrome.storage.session).
    # The worker is stopped from chrome://serviceworker-internals; a marker set
    # in the old instance proves that a fresh instance answered afterwards.
    # A ✓ / ! badge shown right before the stop must not stay stuck.
    try:
        internals = ctx.new_page()
        internals.goto("chrome://serviceworker-internals/")
        reg = internals.locator(f".serviceworker-registration:has-text('{ext_id}')")
        stop_button = reg.locator("cr-button[data-command=stop]").first
        stop_button.wait_for()
        sw_eval("() => { globalThis.__e2eMarker = 1; }")
        bridge("/__mode", {"revoked": True})
        context_click({"menuItemId": "cachalot-download", "pageUrl": PAGE_URL})
        bridge("/__mode", {"revoked": False})
        c("badge shows ! right before the worker stops", badge(tab_id) == "!", badge(tab_id))
        stop_button.click()  # well inside the 2 s feedback window
        running = reg.locator(".serviceworker-running-status .value").first
        stopped = poll(lambda: running.inner_text().strip(), lambda v: v == "STOPPED", timeout=6)
        c("service worker stopped", stopped == "STOPPED", stopped)
        # Read the badge from an extension page: asking the worker would wake it.
        def badge_raw(tid):
            return options.evaluate("(id) => chrome.action.getBadgeText({ tabId: id })", tid)

        time.sleep(2.2)
        c("the stopped worker left the ! badge behind", badge_raw(tab_id) == "!", str(badge_raw(tab_id)))
        open_popup()
        c("after a worker restart the media list survives", popup.locator(".media-row").count() == 4, str(popup.locator(".media-row").count()))
        c("after a worker restart the bridge is still paired", status_state() == "paired", status_state())
        c("a fresh worker instance answered", sw_eval("() => globalThis.__e2eMarker ?? null") is None)
        c("a feedback badge interrupted by the stop is repaired by the next worker", poll(lambda: badge(tab_id), lambda v: v == "4") == "4", badge(tab_id))
        internals.close()
    except Exception as exc:  # noqa: BLE001
        checks.skip("service worker restart", f"could not stop the worker: {exc}")

    # 9b. Music pages: what is playing gets its title/artist/cover, the page's other tracks are
    #     listed as they load, and sound plays in the row's player (play ⇄ stop, seekable line).
    if real_media:
        _music(c, ctx, popup, open_popup, ext_id, tab_id_for, items, watch, shot, poll, count, wait_request, pop_state, unhover)

    # 10. Bridge down -> "Cachalot fechado".
    received = log()
    (work / "bridge-requests.json").write_text(json.dumps(received, indent=2, ensure_ascii=False), encoding="utf-8")
    origins = sorted({e["origin"] for e in received})
    c("bridge calls never carry a web-page Origin (the real bridge answers 403)", all(not o.startswith("http") for o in origins), str(origins))
    mock.terminate()
    mock.wait(5)
    open_popup()
    c("closed: status line", text("#statusText") == "Cachalot fechado — abra o SwissTechKnife", text("#statusText"))
    c("closed: retry button", popup.locator("#retry").is_visible())
    popup.click("#sendAudio")
    popup.wait_for_selector("#pageFeedback:not([hidden])", timeout=8000)
    c("closed: sending reports the app is closed", text("#pageFeedback") == "Não enviado: o Cachalot está fechado.", text("#pageFeedback"))
    shot(popup, "06-closed.png")

    # 11. Unsupported page (an extension page).
    # Without the "tabs" permission extension-page URLs are hidden, so ask the
    # options page for its own tab id.
    options_tab = options.evaluate("async () => (await chrome.tabs.getCurrent()).id")
    c("options tab id resolved", isinstance(options_tab, int), str(options_tab))
    open_popup(f"chrome-extension://{ext_id}/popup/popup.html?tab={options_tab}")
    c("unsupported page: explained", "não pode ser enviada" in text("#pageTitle"), text("#pageTitle"))
    c("unsupported page: buttons disabled", popup.locator("#sendPage").is_disabled() and popup.locator("#sendAudio").is_disabled())
    c("unsupported page: nothing-to-download text", text("#mediaEmpty") == "Nada para baixar nesta página.", text("#mediaEmpty"))
    c("unsupported page: cookie switch disabled", popup.locator("#cookieSwitch").is_disabled())
    shot(popup, "09-unsupported.png")

    # 12. YouTube: the page's own video is previewed in the page card (never listed);
    #     the list shows the other videos the page displays with a thumbnail.
    if cert:
        yt = watch(ctx.new_page())
        yt.goto(f"https://www.youtube.com:{HTTPS_PORT}/watch?v=e2eTestVid1")
        yt.wait_for_function("() => window.__done === true", timeout=15000)
        time.sleep(1.5)
        yt_tab = tab_id_for(f"https://www.youtube.com:{HTTPS_PORT}/")
        c("YouTube: nothing sniffed", items(yt_tab) == [], str(items(yt_tab)))
        c("YouTube: icon active (known platform)", poll(lambda: icon_state(yt_tab), lambda v: v == "active") == "active", str(icon_state(yt_tab)))
        c("YouTube: no badge", badge(yt_tab) == "", badge(yt_tab))
        popup.bring_to_front()  # the YouTube tab in the background: no capture, the page picture is used
        open_popup(f"chrome-extension://{ext_id}/popup/popup.html?tab={yt_tab}")
        c("YouTube: popup tags the platform", text("#pagePlatform") == "YouTube", text("#pagePlatform"))

        def yt_rows():
            return popup.eval_on_selector_all(
                ".media-row",
                "rs => rs.map(r => [r.querySelector('.chip').textContent, r.querySelector('.media-name').textContent,"
                " (r.querySelector('.duration') || {}).textContent || ''])",
            )

        got_rows = poll(yt_rows, lambda v: len(v) >= 3, timeout=12)
        c("YouTube: the list shows the other videos with thumbnails, newest (lowest on the page) first",
          got_rows == [["Shorts", "Um short", ""], ["YouTube", "Outro vídeo dois", "12:05"], ["YouTube", "Outro vídeo um", "3:21"]],
          str(got_rows))
        names = [r[1] for r in got_rows]
        c("YouTube: the page's own video is not listed (no duplicate)", "Este mesmo vídeo" not in names, str(names))
        c("YouTube: plain text links are not videos", "link de texto" not in names, str(names))
        c("YouTube: list thumbnails load (YouTube's picture, else the page's)",
          poll(lambda: popup.eval_on_selector_all(".media-row .thumb.has-media", "ts => ts.length"), lambda v: v == 3, timeout=10) == 3)
        main = popup.locator(".page-head .page-thumb.has-media")
        c("YouTube: the page card previews the page's video", poll(lambda: main.count(), lambda v: v == 1, timeout=10) == 1)
        c("YouTube: the favicon gives way to the preview", not popup.locator(".page-head .favicon").is_visible())
        main_dur = popup.locator(".page-head .page-thumb .duration")
        c("YouTube: the page card shows the video duration", main_dur.count() == 1 and main_dur.inner_text() == "0:04",
          main_dur.inner_text() if main_dur.count() else "none")
        popup.hover(".page-head .page-thumb")
        st = poll(pop_state, lambda s: s["open"], timeout=3)
        c("YouTube: hovering the page card opens the larger preview", st["open"] and st["tag"] == "IMG", str(st))
        unhover()
        shot(popup, "08-youtube.png")
        yt.evaluate("() => window.__more()")  # the page loads more cards (scrolling)
        grown = poll(yt_rows, lambda v: len(v) == 4, timeout=8)
        c("YouTube: videos that load while the popup is open join the list, on top",
          len(grown) == 4 and grown[0] == ["YouTube", "Vídeo que apareceu ao rolar", "0:45"], str(grown[:1]))
        popup.click(".media-row:nth-child(1) button")
        err = popup.locator(".media-row:nth-child(1) .media-error")
        poll(lambda: err.count(), lambda v: v == 1, timeout=8)
        c("YouTube: a listed video goes out through the bridge (closed here)",
          err.count() == 1 and "fechado" in err.inner_text(), err.inner_text() if err.count() else "no message")
        shot(popup, "08b-youtube-more.png")
    else:
        checks.skip("YouTube look-alike", "python package `cryptography` missing")

    # 13. Navigation clears the list, badge and active icon.
    page.goto(SITE + "/empty")
    cleared = poll(lambda: items(tab_id), lambda v: v == [], timeout=6)
    c("navigation clears the tab's media list", cleared == [], str(cleared))
    c("navigation clears the badge", poll(lambda: badge(tab_id), lambda v: v == "") == "", badge(tab_id))
    c("plain page without media: icon inactive", poll(lambda: icon_state(tab_id), lambda v: v == "inactive") == "inactive", str(icon_state(tab_id)))

    # 14. Closing the tab drops its stored list.
    page.goto(PAGE_URL)
    page.wait_for_function("() => window.__done === true", timeout=15000)
    poll(lambda: items(tab_id), lambda v: len(v) > 0, timeout=8)
    page.close()
    gone = poll(lambda: sw_eval("async (id) => Object.keys(await chrome.storage.session.get('media:' + id)).length", tab_id), lambda v: v == 0, timeout=5)
    c("closing the tab removes its stored list", gone == 0, str(gone))

    # 15. Long sessions (an infinite feed): the per-tab list stays capped and small.
    flood = watch(ctx.new_page())
    flood.goto(SITE + "/flood?n=200")
    flood.wait_for_function("() => window.__done === true", timeout=60000)
    flood_tab = tab_id_for(SITE + "/flood")
    t0 = time.time()
    got = poll(lambda: items(flood_tab), lambda v: len(v) == 50 and any(e["url"].endswith("/199.mp4") for e in v), timeout=20)
    settle = time.time() - t0
    kept = sorted(int(e["url"].rsplit("/", 1)[1].split(".")[0]) for e in got)
    c("200 media on one page: the list keeps only the newest 50", len(got) == 50 and kept[0] >= 150 and kept[-1] == 199, f"{len(got)} items, {kept[:1]}..{kept[-1:]}")
    used = sw_eval("async (id) => chrome.storage.session.getBytesInUse('media:' + id)", flood_tab)
    c("the capped list stays small in storage", used < 120_000, f"{used} bytes")
    c("badge shows the capped count", poll(lambda: badge(flood_tab), lambda v: v == "50") == "50", badge(flood_tab))
    print(f"  flood: 200 media, list settled {settle:.1f}s after the page finished, {used} bytes stored")
    flood.close()

    relevant = [e for e in page_errors if "favicon" not in e and "ERR_CONNECTION_REFUSED" not in e]
    c("no errors in extension pages", not relevant, "; ".join(relevant[:5]))


def _transient(c, popup, open_popup, row_css, AUDIO, count, wait_request, shot):
    popup.set_viewport_size({"width": 600, "height": 760})
    row = row_css(AUDIO)
    c("transient: a waveform button right of Baixar on each row",
      popup.locator(".media-row .transient-open").count() == popup.locator(".media-row").count()
      and popup.eval_on_selector(row + " .transient-open", "b => b.previousElementSibling?.classList.contains('btn')"))
    n = count("/transient/prepare")
    popup.locator(row + " .transient-open").click()
    req = wait_request("/transient/prepare", n)
    body = (req or {}).get("body") or {}
    c("transient: prepare asks Cachalot for the row's media with its headers",
      body.get("url") == CDN + "/media/song.mp3" and body.get("headers", {}).get("Referer", "").startswith(SITE), str(body))
    c("transient: prepare carries the site's cookies", len(body.get("cookies", [])) == 2, str(body.get("cookies")))
    c("transient: the card turns into the view and the popup widens", popup.evaluate(
        "() => document.body.classList.contains('has-transient') && document.body.offsetWidth >= 590"
        " && !!document.querySelector('.media-row.is-transient .transient')"))
    overlay = popup.locator(".tr-overlay-text").inner_text()
    c("transient: shows the audio being prepared", any(w in overlay for w in ("Preparando", "Baixando", "Carregando", "Detectando")), overlay)
    popup.wait_for_selector(".transient.is-ready", timeout=20000)
    view = ".transient"

    def ds(key):
        return popup.eval_on_selector(view, f"n => n.dataset.{key}")

    def dividers_now():
        return json.loads(ds("dividers"))

    c("transient: title from Cachalot at the top left", popup.locator(".tr-title").inner_text() == "Loop de teste",
      popup.locator(".tr-title").inner_text())
    info = popup.locator(".tr-info").inner_text()
    c("transient: tempo detected (120 BPM)", any(f"{b} BPM" in info for b in (119, 120, 121)), info)
    shot(popup, "05a-transient.png")

    def set_sens(value):
        popup.eval_on_selector(".tr-sens input", "(i, v) => { i.value = String(v); i.dispatchEvent(new Event('input')); }", value)
        popup.wait_for_timeout(150)
        return int(ds("sections"))

    def pick_grid(label):
        popup.locator(f".tr-grid-btn:text-is('{label}')").click()
        return int(ds("sections"))

    bars = pick_grid("1:1")
    beats = pick_grid("1:4")
    set_sens(95)  # the hats on the eighths are faint: only a sensitive detection sees them
    eighths = pick_grid("1:8")
    grid32 = pick_grid("1:32")
    grid64 = pick_grid("1:64")
    set_sens(50)
    c("transient: 1:32 and 1:64 are offered and cut at least as finely as 1:8",
      grid64 >= grid32 >= eighths and popup.locator(".tr-grid-btn").all_inner_texts()
      == ["1:1", "1:2", "1:4", "1:8", "1:16", "1:32", "1:64", "Auto", "2:1", "4:1", "8:1", "16:1", "32:1"],
      f"{eighths} {grid32} {grid64}")
    c("transient: 2:1 … 32:1 sit in a row below the others",
      popup.locator(".tr-grids > .tr-grid-bars .tr-grid-btn").all_inner_texts() == ["2:1", "4:1", "8:1", "16:1", "32:1"])
    # 8 bars from 0.37 s: 4:1 cuts at 0.37 (after the intro), 8.37 and 16.37 (the tail) -> 4 sections
    four = pick_grid("4:1")
    c("transient: 4:1 makes sections of four bars", four == 4, str(four))
    auto = pick_grid("Auto")
    auto_cuts = dividers_now()[1:-1]
    bar_starts = [0.37 + 2 * k for k in range(8)]
    c("transient: Auto marks the bars first (every bar starts a section)",
      all(any(abs(t - b) < 0.01 for t in auto_cuts) for b in bar_starts), str(auto_cuts[:12]))
    # the loop: 0.37 s of quiet, 8 bars at 120 BPM (2 s each), 1 s of tail -> the grid fills all of it
    c("transient: 1:1 makes one section per bar (plus intro and tail)", bars == 10, str(bars))
    c("transient: 1:4 makes one section per beat", beats == 35, str(beats))
    c("transient: finer grids give more sections", eighths > beats > bars, f"{bars} {beats} {eighths}")
    c("transient: the chosen grid is pressed", popup.get_attribute(".tr-grid-btn:text-is('Auto')", "aria-pressed") == "true")

    pick_grid("Auto")
    low, mid, high = set_sens(5), set_sens(50), set_sens(100)
    c("transient: sensitivity changes the cuts live (weak transients only when sensitive)", low < high and low <= mid <= high,
      f"{low} {mid} {high}")
    pick_grid("1:4")
    set_sens(50)

    canvas = popup.locator(".tr-canvas")
    box = canvas.bounding_box()
    duration = float(ds("duration"))
    y = box["y"] + box["height"] / 2

    def x_of(t):
        return box["x"] + t / duration * box["width"]

    dividers = dividers_now()
    # hover the 3rd section: download and disable buttons appear on it
    mid_t = (dividers[2] + dividers[3]) / 2
    popup.mouse.move(x_of(mid_t), y)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    c("transient: hovering a section shows download, split, double, reset and disable", popup.locator(".tr-tools .tr-tool").count() == 5)
    shot(popup, "05b-transient-hover.png")
    # no format remembered: downloading asks MP3 / WAV / FLAC, with "Lembrar escolha"; Esc gives up
    n = count("/transient/export")
    popup.locator(".tr-tools .tr-tool").first.click()
    popup.wait_for_selector(".tr-format", timeout=3000)
    c("transient: download asks the format (MP3, WAV, FLAC) with a remember checkbox",
      popup.locator(".tr-format-btn").all_inner_texts() == ["MP3", "WAV", "FLAC"]
      and "Lembrar escolha" in popup.locator(".tr-format-remember").inner_text(), popup.locator(".tr-format").inner_text())
    shot(popup, "05b2-transient-format.png")
    popup.keyboard.press("Escape")
    popup.wait_for_timeout(300)
    c("transient: Esc closes the format popup without saving", popup.locator(".tr-format").count() == 0
      and count("/transient/export") == n)
    popup.mouse.move(x_of(mid_t), y + 2)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    popup.locator(".tr-tools .tr-tool").first.click()
    popup.wait_for_selector(".tr-format", timeout=3000)
    popup.locator(".tr-format-remember input").check()
    popup.locator(".tr-format-btn:text-is('FLAC')").click()
    req = wait_request("/transient/export", n)
    eb = (req or {}).get("body") or {}
    seg = (eb.get("segments") or [{}])[0]
    c("transient: download of one section sends just it, numbered by position",
      eb.get("folder") is False and len(eb.get("segments") or []) == 1 and seg.get("number") == 3
      and abs(seg.get("start", 0) - dividers[2]) < 1e-3 and abs(seg.get("end", 0) - dividers[3]) < 1e-3, str(eb))
    c("transient: the chosen format goes with it, remembered when ticked",
      eb.get("format") == "flac" and eb.get("remember") is True, str({k: eb.get(k) for k in ("format", "remember")}))
    popup.wait_for_selector(".tr-foot-text.is-ok", timeout=5000)
    c("transient: confirms the saved file", "Salvo" in popup.locator(".tr-foot-text").inner_text(), popup.locator(".tr-foot-text").inner_text())

    total = int(ds("sections"))
    popup.mouse.move(x_of(mid_t), y + 3)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    popup.locator(".tr-tools .tr-toggle").click()
    c("transient: disabling a section leaves it out", int(ds("active")) == total - 1, f"{ds('active')} / {total}")
    c("transient: Baixar todos counts the active ones", popup.locator(".tr-all").inner_text().strip() == f"Baixar {total - 1}",
      popup.locator(".tr-all").inner_text())
    n = count("/transient/export")
    popup.locator(".tr-all").click()
    req = wait_request("/transient/export", n)
    eb = (req or {}).get("body") or {}
    segs = eb.get("segments") or []
    c("transient: Baixar todos sends every active section to one folder, numbered 1…N",
      eb.get("folder") is True and len(segs) == total - 1 and [s.get("number") for s in segs] == list(range(1, total))
      and all(abs(s["start"] - dividers[2]) > 1e-3 for s in segs), f"{len(segs)} segments")
    c("transient: a remembered format is used without asking again",
      eb.get("format") == "flac" and not eb.get("remember") and popup.locator(".tr-format").count() == 0, str(eb.get("format")))
    popup.wait_for_selector(".tr-foot-folder:not([hidden])", timeout=5000)
    n = count("/transient/open")
    popup.locator(".tr-foot-folder").click()
    c("transient: the folder button asks Cachalot to open it", wait_request("/transient/open", n) is not None)

    # the "music starts here" flag in the ruler: dragging it moves bar 1, the grid follows and the intro is one section
    origin0 = float(ds("origin"))
    c("transient: the start flag sits on the detected start (0.37 s)", abs(origin0 - 0.37) < 0.01, str(origin0))
    yf = box["y"] + box["height"] - 6
    xf = x_of(origin0) + 6
    popup.mouse.move(xf, yf)
    popup.keyboard.down("Alt")
    popup.mouse.down()
    popup.mouse.move(xf + 15, yf, steps=2)
    popup.mouse.move(xf + 30, yf, steps=2)
    popup.mouse.up()
    popup.keyboard.up("Alt")
    origin1 = float(ds("origin"))
    marked = dividers_now()
    beat_s = 0.5
    c("transient: dragging the flag moves the start", abs(origin1 - (origin0 + 30 / box["width"] * duration)) < 0.02,
      f"{origin0:.3f} -> {origin1:.3f}")
    c("transient: the sections start on the flag (one intro section before it, 1:4 counted from it)",
      abs(marked[1] - origin1) < 1e-3 and abs(marked[2] - origin1 - beat_s) < 0.1, str(marked[:4]))
    shot(popup, "05b3-transient-start.png")
    popup.mouse.dblclick(x_of(origin1) + 6, yf)
    popup.wait_for_timeout(300)
    c("transient: a double click on the flag goes back to the detected start",
      abs(float(ds("origin")) - origin0) < 1e-3 and dividers_now() == dividers, ds("origin"))

    # drag the 5th divider 10 px to the right (Alt: no snapping; the next one is a beat, ~16 px, away)
    # (grabbed above the middle: the middle of a divider holds its merge button)
    d_index = 4
    x0 = x_of(dividers[d_index])
    yd = box["y"] + 40
    popup.mouse.move(x0, yd)
    popup.keyboard.down("Alt")
    popup.mouse.down()
    popup.mouse.move(x0 + 5, yd, steps=2)
    popup.mouse.move(x0 + 10, yd, steps=2)
    popup.mouse.up()
    popup.keyboard.up("Alt")
    moved = dividers_now()
    expected = dividers[d_index] + 10 / box["width"] * duration
    c("transient: a divider drags to where the mouse leaves it", abs(moved[d_index] - expected) < 0.05,
      f"{dividers[d_index]:.3f} -> {moved[d_index]:.3f} (expected {expected:.3f})")
    before = len(moved)
    gap_t = (moved[6] + moved[7]) / 2
    popup.keyboard.down("Alt")
    popup.mouse.dblclick(x_of(gap_t), yd)
    popup.keyboard.up("Alt")
    c("transient: a double click adds a divider", len(dividers_now()) == before + 1, str(len(dividers_now())))
    popup.mouse.dblclick(x_of(gap_t), yd)
    c("transient: a double click on a divider removes it", len(dividers_now()) == before, str(len(dividers_now())))

    # reset: the dragged section goes back to its detected size; Ctrl+Z / Ctrl+Shift+Z walk the edits
    # section 4 (its end is the dragged divider; section 5 is only ~6 px wide now)
    popup.mouse.move(x_of((moved[d_index - 1] + moved[d_index]) / 2), y)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    reset_btn = popup.locator(".tr-tools .tr-reset")
    c("transient: hover shows reset between download and disable",
      popup.eval_on_selector(".tr-tools", "t => [...t.children].map(b => b.classList.contains('tr-reset')).join()") == "false,false,false,true,false"
      and reset_btn.is_enabled())
    reset_btn.click()
    c("transient: reset puts the section back at its original size",
      abs(dividers_now()[d_index] - dividers[d_index]) < 1e-3, f"{dividers_now()[d_index]} vs {dividers[d_index]}")
    popup.keyboard.press("Control+z")
    c("transient: Ctrl+Z undoes the reset", abs(dividers_now()[d_index] - moved[d_index]) < 1e-3, str(dividers_now()[d_index]))
    popup.keyboard.press("Control+Shift+z")
    c("transient: Ctrl+Shift+Z redoes it", abs(dividers_now()[d_index] - dividers[d_index]) < 1e-3, str(dividers_now()[d_index]))
    popup.keyboard.press("Control+z")
    popup.keyboard.press("Control+z")
    c("transient: Ctrl+Z goes further back (the double-click edits)", len(dividers_now()) == before + 1, str(len(dividers_now())))
    popup.keyboard.press("Control+Shift+z")
    popup.keyboard.press("Control+Shift+z")
    c("transient: …and redo comes back to the latest state", abs(dividers_now()[d_index] - dividers[d_index]) < 1e-3
      and len(dividers_now()) == before)
    popup.keyboard.press("Control+z")  # keep the drag for the reopen check below
    moved = dividers_now()

    # ÷2 and ×2 in the hover buttons (on bars: wide enough to hover each half)
    pick_grid("1:1")
    bars_div = dividers_now()
    sections_before = int(ds("sections"))
    s_a, s_b = bars_div[3], bars_div[4]
    popup.mouse.move(x_of((s_a + s_b) / 2 - 0.3), y + 20)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    popup.locator(".tr-tools .tr-split").click()
    halves = dividers_now()
    c("transient: split cuts the section in two equal halves", int(ds("sections")) == sections_before + 1
      and any(abs(t - (s_a + s_b) / 2) < 1e-3 for t in halves), str(len(halves)))
    popup.mouse.move(x_of(s_a + (s_b - s_a) / 4), y + 20)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    popup.locator(".tr-tools .tr-double").click()
    c("transient: x2 doubles it back", int(ds("sections")) == sections_before
      and not any(abs(t - (s_a + s_b) / 2) < 1e-3 for t in dividers_now()), ds("sections"))
    popup.mouse.move(x_of((s_a + s_b) / 2), y + 20)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    popup.locator(".tr-tools .tr-double").click()
    doubled = dividers_now()
    c("transient: x2 on a bar makes it two bars long", any(abs(t - (s_a + 2 * (s_b - s_a))) < 0.02 for t in doubled)
      and not any(abs(t - s_b) < 1e-3 for t in doubled), str([round(t, 2) for t in doubled[:8]]))
    for _ in range(3):
        popup.keyboard.press("Control+z")
    pick_grid("1:4")
    c("transient: Ctrl+Z undoes them all", dividers_now() == moved, ds("sections"))

    # merge: near a divider a button appears on its middle; it joins the two sections
    sections_before = int(ds("sections"))
    xm = x_of(moved[20])
    popup.mouse.move(xm + 2, y)
    popup.wait_for_selector(".tr-merge:not([hidden])", timeout=3000)
    box_m = popup.locator(".tr-merge").bounding_box()
    c("transient: the merge button sits centered on the divider",
      abs(box_m["x"] + box_m["width"] / 2 - xm) < 1.5 and abs(box_m["y"] + box_m["height"] / 2 - (box["y"] + 16 + (box["height"] - 31) / 2)) < 1.5,
      str(box_m))
    shot(popup, "05g-transient-merge.png")
    popup.locator(".tr-merge").click()
    after_merge = dividers_now()
    c("transient: merge joins the two sections", int(ds("sections")) == sections_before - 1
      and all(abs(t - moved[20]) > 1e-3 for t in after_merge), ds("sections"))
    popup.mouse.move(x_of((moved[18] + moved[19]) / 2), y)
    c("transient: the merge button stays hidden away from dividers", popup.locator(".tr-merge").is_hidden())
    popup.keyboard.press("Control+z")
    c("transient: Ctrl+Z splits them again", int(ds("sections")) == sections_before, ds("sections"))

    # drag across sections 9-12 to select them; the hover buttons then act on all of them
    active_before = int(ds("active"))
    popup.mouse.move(x_of((moved[8] + moved[9]) / 2), y)
    popup.mouse.down()
    popup.mouse.move(x_of((moved[10] + moved[11]) / 2), y, steps=4)
    popup.mouse.move(x_of((moved[11] + moved[12]) / 2), y, steps=4)
    popup.mouse.up()
    c("transient: dragging selects the sections it crosses", ds("selected") == "4", ds("selected"))
    popup.mouse.move(x_of((moved[9] + moved[10]) / 2), y + 2)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    shot(popup, "05d-transient-selection.png")
    n = count("/transient/export")
    popup.locator(".tr-tools .tr-tool").first.click()
    req = wait_request("/transient/export", n)
    eb = (req or {}).get("body") or {}
    segs = eb.get("segments") or []
    c("transient: download on a selection saves each section as its own file",
      eb.get("folder") is False and [s.get("number") for s in segs] == [9, 10, 11, 12]
      and all(abs(s["start"] - moved[s["number"] - 1]) < 1e-3 and abs(s["end"] - moved[s["number"]]) < 1e-3 for s in segs), str(eb))
    popup.wait_for_selector(".tr-foot-text.is-ok", timeout=5000)
    c("transient: confirms the files", "4 arquivos" in popup.locator(".tr-foot-text").inner_text(), popup.locator(".tr-foot-text").inner_text())
    popup.mouse.move(x_of((moved[9] + moved[10]) / 2), y)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    popup.locator(".tr-tools .tr-toggle").click()
    c("transient: disable on a selection disables all of it", int(ds("active")) == active_before - 4, f"{ds('active')} vs {active_before}")
    popup.keyboard.press("Control+z")
    c("transient: …and Ctrl+Z brings them back", int(ds("active")) == active_before, ds("active"))
    popup.mouse.click(x_of((moved[14] + moved[15]) / 2), y)
    c("transient: a plain click clears the selection", ds("selected") == "0", ds("selected"))

    # Loop: the clicked section keeps playing round; off, it stops at its end
    popup.wait_for_timeout(300)
    if ds("playing"):
        popup.mouse.click(x_of((moved[14] + moved[15]) / 2), y)  # the click above started it: stop
        popup.wait_for_timeout(400)
    c("transient: Loop checkbox next to the other controls", popup.locator(".tr-controls .tr-loop input[type=checkbox]").count() == 1)
    popup.locator(".tr-loop").click()
    popup.mouse.click(x_of((moved[14] + moved[15]) / 2), y)
    popup.wait_for_timeout(400)
    section_len = moved[15] - moved[14]
    popup.wait_for_timeout(int(section_len * 3000))
    c("transient: with Loop on the section keeps playing past its end", ds("playing") == "loop", str(ds("playing")))
    # resizing the looping section: the loop takes the new end at once (the end divider dragged 5 px left)
    xe = x_of(moved[15])
    popup.mouse.move(xe, yd)
    popup.keyboard.down("Alt")
    popup.mouse.down()
    popup.mouse.move(xe - 3, yd, steps=2)
    popup.mouse.move(xe - 5, yd, steps=2)
    popup.mouse.up()
    popup.keyboard.up("Alt")
    new_end = dividers_now()[15]
    pr = [float(x) for x in (ds("playRange") or "0,0").split(",")]
    c("transient: the loop follows the section's new size exactly",
      ds("playing") == "loop" and abs(pr[0] - moved[14]) < 1e-3 and abs(pr[1] - new_end) < 1e-3 and new_end < moved[15] - 0.05,
      f"{pr} vs {moved[14]:.4f}-{new_end:.4f}")
    popup.keyboard.press("Control+z")
    pr = [float(x) for x in (ds("playRange") or "0,0").split(",")]
    c("transient: and Ctrl+Z gives the loop its old end back", abs(pr[1] - moved[15]) < 1e-3, str(pr))
    popup.locator(".tr-loop").click()
    popup.wait_for_timeout(int(section_len * 1000) + 500)
    c("transient: turning Loop off lets it end", not ds("playing"), str(ds("playing")))
    # the play / pause button, left of the title
    c("transient: play button left of the title", popup.eval_on_selector(".tr-head", "h => h.firstElementChild.classList.contains('tr-play')"))
    popup.locator(".tr-play").click()
    popup.wait_for_timeout(500)
    c("transient: play plays the song and turns into pause", ds("playing") == "once" and ds("playRange").startswith("0,")
      and "Pausar" in popup.get_attribute(".tr-play", "title"), f"{ds('playing')} {ds('playRange')}")
    popup.locator(".tr-play").click()
    paused_at = float(ds("paused") or 0)
    c("transient: pause stops and keeps the place", not ds("playing") and paused_at > 0.3
      and "Continuar" in popup.get_attribute(".tr-play", "title"), f"{ds('playing')} at {paused_at}")
    popup.wait_for_timeout(300)
    popup.locator(".tr-play").click()
    popup.wait_for_timeout(200)
    c("transient: play again goes on from there", ds("playing") == "once" and not ds("paused"), f"{ds('playing')} {ds('paused')}")
    popup.locator(".tr-play").click()

    c("transient: Loop is remembered", popup.evaluate(
        "async () => (await chrome.storage.local.get('transientSettings')).transientSettings.loop") is False)
    popup.mouse.move(x_of(duration / 2), y)
    popup.mouse.wheel(0, -400)
    popup.wait_for_timeout(150)
    c("transient: the scroll wheel zooms the waveform", popup.eval_on_selector(view, "n => n.classList.contains('is-zoomed')"))
    shot(popup, "05c-transient-zoomed.png")

    # fades: on the hovered section, the ■ at the top edge sets the length, the ● on the curve its shape
    vs, ve = (float(x) for x in ds("view").split(","))

    def xz(t):
        return box["x"] + (t - vs) / (ve - vs) * box["width"]

    top = box["y"] + 16  # LANE_TOP
    bottom = box["y"] + box["height"] - 15  # LANE_BOTTOM
    inside = [k for k in range(len(moved) - 1) if moved[k] > vs + 0.3 and moved[k + 1] < ve - 0.3 and moved[k + 1] - moved[k] > 0.4]
    k = inside[len(inside) // 2]
    s0, s1 = moved[k], moved[k + 1]
    popup.mouse.move((xz(s0) + xz(s1)) / 2, y)
    popup.wait_for_timeout(100)
    shot(popup, "05e-transient-fade-handles.png")
    popup.mouse.move(xz(s0) + 5, top + 6)
    popup.mouse.down()
    popup.mouse.move(xz(s0) + 15, top + 6, steps=3)
    popup.mouse.move(xz(s0) + 26, top + 6, steps=3)
    popup.mouse.up()
    fades = json.loads(ds("fades"))
    fade = next(iter(fades.values()), {})
    expected_len = 21 / box["width"] * (ve - vs)
    c("transient: dragging the square handle at a section's start sets its fade-in length",
      len(fades) == 1 and abs(fade.get("in", 0) - expected_len) < 0.02 and fade.get("inCurve") == 0, f"{fades} vs {expected_len:.3f}")
    waveH = bottom - top
    curve_x = xz(s0 + fade.get("in", 0) / 2)
    popup.mouse.move(curve_x, bottom - 0.5 * waveH)
    popup.mouse.down()
    popup.mouse.move(curve_x, bottom - 0.5 * waveH - 15, steps=3)
    popup.mouse.move(curve_x, bottom - 0.5 * waveH - 30, steps=3)
    popup.mouse.up()
    fade = next(iter(json.loads(ds("fades")).values()), {})
    c("transient: dragging the curve dot up makes the curve more aggressive", abs(fade.get("inCurve", 0) - 0.5) < 0.05, str(fade))
    popup.mouse.move(xz(s1) - 5, top + 6)
    popup.mouse.down()
    popup.mouse.move(xz(s1) - 20, top + 6, steps=4)
    popup.mouse.up()
    fade = next(iter(json.loads(ds("fades")).values()), {})
    c("transient: the square handle at the end sets the fade-out", fade.get("out", 0) > 0.1, str(fade))
    shot(popup, "05f-transient-fades.png")
    popup.mouse.move((xz(s0) + xz(s1)) / 2, bottom - 20)
    popup.wait_for_selector(".tr-tools:not([hidden])", timeout=3000)
    n = count("/transient/export")
    popup.locator(".tr-tools .tr-tool").first.click()
    req = wait_request("/transient/export", n)
    seg = (((req or {}).get("body") or {}).get("segments") or [{}])[0]
    c("transient: the download carries the section's fades",
      abs(seg.get("fadeIn", 0) - fade["in"]) < 1e-6 and abs(seg.get("fadeInCurve", 0) - fade["inCurve"]) < 1e-6
      and abs(seg.get("fadeOut", 0) - fade["out"]) < 1e-6, str(seg))
    popup.keyboard.press("Control+z")
    fade = next(iter(json.loads(ds("fades")).values()), {})
    c("transient: Ctrl+Z undoes a fade change", fade.get("out", 1) == 0 and fade.get("in", 0) > 0, str(fade))
    popup.mouse.dblclick(xz(s0 + fade["in"]), top + 6)
    c("transient: double click on the square handle removes the fade", json.loads(ds("fades")) == {}, ds("fades"))
    popup.keyboard.press("Control+z")
    c("transient: …and Ctrl+Z brings it back", len(json.loads(ds("fades"))) == 1, ds("fades"))

    # the right button drags the waveform sideways
    popup.mouse.move(box["x"] + box["width"] / 2, y)
    popup.mouse.down(button="right")
    popup.mouse.move(box["x"] + box["width"] / 2 - 60, y, steps=4)
    popup.mouse.move(box["x"] + box["width"] / 2 - 120, y, steps=4)
    popup.mouse.up(button="right")
    vs2, ve2 = (float(x) for x in ds("view").split(","))
    c("transient: dragging with the right button moves the view", vs2 > vs + 0.5 and abs((ve2 - vs2) - (ve - vs)) < 1e-6,
      f"{vs:.2f}-{ve:.2f} -> {vs2:.2f}-{ve2:.2f}")
    kept_fades = ds("fades")

    # the overview: the whole song below, a quarter of the height; its window shows and moves the view
    ov = popup.locator(".tr-overview-canvas").bounding_box()
    c("transient: overview waveform below, a quarter of the height", ov is not None and abs(ov["height"] - box["height"] / 4) <= 1.5
      and ov["y"] > box["y"] + box["height"] - 1, str(ov))
    vs, ve = (float(x) for x in ds("view").split(","))
    oxs = lambda t: ov["x"] + t / duration * ov["width"]  # noqa: E731
    mid_win = (oxs(vs) + oxs(ve)) / 2
    popup.mouse.move(mid_win, ov["y"] + ov["height"] / 2)
    popup.mouse.down()
    popup.mouse.move(mid_win + 20, ov["y"] + ov["height"] / 2, steps=3)
    popup.mouse.move(mid_win + 40, ov["y"] + ov["height"] / 2, steps=3)
    popup.mouse.up()
    vs2, ve2 = (float(x) for x in ds("view").split(","))
    moved_by = 40 / ov["width"] * duration
    c("transient: dragging the overview window moves the view", abs((vs2 - vs) - moved_by) < 0.05 and abs((ve2 - vs2) - (ve - vs)) < 1e-6,
      f"{vs:.2f}-{ve:.2f} -> {vs2:.2f}-{ve2:.2f}")
    popup.mouse.move(oxs(ve2), ov["y"] + ov["height"] / 2)
    popup.mouse.down()
    popup.mouse.move(oxs(ve2) + 30, ov["y"] + ov["height"] / 2, steps=4)
    popup.mouse.up()
    vs3, ve3 = (float(x) for x in ds("view").split(","))
    c("transient: dragging the window's edge zooms (wider view)", abs(vs3 - vs2) < 1e-6 and (ve3 - vs3) > (ve2 - vs2) + 0.5,
      f"{vs2:.2f}-{ve2:.2f} -> {vs3:.2f}-{ve3:.2f}")
    popup.mouse.click(ov["x"] + 5, ov["y"] + ov["height"] / 2)
    vs4, ve4 = (float(x) for x in ds("view").split(","))
    c("transient: a click outside the window brings the view there", vs4 < 0.5, f"{vs4:.2f}-{ve4:.2f}")
    popup.locator(".tr-play").click()
    popup.wait_for_timeout(300)
    shot(popup, "05h-transient-overview.png")
    popup.locator(".tr-play").click()
    kept = ds("dividers")
    popup.wait_for_timeout(400)  # edits are saved 300 ms after the last change

    open_popup()
    popup.wait_for_selector(".transient.is-ready", timeout=15000)
    c("transient: reopening the popup brings the view back with its edits",
      ds("dividers") == kept and int(ds("active")) == int(ds("sections")) - 1 and ds("fades") == kept_fades,
      f"{ds('dividers')[:80]}…")
    popup.locator(".tr-close").click()
    c("transient: closing restores the card and the popup width", popup.evaluate(
        "() => !document.querySelector('.transient') && !document.body.classList.contains('has-transient')"
        " && !document.querySelector('.is-transient')"))
    open_popup()
    c("transient: once closed it stays closed", popup.locator(".transient").count() == 0)
    popup.set_viewport_size({"width": 360, "height": 640})


def _music(c, ctx, popup, open_popup, ext_id, tab_id_for, items, watch, shot, poll, count, wait_request, pop_state, unhover):
    sc_site = f"http://soundcloud.com:{SITE_PORT}"
    music = watch(ctx.new_page())
    music.goto(sc_site + "/artista-teste/musica-atual")
    music.wait_for_function("() => window.__done === true", timeout=15000)
    sc_tab = tab_id_for(sc_site + "/")
    entries = poll(lambda: items(sc_tab), lambda v: any(e.get("meta") for e in v), timeout=10)
    stream = next((e for e in entries if e["kind"] == "hls"), {})
    c("music: the playing stream is sniffed", bool(stream), str([e["url"] for e in entries]))
    c("music: the stream keeps what the page said was playing (Media Session)",
      (stream.get("meta") or {}).get("title") == "Música Atual" and stream["meta"].get("artist") == "Artista Teste"
      and stream["meta"].get("artwork") == sc_site + "/media/cover.png", str(stream.get("meta")))

    popup.bring_to_front()
    open_popup(f"chrome-extension://{ext_id}/popup/popup.html?tab={sc_tab}")

    def rows():
        return popup.eval_on_selector_all(
            ".media-row",
            "rs => rs.map(r => ({ label: r.querySelector('.chip').textContent, name: r.querySelector('.media-name').textContent,"
            " meta: r.querySelector('.media-meta').textContent, duration: (r.querySelector('.duration') || {}).textContent || '',"
            " listen: r.querySelector('.thumb').classList.contains('is-listenable'), preview: r.querySelector('.thumb').dataset.preview || '',"
            " src: (r.querySelector('.thumb-media') || {}).src || '' }))",
        )

    got = poll(rows, lambda v: len(v) >= 3 and all(r["preview"] for r in v), timeout=15)
    by_name = {r["name"]: r for r in got}
    now = by_name.get("Música Atual", {})
    c("music: the stream row shows title, artist and cover", now.get("label") == "Áudio HLS" and now.get("meta", "").startswith("Artista Teste")
      and now.get("src") == sc_site + "/media/cover.png", str(now))
    one = by_name.get("Faixa Um", {})
    c("music: the page's tracks are listed with artist, duration and cover",
      one.get("label") == "SoundCloud" and one.get("meta", "").startswith("Artista Um") and one.get("duration") == "3:05"
      and one.get("src") == sc_site + "/media/cover.png" and "Faixa Dois" in by_name, str(got))
    c("music: stream and tracks can be played", now.get("listen") and one.get("listen"), str(got))
    c("music: the page card shows the page's cover", popup.locator(".page-head .page-thumb.has-media").count() == 1)
    c("music: the page's own track has the same play button", popup.locator(".page-head .page-thumb.is-listenable").count() == 1)
    popup.click(".page-head .page-thumb")
    own = poll(lambda: popup.eval_on_selector_all("iframe.sc-widget", "fs => fs.map(f => f.src)"), lambda v: len(v) == 1, timeout=4)
    c("player: the page card plays its own track, with the player under it",
      len(own) == 1 and "musica-atual" in own[0] and popup.locator(".page-card .player").count() == 1, str(own))
    shot(popup, "10a-music-main.png")
    popup.click(".page-card .player-btn")  # stop before the list tests

    # The player: play turns into stop, the line marks the position and seeks.
    def row_sel(name):
        return f'.media-row:has(.media-name:text-is("{name}"))'

    def player_state(name):
        return popup.eval_on_selector(
            row_sel(name),
            "r => { const p = r.querySelector('.player'); const s = p && p.querySelector('.seek');"
            " return { line: !!p, playing: !!p && p.classList.contains('is-playing'), tile: r.querySelector('.thumb').classList.contains('is-playing'),"
            " now: s ? Number(s.getAttribute('aria-valuenow')) : -1, max: s ? Number(s.getAttribute('aria-valuemax')) : -1,"
            " time: p ? p.querySelector('.player-time').textContent : '', label: p ? p.querySelector('.player-btn').getAttribute('aria-label') : '' }; }",
        )

    popup.click(row_sel("Música Atual") + " .thumb")
    st = poll(lambda: player_state("Música Atual"), lambda s: s["playing"] and s["now"] >= 1, timeout=10)
    c("player: clicking the cover plays the stream in the row's player", st["line"] and st["playing"] and st["tile"], str(st))
    c("player: play turned into stop", st["label"] == "Parar", str(st))
    c("player: the line marks the position and the duration", st["now"] >= 1 and st["max"] == 20 and " / 0:20" in st["time"], str(st))
    seek = popup.locator(row_sel("Música Atual") + " .seek")
    box = seek.bounding_box()
    popup.mouse.click(box["x"] + box["width"] * 0.75, box["y"] + box["height"] / 2)
    st = poll(lambda: player_state("Música Atual"), lambda s: 14 <= s["now"] <= 18, timeout=4)
    c("player: clicking the line seeks there (75% → ~0:15)", 14 <= st["now"] <= 18, str(st))
    time.sleep(0.4)
    shot(popup, "10-music-player.png")
    popup.click(row_sel("Música Atual") + " .player-btn")
    st = poll(lambda: player_state("Música Atual"), lambda s: not s["playing"], timeout=4)
    kept = st["now"]
    c("player: stop stops and keeps the position", not st["playing"] and st["label"] == "Tocar" and kept >= 14, str(st))
    popup.locator(row_sel("Música Atual") + " .seek").focus()
    popup.keyboard.press("Home")
    st = poll(lambda: player_state("Música Atual"), lambda s: s["now"] == 0, timeout=3)
    c("player: keys move the position (Home = start)", st["now"] == 0, str(st))

    popup.click(row_sel("Faixa Um") + " .thumb")
    widget = poll(lambda: popup.eval_on_selector_all("iframe.sc-widget", "fs => fs.map(f => f.src)"), lambda v: len(v) == 1, timeout=4)
    c("player: a SoundCloud track plays in SoundCloud's own player",
      len(widget) == 1 and widget[0].startswith("https://w.soundcloud.com/player/?") and "faixa-um" in widget[0], str(widget))
    c("player: one sound at a time (the previous row's player closes)",
      not player_state("Música Atual")["line"] and player_state("Faixa Um")["line"], str(player_state("Música Atual")))

    music.evaluate("() => window.__more()")  # the page loads more tracks (scrolling)
    grown = poll(rows, lambda v: any(r["name"] == "Faixa Três" for r in v), timeout=8)
    c("music: tracks that load while the popup is open join the list", any(r["name"] == "Faixa Três" for r in grown), str([r["name"] for r in grown]))

    n = count("/download")
    popup.click(row_sel("Faixa Dois") + " button.btn")
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("music: a listed track is sent by its page, as audio, titled artist - title",
      body.get("urls") == [sc_site + "/artista-dois/faixa-dois"] and body.get("mode") == "audio"
      and body.get("title") == "Artista Dois - Faixa Dois", str(body))
    n = count("/download")
    popup.click(row_sel("Música Atual") + " button.btn")
    req = wait_request("/download", n)
    body = req["body"] if req else {}
    c("music: the playing stream is sent as audio with its title", body.get("mode") == "audio"
      and body.get("title") == "Artista Teste - Música Atual" and body.get("urls", [""])[0].endswith("/hls/sc/stream.m3u8"), str(body))
    music.close()

    # Bandcamp: the album's tracks with their own streams.
    bc_site = f"http://artista.bandcamp.com:{SITE_PORT}"
    album = watch(ctx.new_page())
    album.goto(bc_site + "/album/teste")
    album.wait_for_function("() => window.__done === true", timeout=15000)
    bc_tab = tab_id_for(bc_site + "/")
    popup.bring_to_front()
    open_popup(f"chrome-extension://{ext_id}/popup/popup.html?tab={bc_tab}")
    got = poll(rows, lambda v: len(v) == 2, timeout=10)
    by_name = {r["name"]: r for r in got}
    a, b = by_name.get("Faixa A", {}), by_name.get("Faixa B", {})
    c("Bandcamp: the album's tracks are listed with artist and duration",
      a.get("label") == "Bandcamp" and a.get("meta", "").startswith("Banda Teste") and a.get("duration") == "0:06" and b.get("duration") == "3:20", str(got))
    c("Bandcamp: a track with a stream can be played; one without cannot", a.get("listen") and not b.get("listen"), str(got))
    popup.click(row_sel("Faixa A") + " .thumb")
    st = poll(lambda: player_state("Faixa A"), lambda s: s["playing"] and s["now"] >= 1, timeout=10)
    c("Bandcamp: the track's stream plays in the row's player", st["playing"] and st["max"] == 6, str(st))
    popup.click(row_sel("Faixa A") + " .player-btn")
    album.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", default=str(pathlib.Path(tempfile.gettempdir()) / "cachalot-ext-e2e"))
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--ext", help="unpacked extension to test (default: this source tree; e.g. an extracted package zip)")
    parser.add_argument("--wait-ports", type=int, default=0, help="seconds to wait for busy test ports to free up")
    parser.add_argument("--only", choices=["transient"], help="run just this part (paired straight away)")
    parser.add_argument("--bridge-port", type=int, default=47821,
                        help="mock bridge port; outside 47821-47830 (with --only) the test runs beside a running Cachalot")
    args = parser.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
