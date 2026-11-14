"""
nativos.py — extratores próprios para redes que costumam barrar o yt-dlp sem login.

Cada função recebe o link e devolve um `Resultado` com as mídias (URLs finais + headers), ou levanta
`NativoFalhou` com uma mensagem curta. Nada aqui baixa arquivo: quem baixa é o servidor (HTTP direto,
ou yt-dlp para manifestos HLS). Tudo é bloqueante — chame em executor.

Endpoints públicos usados (sem conta), na ordem testada por plataforma:
  X/Twitter  GraphQL TweetDetail com guest token → syndication (cdn.syndication.twimg.com) → HTML (só fotos)
  Reddit     /comments/<id>.json (vídeo sem áudio + trilha DASH de áudio separada, galerias, imagens)
  Instagram  /p/<id>/embed/captioned/ → GraphQL PolarisPostActionLoadPostQuery
  TikTok     __UNIVERSAL_DATA_FOR_REHYDRATION__ da página do vídeo (vídeo, fotos)
  Pinterest  HTML do pin (v1.pinimg.com / i.pinimg.com originals)
  Bluesky    public.api.bsky.app getPostThread (HLS, imagens, GIF do Tenor)
  Threads    JSON embutido nos <script data-sjs> (com UA de crawler quando há login wall)
  Twitch     gql.twitch.tv (clipes: qualidades + token de acesso)
  Douyin     iesdouyin.com/share/video com cookie ttwid (sem marca d'água)
"""

import http.cookiejar
import json
import math
import random
import re
import string
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
UA_GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
TIMEOUT = 20


class NativoFalhou(Exception):
    """Falha do extrator nativo; a mensagem pode aparecer na interface se nada mais funcionar."""


@dataclass
class Midia:
    url: str
    tipo: str = "video"            # video | imagem | audio | gif
    ext: str = "mp4"
    altura: int = 0
    headers: dict = field(default_factory=dict)
    audio_url: str = ""            # trilha separada a juntar com ffmpeg (Reddit)
    via_ytdlp: bool = False        # manifesto HLS/DASH: baixar com o yt-dlp


@dataclass
class Resultado:
    titulo: str = ""
    autor: str = ""
    thumb: str = ""
    midias: list = field(default_factory=list)


# ── HTTP mínimo (stdlib) ──────────────────────────────────────────────────────

class _Http:
    def __init__(self, ua: str = UA_CHROME, cookies: http.cookiejar.CookieJar | None = None):
        self.jar = cookies if cookies is not None else http.cookiejar.CookieJar()
        self.ua = ua
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def pedir(self, url: str, headers: dict | None = None, dados: bytes | None = None,
              metodo: str | None = None, timeout: float = TIMEOUT) -> tuple[int, str, str]:
        """(status, texto, url_final). Erros HTTP devolvem o status com o corpo, sem exceção."""
        h = {"User-Agent": self.ua, "Accept-Language": "en-US,en;q=0.9"}
        h.update(headers or {})
        pedido = urllib.request.Request(url, data=dados, headers=h, method=metodo)
        try:
            with self._opener.open(pedido, timeout=timeout) as r:
                corpo = r.read()
                return r.status, corpo.decode(_charset(r.headers), errors="replace"), r.geturl()
        except urllib.error.HTTPError as e:
            try:
                corpo = e.read().decode("utf-8", errors="replace")
            except Exception:
                corpo = ""
            return e.code, corpo, url
        except Exception as e:
            raise NativoFalhou(f"Sem resposta de {urllib.parse.urlparse(url).hostname}: {e}") from e

    def json(self, url: str, headers: dict | None = None, dados: bytes | None = None) -> tuple[int, object]:
        status, texto, _ = self.pedir(url, headers, dados)
        try:
            return status, json.loads(texto) if texto else None
        except ValueError:
            return status, None

    def resolver(self, url: str) -> str:
        """Segue redirecionamentos (pin.it, v.redd.it, vm.tiktok.com, links /share/) até a URL final."""
        _, _, final = self.pedir(url)
        return final


def _charset(headers) -> str:
    m = re.search(r"charset=([\w-]+)", headers.get("Content-Type") or "", re.IGNORECASE)
    return m.group(1) if m else "utf-8"


def _segs(url: str) -> list[str]:
    return [s for s in urllib.parse.urlparse(url).path.split("/") if s]


def _ext_de(url: str, padrao: str) -> str:
    nome = urllib.parse.urlparse(url).path.rsplit("/", 1)[-1]
    if "." in nome:
        ext = nome.rsplit(".", 1)[-1].lower()
        if 2 <= len(ext) <= 4 and ext.isalnum():
            return ext
    return padrao


def _altura_da_url(url: str) -> int:
    m = re.search(r"/(\d{3,4})x(\d{3,4})/", url)
    return int(m.group(2)) if m else 0


def _pegar(obj, *caminho, padrao=None):
    for chave in caminho:
        if isinstance(obj, dict):
            obj = obj.get(chave)
        elif isinstance(obj, list) and isinstance(chave, int) and -len(obj) <= chave < len(obj):
            obj = obj[chave]
        else:
            return padrao
        if obj is None:
            return padrao
    return obj


def _procurar_chave(obj, chave: str):
    """Primeiro valor da chave em qualquer profundidade (JSON de forma instável)."""
    pilha = [obj]
    while pilha:
        atual = pilha.pop()
        if isinstance(atual, dict):
            if chave in atual and atual[chave]:
                return atual[chave]
            pilha.extend(atual.values())
        elif isinstance(atual, list):
            pilha.extend(atual)
    return None


# ── X / Twitter ──────────────────────────────────────────────────────────────

_X_BEARER = ("Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA")
_X_GRAPHQL = "https://api.x.com/graphql/4Siu98E55GquhG52zHdY5w/TweetDetail"
_X_FEATURES = json.dumps({
    "rweb_video_screen_enabled": False, "payments_enabled": False, "rweb_xchat_enabled": False,
    "profile_label_improvements_pcf_label_in_post_enabled": True, "rweb_tipjar_consumption_enabled": True,
    "verified_phone_label_enabled": False, "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "premium_content_api_read_enabled": False, "communities_web_enable_tweet_community_results_fetch": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True, "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": True, "responsive_web_jetfuel_frame": True,
    "responsive_web_grok_share_attachment_enabled": True, "articles_preview_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True, "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True, "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "tweet_awards_web_tipping_enabled": False, "responsive_web_grok_show_grok_translated_post": False,
    "responsive_web_grok_analysis_button_from_backend": True, "creator_subscriptions_quote_tweet_preview_enabled": False,
    "freedom_of_speech_not_reach_fetch_enabled": True, "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True, "longform_notetweets_inline_media_enabled": True,
    "responsive_web_grok_image_annotation_enabled": True, "responsive_web_grok_imagine_annotation_enabled": True,
    "responsive_web_grok_community_note_auto_translation_is_enabled": False, "responsive_web_enhance_cards_enabled": False,
}, separators=(",", ":"))
_X_TOGGLES = json.dumps({"withArticleRichContentState": True, "withArticlePlainText": False,
                         "withGrokAnalyze": False, "withDisallowedReplyControls": False}, separators=(",", ":"))
_X_CAMINHOS_MIDIA = [
    ("legacy", "extended_entities", "media"),
    ("tweet", "legacy", "extended_entities", "media"),
    ("legacy", "retweeted_status_result", "result", "legacy", "extended_entities", "media"),
    ("legacy", "retweeted_status_result", "result", "tweet", "legacy", "extended_entities", "media"),
    ("tweet", "legacy", "retweeted_status_result", "result", "legacy", "extended_entities", "media"),
    ("legacy", "quoted_status_result", "result", "legacy", "extended_entities", "media"),
    ("legacy", "quoted_status_result", "result", "tweet", "legacy", "extended_entities", "media"),
    ("tweet", "legacy", "quoted_status_result", "result", "legacy", "extended_entities", "media"),
]
_x_guest_token = ""


def _id_tweet(url: str) -> str:
    segs = _segs(url)
    for i, s in enumerate(segs[:-1]):
        if s == "status" and segs[i + 1].isdigit():
            return segs[i + 1]
    m = re.search(r"/status(?:es)?/(\d+)", url)
    if m:
        return m.group(1)
    raise NativoFalhou("Link do X sem id de post.")


def _x_token_syndication(tweet_id: str) -> str:
    """Mesmo cálculo do embed oficial: base36((id / 1e15) * π) sem ponto e zeros das pontas."""
    valor = (int(tweet_id) / 1e15) * math.pi
    digitos = "0123456789abcdefghijklmnopqrstuvwxyz"
    inteiro = int(valor)
    frac = valor - inteiro
    s = ""
    n = inteiro
    while n > 0:
        s = digitos[n % 36] + s
        n //= 36
    s = s or "0"
    if frac > 0:
        s += "."
        for _ in range(12):
            frac *= 36
            d = int(frac)
            s += digitos[d]
            frac -= d
            if frac <= 0:
                break
    return s.replace(".", "").strip("0")


def _x_guest(http: _Http, forcar: bool = False) -> str:
    global _x_guest_token
    if _x_guest_token and not forcar:
        return _x_guest_token
    status, dados = http.json("https://api.x.com/1.1/guest/activate.json",
                              {"Authorization": _X_BEARER, "x-twitter-client-language": "en",
                               "x-twitter-active-user": "yes"}, dados=b"")
    token = _pegar(dados, "guest_token") if status == 200 else None
    if not token:
        raise NativoFalhou(f"X recusou o token de visitante (HTTP {status}).")
    _x_guest_token = str(token)
    return _x_guest_token


def _x_midias_de_itens(itens: list, limite_altura: int) -> list[Midia]:
    midias = []
    for item in itens or []:
        tipo = item.get("type") or ""
        variantes = _pegar(item, "video_info", "variants") or _pegar(item, "video", "variants") or []
        if tipo in ("video", "animated_gif") or variantes:
            mp4s = [v for v in variantes if v.get("content_type") == "video/mp4" and v.get("url")]
            if mp4s:
                def chave(v):
                    alt = _altura_da_url(v["url"])
                    cabe = 0 if (limite_altura and alt and alt > limite_altura) else 1
                    return (cabe, v.get("bitrate") or 0)
                melhor = max(mp4s, key=chave)
                midias.append(Midia(melhor["url"], "gif" if tipo == "animated_gif" else "video", "mp4",
                                    _altura_da_url(melhor["url"]), {"Referer": "https://x.com/"}))
                continue
            hls = next((v["url"] for v in variantes if ".m3u8" in (v.get("url") or "")), "")
            if hls:
                midias.append(Midia(hls, "video", "mp4", 0, {"Referer": "https://x.com/"}, via_ytdlp=True))
                continue
        base = item.get("media_url_https") or item.get("media_url") or item.get("url") or ""
        if base and "pbs.twimg.com" in base:
            midias.append(_x_foto(base))
    return midias


def _x_foto(base: str) -> Midia:
    base = base.replace("\\u0026", "&").replace("&amp;", "&")
    p = urllib.parse.urlparse(base)
    ext = _ext_de(base, "") or (urllib.parse.parse_qs(p.query).get("format", ["jpg"])[0])
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query) if k != "name"] + [("name", "orig")]
    return Midia(urllib.parse.urlunparse(p._replace(query=urllib.parse.urlencode(q))), "imagem", ext or "jpg")


def twitter(url: str, limite_altura: int = 0, cookie_header: str = "") -> Resultado:
    tweet_id = _id_tweet(url)
    http = _Http()
    erros = []
    # 1) GraphQL com guest token (pega vídeo, GIF e fotos, inclusive de retweet/citação).
    for tentativa in range(2):
        try:
            token = _x_guest(http, forcar=tentativa > 0)
            variaveis = {"focalTweetId": tweet_id, "with_rux_injections": False, "rankingMode": "Relevance",
                         "includePromotedContent": True, "withCommunity": True,
                         "withQuickPromoteEligibilityTweetFields": True, "withBirdwatchNotes": True, "withVoice": True}
            q = urllib.parse.urlencode({"variables": json.dumps(variaveis, separators=(",", ":")),
                                        "features": _X_FEATURES, "fieldToggles": _X_TOGGLES})
            cookie = f"guest_id=v1%3A{token}" + (f"; {cookie_header}" if cookie_header else "")
            h = {"Authorization": _X_BEARER, "x-guest-token": token, "x-twitter-client-language": "en",
                 "x-twitter-active-user": "yes", "Content-Type": "application/json", "Cookie": cookie}
            ct0 = re.search(r"(?:^|;\s*)ct0=([^;]+)", cookie)
            if ct0:
                h["x-csrf-token"] = ct0.group(1)
            if "auth_token=" in cookie:
                h["x-twitter-auth-type"] = "OAuth2Session"
            status, dados = http.json(f"{_X_GRAPHQL}?{q}", h)
            if status in (403, 429) and tentativa == 0:
                continue
            if status == 404:
                raise NativoFalhou("Post do X não está disponível.")
            if status != 200 or not dados:
                raise NativoFalhou(f"X GraphQL HTTP {status}")
            res = _x_resultado_graphql(dados, tweet_id, limite_altura)
            if res.midias:
                return res
            erros.append("post sem mídia")
            break
        except NativoFalhou as e:
            erros.append(str(e))
            if "privado" in str(e).lower() or "idade" in str(e).lower():
                raise
            break
    # 2) Syndication (o mesmo do embed oficial).
    try:
        token = _x_token_syndication(tweet_id)
        status, dados = http.json(f"https://cdn.syndication.twimg.com/tweet-result?id={tweet_id}&token={token}&lang=en")
        if status == 200 and isinstance(dados, dict) and dados.get("__typename") not in ("TweetTombstone", "TweetUnavailable"):
            itens = dados.get("mediaDetails") or dados.get("photos") or _procurar_chave(dados, "mediaDetails") or []
            midias = _x_midias_de_itens(itens, limite_altura)
            if midias:
                return Resultado(_x_titulo(dados.get("text"), _pegar(dados, "user", "name")),
                                 _pegar(dados, "user", "name") or "", _pegar(itens, 0, "media_url_https") or "", midias)
        erros.append(f"syndication HTTP {status}")
    except NativoFalhou as e:
        erros.append(str(e))
    # 3) HTML (só fotos).
    status, html, _ = http.pedir(url.replace("x.com", "twitter.com") if "x.com" in url else url)
    fotos = list(dict.fromkeys(re.findall(r"https://pbs\.twimg\.com/media/[^\s\"'<>\\]+", html or "")))
    if fotos:
        return Resultado(midias=[_x_foto(f) for f in fotos])
    raise NativoFalhou("X: " + "; ".join(erros or ["sem mídia"]))


def _x_resultado_graphql(dados, tweet_id: str, limite_altura: int) -> Resultado:
    instrucoes = _pegar(dados, "data", "threaded_conversation_with_injections_v2", "instructions") or []
    adicionar = next((i for i in instrucoes if i.get("type") == "TimelineAddEntries"), None)
    entrada = next((e for e in (adicionar or {}).get("entries", []) if e.get("entryId") == f"tweet-{tweet_id}"), None)
    resultado = _pegar(entrada, "content", "itemContent", "tweet_results", "result")
    if not resultado:
        raise NativoFalhou("Post do X não está disponível.")
    tipo = resultado.get("__typename") or ""
    if tipo in ("TweetUnavailable", "TweetTombstone"):
        motivo = _pegar(resultado, "result", "reason") or resultado.get("reason") or ""
        lapide = _pegar(resultado, "tombstone", "text", "text") or ""
        if motivo == "Protected":
            raise NativoFalhou("Post privado: só seguidores aprovados podem ver.")
        if motivo == "NsfwLoggedOut" or lapide.startswith("Age-restricted"):
            raise NativoFalhou("Post com restrição de idade: precisa de cookies de uma conta logada.")
        raise NativoFalhou("Post do X não está disponível.")
    itens = None
    for caminho in _X_CAMINHOS_MIDIA:
        itens = _pegar(resultado, *caminho)
        if itens:
            break
    itens = itens or _procurar_chave(resultado, "media") or []
    legado = resultado.get("legacy") or _pegar(resultado, "tweet", "legacy") or {}
    autor = _pegar(resultado, "core", "user_results", "result", "legacy", "name") or \
        _pegar(resultado, "core", "user_results", "result", "core", "name") or ""
    midias = _x_midias_de_itens(itens if isinstance(itens, list) else [], limite_altura)
    thumb = _pegar(itens, 0, "media_url_https") or ""
    return Resultado(_x_titulo(legado.get("full_text"), autor), autor, thumb, midias)


def _x_titulo(texto: str | None, autor: str | None) -> str:
    t = re.sub(r"https://t\.co/\S+", "", texto or "").strip()
    t = re.sub(r"\s+", " ", t)[:90]
    if autor and t:
        return f"{autor} - {t}"
    return t or autor or ""


# ── Reddit ───────────────────────────────────────────────────────────────────

def reddit(url: str, limite_altura: int = 0) -> Resultado:
    http = _Http()
    host = urllib.parse.urlparse(url).hostname or ""
    if host in ("v.redd.it", "redd.it") or "/s/" in urllib.parse.urlparse(url).path:
        url = http.resolver(url)
    segs = _segs(url)
    post_id = ""
    if "comments" in segs and segs.index("comments") + 1 < len(segs):
        post_id = segs[segs.index("comments") + 1]
    elif len(segs) >= 2 and segs[0] == "video":
        post_id = segs[1]
    if not post_id:
        raise NativoFalhou("Link do Reddit sem id de post.")
    status, dados = http.json(f"https://www.reddit.com/comments/{post_id}.json?raw_json=1", {"Accept": "application/json"})
    post = _pegar(dados, 0, "data", "children", 0, "data")
    if status != 200 or not post:
        raise NativoFalhou(f"Reddit não respondeu o post (HTTP {status}).")
    if post.get("crosspost_parent_list"):
        post = post["crosspost_parent_list"][0]
    titulo = post.get("title") or ""
    autor = post.get("author") or ""
    thumb = _pegar(post, "preview", "images", 0, "source", "url") or ""
    midias: list[Midia] = []
    if post.get("is_gallery"):
        meta = post.get("media_metadata") or {}
        for item in _pegar(post, "gallery_data", "items") or []:
            m = meta.get(item.get("media_id")) or {}
            fonte = _pegar(m, "s", "u") or _pegar(m, "s", "gif") or _pegar(m, "s", "mp4")
            if fonte:
                mime = (m.get("m") or "image/jpg").split("/")[-1]
                midias.append(Midia(fonte.replace("&amp;", "&"), "imagem" if "gif" not in mime else "gif",
                                    "jpg" if mime == "jpeg" else mime))
    video = _pegar(post, "secure_media", "reddit_video") or _pegar(post, "media", "reddit_video")
    if not midias and video and video.get("fallback_url"):
        fallback = video["fallback_url"].split("?")[0]
        alvo = _reddit_video_maior(http, fallback, limite_altura or 0)
        audio = "" if video.get("is_gif") else _reddit_audio(http, fallback)
        midias.append(Midia(alvo, "video", "mp4", video.get("height") or 0, audio_url=audio))
    destino = post.get("url_overridden_by_dest") or post.get("url") or ""
    if not midias and destino:
        ext = _ext_de(destino, "")
        if "i.redd.it" in destino or ext in ("jpg", "jpeg", "png", "webp", "gif"):
            midias.append(Midia(destino, "gif" if ext == "gif" else "imagem", ext or "jpg"))
    if not midias:
        raise NativoFalhou("Post do Reddit sem mídia própria (pode ser um link externo).")
    return Resultado(titulo, autor, thumb.replace("&amp;", "&"), midias)


def _reddit_existe(http: _Http, url: str) -> bool:
    try:
        status, _, _ = http.pedir(url, metodo="HEAD", timeout=5)
        return status == 200
    except NativoFalhou:
        return False


def _reddit_audio(http: _Http, fallback: str) -> str:
    base = fallback.rsplit("_", 1)[0]
    candidatos = [f"{base}_audio.mp4", f"{base}_AUDIO_128.mp4", f"{base}_AUDIO_64.mp4"]
    if "DASH" in fallback:
        candidatos.append(fallback[:fallback.index("DASH")] + "audio")
    return next((c for c in candidatos if _reddit_existe(http, c)), "")


def _reddit_video_maior(http: _Http, fallback: str, limite: int) -> str:
    if "DASH_" not in fallback:
        return fallback
    base = fallback[:fallback.index("DASH_")]
    for altura in (1080, 720, 480, 360, 240):
        if limite and altura > limite:
            continue
        candidato = f"{base}DASH_{altura}.mp4"
        if candidato == fallback or _reddit_existe(http, candidato):
            return candidato
    return fallback


# ── Instagram ────────────────────────────────────────────────────────────────

_IG_APP_ID = "936619743392459"


def _ig_shortcode(http: _Http, url: str) -> str:
    segs = _segs(url)
    if segs and segs[0] == "share":
        url = http.resolver(url)
        segs = _segs(url)
    for i, s in enumerate(segs[:-1]):
        if s in ("p", "reel", "reels", "tv"):
            return segs[i + 1]
    if "stories" in segs:
        raise NativoFalhou("Stories do Instagram precisam de cookies de uma conta logada.")
    raise NativoFalhou("Link do Instagram sem id de post.")


def _ig_midias(media: dict) -> list[Midia]:
    midias = []
    filhos = _pegar(media, "edge_sidecar_to_children", "edges") or []
    nos = [e.get("node") or {} for e in filhos] or [media]
    for no in nos:
        if no.get("is_video") and no.get("video_url"):
            midias.append(Midia(no["video_url"], "video", "mp4", _pegar(no, "dimensions", "height") or 0,
                                {"Referer": "https://www.instagram.com/"}))
        else:
            imagem = no.get("display_url") or _pegar(no, "display_resources", -1, "src")
            if imagem:
                midias.append(Midia(imagem, "imagem", _ext_de(imagem, "jpg"), 0, {"Referer": "https://www.instagram.com/"}))
    return midias


def _ig_resultado(media: dict) -> Resultado:
    legenda = _pegar(media, "edge_media_to_caption", "edges", 0, "node", "text") or ""
    autor = _pegar(media, "owner", "username") or ""
    titulo = re.sub(r"\s+", " ", legenda).strip()[:90]
    titulo = f"{autor} - {titulo}" if autor and titulo else (titulo or autor)
    return Resultado(titulo, autor, media.get("display_url") or "", _ig_midias(media))


def instagram(url: str, cookie_header: str = "") -> Resultado:
    http = _Http()
    code = _ig_shortcode(http, url)
    extra = {"Cookie": cookie_header} if cookie_header else {}
    # 1) Embed (público, sem token).
    status, html, _ = http.pedir(f"https://www.instagram.com/p/{code}/embed/captioned/",
                                 {"Sec-Fetch-Dest": "iframe", "Referer": "https://www.instagram.com/", **extra})
    if status == 200 and html:
        media = None
        m = re.search(r'"init",\[\],\[(.*?)\]\],', html)
        if m:
            try:
                contexto = json.loads(m.group(1)).get("contextJSON")
                dados = json.loads(contexto) if isinstance(contexto, str) else contexto
                media = _pegar(dados, "gql_data", "shortcode_media") or _pegar(dados, "gql_data", "xdt_shortcode_media")
            except (ValueError, AttributeError):
                media = None
        if not media:
            m = re.search(r"window\.__additionalDataLoaded\('extra',\s*(\{.*?\})\s*\);", html)
            if m:
                try:
                    dados = json.loads(m.group(1))
                    media = dados.get("shortcode_media") or _pegar(dados, "graphql", "shortcode_media")
                except ValueError:
                    media = None
        if media:
            res = _ig_resultado(media)
            if res.midias:
                return res
    # 2) GraphQL da página do post (tokens raspados do HTML).
    status, pagina, final = http.pedir(f"https://www.instagram.com/p/{code}/", extra)
    baixo = (pagina or "").lower()
    if "/accounts/login" in final or '"require_login":true' in baixo:
        raise NativoFalhou("O Instagram pediu login: o post pode ser privado. Importe cookies de uma conta logada.")
    tokens = _ig_tokens(pagina or "")
    form = {
        "__d": "www", "__a": "1", "__s": "::" + "".join(random.choices(string.ascii_lowercase, k=6)),
        "__hs": tokens.get("haste_session", ""), "__req": "b", "__ccg": "EXCELLENT",
        "__rev": tokens.get("rollout_hash", ""), "__hsi": tokens.get("hsi", ""),
        "__comet_req": tokens.get("comet_req", "7"), "av": "0", "dpr": "2", "__user": "0",
        "lsd": tokens.get("lsd", ""), "jazoest": tokens.get("jazoest", ""),
        "__spin_r": tokens.get("__spin_r", ""), "__spin_b": tokens.get("__spin_b", ""), "__spin_t": tokens.get("__spin_t", ""),
        "fb_api_caller_class": "RelayModern", "fb_api_req_friendly_name": "PolarisPostActionLoadPostQueryQuery",
        "variables": json.dumps({"shortcode": code, "fetch_tagged_user_count": None,
                                 "hoisted_comment_id": None, "hoisted_reply_id": None}),
        "server_timestamps": "true", "doc_id": "8845758582119845",
    }
    cookies = f"csrftoken={tokens.get('csrf_token', '')}; ig_did={tokens.get('device_id', '')}; wd=1280x720; dpr=2; mid={tokens.get('machine_id', '')}; ig_nrcb=1"
    h = {"x-ig-app-id": tokens.get("app_id", _IG_APP_ID), "X-FB-LSD": tokens.get("lsd", ""),
         "X-CSRFToken": tokens.get("csrf_token", ""), "X-FB-Friendly-Name": "PolarisPostActionLoadPostQueryQuery",
         "x-asbd-id": "129477", "X-Bloks-Version-Id": tokens.get("versioning_id", ""),
         "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded",
         "Origin": "https://www.instagram.com", "Referer": f"https://www.instagram.com/p/{code}/",
         "Cookie": cookie_header or cookies}
    status, dados = http.json("https://www.instagram.com/graphql/query", h, urllib.parse.urlencode(form).encode())
    media = _pegar(dados, "data", "xdt_shortcode_media") or _pegar(dados, "data", "shortcode_media")
    if not media:
        raise NativoFalhou(f"Instagram não entregou o post (HTTP {status}).")
    res = _ig_resultado(media)
    if not res.midias:
        raise NativoFalhou("Post do Instagram sem mídia.")
    return res


def _ig_tokens(html: str) -> dict:
    t: dict = {}

    def config(nome):
        m = re.search(r'\["' + re.escape(nome) + r'",.*?,(\{.*?\}),\d+\]', html)
        if not m:
            return {}
        try:
            return json.loads(m.group(1))
        except ValueError:
            return {}

    t["csrf_token"] = config("InstagramSecurityConfig").get("csrf_token", "")
    polaris = config("PolarisSiteData")
    t["device_id"], t["machine_id"] = polaris.get("device_id", ""), polaris.get("machine_id", "")
    site = config("SiteData")
    for k in ("haste_session", "hsi", "__spin_r", "__spin_b", "__spin_t"):
        t[k] = str(site.get(k, ""))
    t["app_id"] = str(config("DGWWebConfig").get("appId", _IG_APP_ID))
    t["lsd"] = config("LSD").get("token", "")
    t["versioning_id"] = config("WebBloksVersioningID").get("versioningID", "")
    t["rollout_hash"] = str(config("InstagramWebPushInfo").get("rollout_hash", ""))
    m = re.search(r"__comet_req=(\d+)", html)
    t["comet_req"] = m.group(1) if m else "7"
    m = re.search(r"jazoest=(\d+)", html)
    t["jazoest"] = m.group(1) if m else ""
    return t


# ── TikTok ───────────────────────────────────────────────────────────────────

def tiktok(url: str) -> Resultado:
    http = _Http(UA_CHROME)
    host = urllib.parse.urlparse(url).hostname or ""
    if host.startswith(("vm.", "vt.")) or "/t/" in url:
        url = http.resolver(url).split("?")[0]
    m = re.search(r"/(?:video|photo)/(\d+)", url)
    if not m:
        raise NativoFalhou("Link do TikTok sem id de vídeo.")
    vid = m.group(1)
    status, html, _ = http.pedir(f"https://www.tiktok.com/@i/video/{vid}")
    if re.search(r"verify-bar-close|captcha_verify|tiktok-verify-page|verify/page", html or ""):
        raise NativoFalhou("O TikTok está pedindo verificação. Tente de novo em alguns minutos.")
    m = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">(.*?)</script>', html or "", re.S)
    if not m:
        raise NativoFalhou(f"TikTok não entregou os dados do vídeo (HTTP {status}).")
    try:
        detalhe = json.loads(m.group(1))["__DEFAULT_SCOPE__"]["webapp.video-detail"]
    except (ValueError, KeyError):
        raise NativoFalhou("TikTok mudou o formato da página.")
    item = _pegar(detalhe, "itemInfo", "itemStruct")
    if not item:
        raise NativoFalhou("Vídeo do TikTok indisponível: " + str(detalhe.get("statusMsg") or detalhe.get("statusCode")))
    if item.get("isContentClassified"):
        raise NativoFalhou("Vídeo do TikTok com restrição de idade: precisa de cookies de uma conta logada.")
    cookies = "; ".join(f"{c.name}={c.value}" for c in http.jar)
    h = {"Referer": "https://www.tiktok.com/", "Cookie": cookies}
    autor = _pegar(item, "author", "uniqueId") or ""
    titulo = (item.get("desc") or "").strip()[:90]
    titulo = f"{autor} - {titulo}" if autor and titulo else (titulo or autor or vid)
    thumb = _pegar(item, "video", "cover") or _pegar(item, "video", "originCover") or ""
    midias = []
    imagens = _pegar(item, "imagePost", "images") or []
    for img in imagens:
        lista = _pegar(img, "imageURL", "urlList") or []
        escolha = next((u for u in lista if ".jpeg" in u or ".jpg" in u), lista[0] if lista else "")
        if escolha:
            midias.append(Midia(escolha, "imagem", "jpg", 0, h))
    if not midias:
        video = item.get("video") or {}
        candidatos = [video.get("playAddr"), *(_pegar(video, "play_addr", "url_list") or []), video.get("downloadAddr")]
        for br in video.get("bitrateInfo") or []:
            candidatos.extend(_pegar(br, "PlayAddr", "UrlList") or [])
        escolha = next((c for c in candidatos if isinstance(c, str) and c.startswith("http") and "verify" not in c), "")
        if escolha:
            midias.append(Midia(escolha, "video", "mp4", video.get("height") or 0, h))
    if not midias:
        raise NativoFalhou("TikTok sem mídia disponível.")
    return Resultado(titulo, autor, thumb, midias)


# ── Pinterest ────────────────────────────────────────────────────────────────

def pinterest(url: str) -> Resultado:
    http = _Http()
    if (urllib.parse.urlparse(url).hostname or "").endswith("pin.it"):
        url = http.resolver(url)
    m = re.search(r"/pin/(?:[^/]*--)?(\d+)", url)
    if not m:
        raise NativoFalhou("Link do Pinterest sem id de pin.")
    status, html, _ = http.pedir(f"https://www.pinterest.com/pin/{m.group(1)}/", {"Accept": "text/html"})
    if re.search(r'"__typename"\s*:\s*"PinNotFound"', html or ""):
        raise NativoFalhou("Pin não encontrado.")
    titulo = ""
    tm = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.S)
    if tm:
        titulo = re.sub(r"\s+", " ", tm.group(1)).replace(" | Pinterest", "").strip()
    videos = [v for v in re.findall(r'"url":"(https://v1\.pinimg\.com/videos/.*?)"', html or "") if v.endswith(".mp4")]
    if videos:
        return Resultado(titulo, "", "", [Midia(videos[0].replace("\\/", "/"), "video", "mp4")])
    imagens = re.findall(r'(https://i\.pinimg\.com/[^"\s]+?\.(?:jpg|jpeg|png|gif|webp))', html or "")
    if imagens:
        melhor = next((i for i in imagens if "/originals/" in i), next((i for i in imagens if "1200x" in i), imagens[0]))
        return Resultado(titulo, "", melhor, [Midia(melhor, "gif" if melhor.endswith(".gif") else "imagem", _ext_de(melhor, "jpg"))])
    raise NativoFalhou(f"Pinterest sem mídia no pin (HTTP {status}).")


# ── Bluesky ──────────────────────────────────────────────────────────────────

def bluesky(url: str) -> Resultado:
    segs = _segs(url)
    if len(segs) < 4 or segs[0] != "profile" or segs[2] != "post":
        raise NativoFalhou("Link do Bluesky sem post.")
    http = _Http()
    uri = f"at://{segs[1]}/app.bsky.feed.post/{segs[3]}"
    status, dados = http.json("https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?depth=0&parentHeight=0&uri="
                              + urllib.parse.quote(uri, safe=""))
    post = _pegar(dados, "thread", "post")
    if status != 200 or not post:
        raise NativoFalhou("Post do Bluesky não está disponível.")
    autor = _pegar(post, "author", "displayName") or _pegar(post, "author", "handle") or ""
    texto = (_pegar(post, "record", "text") or "").strip()[:90]
    embed = post.get("embed") or {}
    if embed.get("$type", "").startswith("app.bsky.embed.recordWithMedia"):
        embed = embed.get("media") or {}
    midias = []
    tipo = embed.get("$type", "")
    if "video" in tipo and embed.get("playlist"):
        lista = embed["playlist"].replace("video.bsky.app/watch/", "video.cdn.bsky.app/hls/")
        midias.append(Midia(lista, "video", "mp4", 0, {"Referer": "https://bsky.app/"}, via_ytdlp=True))
    for img in embed.get("images") or []:
        if img.get("fullsize"):
            midias.append(Midia(img["fullsize"], "imagem", "jpg"))
    externo = _pegar(embed, "external", "uri") or ""
    if not midias and "media.tenor.com" in externo:
        midias.append(Midia(externo.split("?")[0], "gif", _ext_de(externo.split("?")[0], "gif")))
    if not midias:
        raise NativoFalhou("Post do Bluesky sem mídia.")
    return Resultado(f"{autor} - {texto}" if autor and texto else (texto or autor), autor,
                     embed.get("thumbnail") or _pegar(embed, "images", 0, "thumb") or "", midias)


# ── Threads ──────────────────────────────────────────────────────────────────

def threads(url: str) -> Resultado:
    http = _Http()
    segs = _segs(url)
    if segs and segs[0] == "share":
        http.ua = "curl/7.88.1"
        url = http.resolver(url)
        http.ua = UA_CHROME
        segs = _segs(url)
    code = ""
    if len(segs) >= 3 and segs[1] == "post":
        code = segs[2]
    elif len(segs) >= 2 and segs[0] == "t":
        code = segs[1]
    if not code:
        raise NativoFalhou("Link do Threads sem id de post.")
    canonico = f"https://www.threads.com/{segs[0]}/post/{code}" if segs[0].startswith("@") else f"https://www.threads.com/t/{code}"
    for ua in (UA_CHROME, UA_GOOGLEBOT):
        http.ua = ua
        _, html, _ = http.pedir(canonico)
        post = _threads_post(html or "", code)
        if post:
            break
    else:
        raise NativoFalhou("Não deu para ler o post do Threads: pode ser privado ou ter sido apagado.")
    if post.get("media_type") == 19:
        post = _pegar(post, "text_post_app_info", "linked_inline_media") or \
            _pegar(post, "text_post_app_info", "share_info", "quoted_post") or \
            _pegar(post, "text_post_app_info", "share_info", "reposted_post") or post
    midias = []
    for item in post.get("carousel_media") or [post]:
        if item.get("video_versions"):
            v = min(item["video_versions"], key=lambda x: x.get("type") or 0)
            midias.append(Midia(v["url"], "video", "mp4", item.get("original_height") or 0, {"Referer": "https://www.threads.com/"}))
        else:
            cands = _pegar(item, "image_versions2", "candidates") or []
            if cands:
                img = max(cands, key=lambda c: (c.get("width") or 0) * (c.get("height") or 0))
                midias.append(Midia(img["url"], "imagem", _ext_de(img["url"], "jpg"), 0, {"Referer": "https://www.threads.com/"}))
    if not midias:
        raise NativoFalhou("Post do Threads sem mídia.")
    autor = _pegar(post, "user", "username") or ""
    texto = (_pegar(post, "caption", "text") or "").strip()[:90]
    return Resultado(f"{autor} - {texto}" if autor and texto else (texto or autor), autor, "", midias)


def _threads_post(html: str, code: str):
    for bloco in re.findall(r"<script[^>]*data-sjs[^>]*>(.*?)</script>", html, re.S):
        if code not in bloco:
            continue
        try:
            dados = json.loads(bloco)
        except ValueError:
            continue
        pilha = [dados]
        while pilha:
            atual = pilha.pop()
            if isinstance(atual, dict):
                if atual.get("code") == code and any(k in atual for k in ("video_versions", "image_versions2", "carousel_media", "text_post_app_info")):
                    return atual
                pilha.extend(atual.values())
            elif isinstance(atual, list):
                pilha.extend(atual)
    return None


# ── Twitch (clipes) ──────────────────────────────────────────────────────────

_TWITCH_CLIENT = "kimne78kx3ncx6brgo4mv6wki5h1ko"


def eh_clipe_twitch(url: str) -> bool:
    host = urllib.parse.urlparse(url).hostname or ""
    return host == "clips.twitch.tv" or "/clip/" in url


def twitch_clipe(url: str, limite_altura: int = 0) -> Resultado:
    segs = _segs(url)
    slug = segs[0] if (urllib.parse.urlparse(url).hostname or "") == "clips.twitch.tv" and segs else \
        (segs[segs.index("clip") + 1] if "clip" in segs and segs.index("clip") + 1 < len(segs) else "")
    if not slug:
        raise NativoFalhou("Link de clipe da Twitch sem id.")
    http = _Http()
    h = {"client-id": _TWITCH_CLIENT, "Content-Type": "application/json"}
    consulta = ('{ clip(slug: "%s") { broadcaster { login } durationSeconds id medium: thumbnailURL(width: 480, height: 272) '
                'title videoQualities { quality sourceURL } } }' % slug)
    _, dados = http.json("https://gql.twitch.tv/gql", h, json.dumps({"query": consulta}).encode())
    clipe = _pegar(dados, "data", "clip")
    if not clipe or not clipe.get("videoQualities"):
        raise NativoFalhou("Clipe da Twitch não encontrado.")
    _, token = http.json("https://gql.twitch.tv/gql", h, json.dumps([{
        "operationName": "VideoAccessToken_Clip", "variables": {"slug": slug},
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": "36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11"}},
    }]).encode())
    acesso = _pegar(token, 0, "data", "clip", "playbackAccessToken") or {}
    qualidades = sorted(clipe["videoQualities"], key=lambda q: int(re.sub(r"\D", "", q.get("quality") or "0") or 0), reverse=True)
    escolha = next((q for q in qualidades if not limite_altura or int(re.sub(r"\D", "", q.get("quality") or "0") or 0) <= limite_altura), qualidades[0])
    final = escolha["sourceURL"]
    if acesso.get("signature"):
        final += "?sig=" + urllib.parse.quote(acesso["signature"]) + "&token=" + urllib.parse.quote(acesso.get("value") or "")
    canal = _pegar(clipe, "broadcaster", "login") or ""
    return Resultado(f"{canal} - {clipe.get('title') or slug}" if canal else (clipe.get("title") or slug), canal,
                     clipe.get("medium") or "", [Midia(final, "video", "mp4", int(re.sub(r"\D", "", escolha.get("quality") or "0") or 0))])


# ── Douyin ───────────────────────────────────────────────────────────────────

_douyin_ttwid = ""


def douyin(url: str) -> Resultado:
    global _douyin_ttwid
    http = _Http(UA_IPHONE)
    if (urllib.parse.urlparse(url).hostname or "") == "v.douyin.com":
        url = http.resolver(url)
    m = re.search(r"(?:video|note|slides)/(\d+)", url) or re.search(r"modal_id=(\d+)", url) or re.search(r"(\d{15,})", url)
    if not m:
        raise NativoFalhou("Link do Douyin sem id.")
    vid = m.group(1)
    if not _douyin_ttwid:
        corpo = json.dumps({"region": "cn", "aid": 1768, "needFid": False, "service": "www.ixigua.com",
                            "migrate_info": {"ticket": "", "source": "node"}, "cbUrlProtocol": "https", "union": True}).encode()
        http.pedir("https://ttwid.bytedance.com/ttwid/union/register/", {"Content-Type": "application/json"}, corpo)
        _douyin_ttwid = next((c.value for c in http.jar if c.name == "ttwid"), "")
    _, html, _ = http.pedir(f"https://www.iesdouyin.com/share/video/{vid}/", {"Cookie": f"ttwid={_douyin_ttwid}"})
    m = re.search(r"window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*</script>", html or "", re.S)
    if not m:
        raise NativoFalhou("Vídeo do Douyin indisponível (apagado, privado ou bloqueado por região).")
    try:
        dados = json.loads(m.group(1))
    except ValueError:
        raise NativoFalhou("Douyin mudou o formato da página.")
    item = None
    for valor in (dados.get("loaderData") or {}).values():
        item = _pegar(valor, "videoInfoRes", "item_list", 0)
        if item:
            break
    if not item:
        raise NativoFalhou("Vídeo do Douyin indisponível (apagado, privado ou bloqueado por região).")
    play = _pegar(item, "video", "play_addr", "url_list", 0) or ""
    if not play:
        raise NativoFalhou("Post do Douyin sem vídeo.")
    play = play.replace("/playwm/", "/play/")
    largura = _pegar(item, "video", "width") or 0
    altura = _pegar(item, "video", "height") or 0
    if max(largura, altura) >= 1080:
        play = play.replace("ratio=720p", "ratio=1080p")
    autor = _pegar(item, "author", "nickname") or ""
    texto = (item.get("desc") or "").strip()[:90]
    return Resultado(f"{autor} - {texto}" if autor and texto else (texto or autor or vid), autor,
                     _pegar(item, "video", "cover", "url_list", 0) or "",
                     [Midia(play, "video", "mp4", altura, {"User-Agent": UA_IPHONE, "Referer": "https://www.iesdouyin.com/"})])


# ── Registro ─────────────────────────────────────────────────────────────────

# chave da plataforma → (função, nativo antes do yt-dlp?). Instagram e TikTok: o yt-dlp costuma
# funcionar e traz mais metadados, então o nativo é reserva; nos demais o nativo vem primeiro.
EXTRATORES = {
    "twitter": (twitter, True),
    "reddit": (reddit, True),
    "pinterest": (pinterest, True),
    "bluesky": (bluesky, True),
    "threads": (threads, True),
    "douyin": (douyin, True),
    "instagram": (instagram, False),
    "tiktok": (tiktok, False),
}


def extrator_para(chave_plataforma: str, url: str):
    """(função, primeiro?) ou (None, False)."""
    if chave_plataforma == "twitch":
        return (twitch_clipe, True) if eh_clipe_twitch(url) else (None, False)
    return EXTRATORES.get(chave_plataforma, (None, False))
