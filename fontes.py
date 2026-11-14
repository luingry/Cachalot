"""
fontes.py — reconhece o que foi colado e decide qual motor baixa.

Sem rede (exceto `sondar_arquivo_direto`). Ordem de decisão usada pelo servidor:
  magnet / .torrent  → torrent
  busca (texto sem link) → yt-dlp com "ytsearch1:"
  galeria / perfil em massa → gallery-dl
  extensão de arquivo conhecida, ou HEAD que responde arquivo → download HTTP direto
  plataformas com extrator nativo → nativo (com yt-dlp como reserva) ou yt-dlp primeiro
  todo o resto → yt-dlp (1800+ sites), depois galeria e navegador headless como resgate
"""

import os
import re
import urllib.request
from urllib.parse import parse_qs, unquote, urlparse

# (chave, nome exibido, domínios). A ordem importa só para domínios aninhados.
_PLATAFORMAS = [
    ("youtube", "YouTube", ("youtube.com", "youtube-nocookie.com", "youtu.be", "music.youtube.com")),
    ("instagram", "Instagram", ("instagram.com", "ddinstagram.com")),
    ("threads", "Threads", ("threads.net", "threads.com")),
    ("tiktok", "TikTok", ("tiktok.com",)),
    ("twitter", "X", ("twitter.com", "x.com", "vxtwitter.com", "fixvx.com", "fxtwitter.com")),
    ("reddit", "Reddit", ("reddit.com", "redd.it")),
    ("twitch", "Twitch", ("twitch.tv",)),
    ("pinterest", "Pinterest", ("pinterest.com", "pin.it")),
    ("bluesky", "Bluesky", ("bsky.app",)),
    ("vimeo", "Vimeo", ("vimeo.com",)),
    ("bilibili", "Bilibili", ("bilibili.com", "bilibili.tv", "b23.tv")),
    ("douyin", "Douyin", ("douyin.com", "iesdouyin.com")),
    ("soundcloud", "SoundCloud", ("soundcloud.com",)),
    ("facebook", "Facebook", ("facebook.com", "fb.watch")),
    ("kick", "Kick", ("kick.com",)),
    ("dailymotion", "Dailymotion", ("dailymotion.com", "dai.ly")),
    ("bandcamp", "Bandcamp", ("bandcamp.com",)),
    ("telegram", "Telegram", ("t.me", "telegram.me")),
    ("tumblr", "Tumblr", ("tumblr.com",)),
    ("linkedin", "LinkedIn", ("linkedin.com",)),
    ("snapchat", "Snapchat", ("snapchat.com",)),
    ("rumble", "Rumble", ("rumble.com",)),
    ("globoplay", "Globoplay", ("globoplay.globo.com", "globo.com")),
    ("mixcloud", "Mixcloud", ("mixcloud.com",)),
    ("udemy", "Udemy", ("udemy.com",)),
]

# Sites de arte/imagem: gallery-dl baixa a galeria inteira melhor que o yt-dlp.
_HOSTS_GALERIA = (
    "deviantart.com", "pixiv.net", "artstation.com", "flickr.com", "danbooru.donmai.us",
    "gelbooru.com", "e621.net", "konachan.com", "yande.re", "newgrounds.com", "kemono.su",
    "kemono.party", "kemono.cr", "coomer.su", "fanbox.cc", "weibo.com", "boards.4chan.org",
    "boards.4channel.org", "imgur.com", "imgchest.com", "hentai-foundry.com", "baraag.net",
    "wallhaven.cc", "behance.net", "500px.com", "furaffinity.net", "inkbunny.net", "safebooru.org",
)

_RESERVADOS_X = frozenset({
    "home", "explore", "notifications", "messages", "settings", "search", "hashtag", "intent",
    "share", "login", "logout", "signup", "i", "about", "tos", "privacy", "compose", "jobs",
})

# Extensões que são arquivo, não página (download HTTP direto, segmentado).
_EXTENSOES_DIRETAS = frozenset({
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "exe", "msi", "dmg", "pkg", "deb",
    "rpm", "appimage", "apk", "iso", "pdf", "epub", "mobi", "doc", "docx", "xls", "xlsx", "ppt",
    "pptx", "odt", "ods", "odp", "rtf", "txt", "csv", "jpg", "jpeg", "png", "gif", "webp", "bmp",
    "tiff", "svg", "heic", "avif", "bin", "dat", "img", "jar", "whl", "cab", "tbz", "lz4",
    "mp4", "mkv", "webm", "mov", "avi", "m4v", "mp3", "m4a", "flac", "wav", "ogg", "opus", "aac",
})

# Mídia "solta" em CDN: o yt-dlp também baixa, mas o HTTP direto é mais rápido e não demora no extractor.
_EXTENSOES_MIDIA = frozenset({"mp4", "mkv", "webm", "mov", "avi", "m4v", "mp3", "m4a", "flac", "wav", "ogg", "opus", "aac"})

_URL_RE = re.compile(r"(?:https?://|magnet:\?)[^\s<>\"']+", re.IGNORECASE)


def host_de(url: str) -> str:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def _casa(host: str, dominio: str) -> bool:
    return host == dominio or host.endswith("." + dominio)


def dominio_raiz(host: str) -> str:
    """Domínio registrável aproximado (exemplo.com.br, cdn.exemplo.com → exemplo.com)."""
    partes = [p for p in (host or "").lower().split(".") if p]
    if ":" in (host or "") or (partes and all(p.isdigit() for p in partes)):
        return (host or "").lower()  # IP: não tem domínio registrável
    if len(partes) <= 2:
        return ".".join(partes)
    if len(partes[-1]) == 2 and partes[-2] in ("com", "net", "org", "gov", "edu", "co", "ac"):
        return ".".join(partes[-3:])
    return ".".join(partes[-2:])


def plataforma(url: str) -> tuple[str, str]:
    """(chave, nome) da plataforma; ("", nome-do-site) quando não é conhecida."""
    if eh_magnet(url) or eh_torrent(url):
        return "torrent", "Torrent"
    host = host_de(url)
    for chave, nome, dominios in _PLATAFORMAS:
        if any(_casa(host, d) for d in dominios):
            return chave, nome
    if eh_galeria(url):
        return "galeria", dominio_raiz(host)
    return "", dominio_raiz(host) or host


def nome_plataforma_por_extractor(extractor_key: str, url: str) -> str:
    """Nome amigável a partir do extractor do yt-dlp (fallback: o site)."""
    chave, nome = plataforma(url)
    if chave and chave != "galeria":
        return nome
    ek = (extractor_key or "").strip()
    if ek and ek.lower() not in ("generic", "html5mediaembed", "genericie"):
        return ek
    return nome


def eh_magnet(texto: str) -> bool:
    return (texto or "").strip().lower().startswith("magnet:?")


def eh_torrent(texto: str) -> bool:
    t = (texto or "").strip()
    if t.lower().startswith(("http://", "https://")):
        try:
            return urlparse(t).path.lower().endswith(".torrent")
        except ValueError:
            return False
    return t.lower().endswith(".torrent") and os.path.isfile(t)


def eh_galeria(url: str) -> bool:
    """Hosts de arte/imagem e listagens em massa (perfis do X, subreddits) que o gallery-dl enumera."""
    host = host_de(url)
    if any(_casa(host, h) for h in _HOSTS_GALERIA):
        return True
    try:
        segs = [s for s in urlparse(url).path.split("/") if s]
    except ValueError:
        return False
    if _casa(host, "reddit.com"):
        if len(segs) == 2 and segs[0] == "r":
            return True
        if len(segs) == 3 and segs[0] == "r" and segs[2] in ("hot", "new", "top", "rising", "best"):
            return True
        if len(segs) == 2 and segs[0] in ("user", "u"):
            return True
        if len(segs) == 3 and segs[0] in ("user", "u") and segs[2] in ("submitted", "posts"):
            return True
        return False
    if host in ("twitter.com", "x.com"):
        if len(segs) == 1 and segs[0].lower() not in _RESERVADOS_X:
            return True
        if len(segs) == 2 and segs[0].lower() not in _RESERVADOS_X and segs[1] in ("media", "likes"):
            return True
    if _casa(host, "instagram.com") and len(segs) == 1 and segs[0] not in ("explore", "accounts", "direct", "reels", "stories"):
        return True
    if _casa(host, "pinterest.com") and len(segs) in (1, 2) and segs[0] not in ("pin", "search", "ideas", "today"):
        return True
    return False


def extensao_url(url: str) -> str:
    try:
        nome = unquote(urlparse(url).path.rsplit("/", 1)[-1])
    except ValueError:
        return ""
    if "." not in nome or nome.startswith("."):
        return ""
    return nome.rsplit(".", 1)[-1].lower()


def eh_arquivo_direto(url: str) -> bool:
    """Extensão de arquivo conhecida num link http(s) que não é de plataforma conhecida."""
    if not (url or "").lower().startswith(("http://", "https://")):
        return False
    chave, _ = plataforma(url)
    if chave and chave not in ("galeria",):
        return False
    return extensao_url(url) in _EXTENSOES_DIRETAS


def eh_manifesto(url: str) -> bool:
    return extensao_url(url) in ("m3u8", "mpd")


def sondar_arquivo_direto(url: str, user_agent: str = "", timeout: float = 8.0) -> bool:
    """
    HEAD curto para links sem extensão conhecida: se não é página HTML e tem tamanho de arquivo,
    é download direto (evita minutos parado no extractor genérico do yt-dlp). Bloqueante.
    """
    pedido = urllib.request.Request(url, method="HEAD", headers={"User-Agent": user_agent or _UA})
    try:
        with urllib.request.urlopen(pedido, timeout=timeout) as r:
            tipo = (r.headers.get("Content-Type") or "").lower()
            tamanho = int(r.headers.get("Content-Length") or 0)
            disposicao = (r.headers.get("Content-Disposition") or "").lower()
    except Exception:
        return False
    if "attachment" in disposicao:
        return True
    if not tipo or "text/html" in tipo or "xml" in tipo or "json" in tipo or "mpegurl" in tipo or "dash" in tipo:
        return False
    return tamanho >= 64 * 1024


def eh_playlist(url: str) -> bool:
    """Links que são listas por natureza (não um vídeo com lista anexada)."""
    try:
        p = urlparse(url)
    except ValueError:
        return False
    host = host_de(url)
    q = parse_qs(p.query)
    if any(_casa(host, d) for d in ("youtube.com", "youtube-nocookie.com")):
        if p.path.startswith("/playlist"):
            return True
        if "list" in q and "v" not in q:
            return True
        segs = [s for s in p.path.split("/") if s]
        if segs and (segs[0].startswith("@") or segs[0] in ("channel", "c", "user")):
            return True
    if _casa(host, "soundcloud.com"):
        segs = [s for s in p.path.split("/") if s]
        return "sets" in segs or len(segs) == 1
    return False


def tem_lista_anexada(url: str) -> bool:
    """YouTube watch?v=…&list=… — por padrão só o vídeo; com a opção ligada, a lista inteira."""
    try:
        q = parse_qs(urlparse(url).query)
    except ValueError:
        return False
    return "list" in q and "v" in q and any(_casa(host_de(url), d) for d in ("youtube.com", "music.youtube.com"))


def extrair_entradas(texto: str) -> list[str]:
    """
    Quebra o que foi colado em itens: links (inclusive vários na mesma linha), magnets,
    caminhos de .torrent e, nas linhas sem link, uma busca no YouTube.
    """
    itens: list[str] = []
    for linha in (texto or "").splitlines():
        linha = linha.strip().strip("﻿")
        if not linha or linha.startswith("#"):
            continue
        achados = _URL_RE.findall(linha)
        if achados:
            itens.extend(a.rstrip(").,;]}>") for a in achados)
        elif linha.lower().endswith(".torrent") and os.path.isfile(linha.strip('"')):
            itens.append(linha.strip('"'))
        elif linha.lower().startswith(("ytsearch", "scsearch")):
            itens.append(linha)
        elif len(linha) >= 2:
            itens.append("ytsearch1:" + linha)
    vistos: set[str] = set()
    unicos = []
    for i in itens:
        chave = normalizar_para_comparar(i)
        if chave not in vistos:
            vistos.add(chave)
            unicos.append(i)
    return unicos


_PARAMS_RASTREIO = re.compile(r"^(utm_\w+|si|feature|fbclid|gclid|igsh|igshid|ref|ref_src|s|t)$", re.IGNORECASE)


def normalizar_para_comparar(url: str) -> str:
    """Chave para detectar duplicados: sem esquema, www, barra final e parâmetros de rastreio."""
    u = (url or "").strip()
    if not u.lower().startswith(("http://", "https://")):
        return u.lower()
    try:
        p = urlparse(u)
    except ValueError:
        return u.lower()
    host = host_de(u)
    q = "&".join(sorted(
        f"{k}={v[0]}" for k, v in parse_qs(p.query).items() if not _PARAMS_RASTREIO.match(k)
    ))
    if host == "youtu.be":
        return "youtube.com/watch?v=" + p.path.strip("/")
    return f"{host}{p.path.rstrip('/')}" + (f"?{q}" if q else "")


_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
