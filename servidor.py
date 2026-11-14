#!/usr/bin/env python3
"""
servidor.py — backend do Cachalot (antigo VDGET): WebSocket + fila inteligente de downloads.

Motores, escolhidos por `fontes.py` e encadeados como reserva um do outro:
  yt-dlp (1800+ sites) · extratores nativos (X, Reddit, Instagram, TikTok, Pinterest, Bluesky, Threads,
  Twitch, Douyin) · gallery-dl (galerias e perfis) · HTTP direto segmentado · torrent/magnet (libtorrent) ·
  navegador headless (sniffer.py, players blob/MSE).

Fila: N downloads ao mesmo tempo, limite e intervalo por site, novas tentativas com espera para falhas
transitórias, pausar/retomar/cancelar de verdade. Nada roda à toa: o agendador só acorda por evento
(novo item, item terminou, espera vencida).

Instale dependências: pip install websockets "yt-dlp[default,curl-cffi]"
"""

import asyncio
import glob
import hashlib
import json
import os
import platform
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime
from urllib.parse import unquote, urlparse

# Quando o stdout não é um console real (Popen com DEVNULL/PIPE, saída redirecionada), o Python herda a
# codepage ANSI do Windows e os prints com acentos derrubam o processo. Ver ERRORS.md.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ── Auto-instala dependências ─────────────────────────────────────────────────
def instalar(pacote):
    subprocess.check_call([sys.executable, "-m", "pip", "install", pacote, "-q"])


try:
    import websockets
except ImportError:
    print("[*] Instalando websockets...")
    instalar("websockets")
    import websockets

try:
    import yt_dlp
    from yt_dlp.utils import DownloadCancelled
except ImportError:
    print("[*] Instalando yt-dlp...")
    instalar("yt-dlp[default,curl-cffi]")
    import yt_dlp
    from yt_dlp.utils import DownloadCancelled

import dependencias
import diagnostico
import direto
import fontes
import galerias
import nativos
import opcoes_ytdlp
import torrents

# Fallback headless (blob/MSE) — não importa Playwright aqui em cima (ver sniffer.py).
try:
    import sniffer
except Exception as _e_sniffer:
    print(f"[!] sniffer.py indisponível ({_e_sniffer}); fallback headless desativado.")
    sniffer = None

SNIFFER_HABILITADO = os.environ.get("VDGET_SNIFFER", "1") != "0"

# Modo hospedado (módulo do SwissTechKnife): sem consola nem navegador; nunca mata janelas do avulso.
MODO_HOSPEDADO = os.environ.get("VDGET_HOSTED", "0") == "1"


def _int_env(nome: str, padrao: int) -> int:
    try:
        return int(os.environ.get(nome, "") or padrao)
    except ValueError:
        return padrao


ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*m")


def strip_ansi(text) -> str:
    if text is None:
        return ""
    return ANSI_ESCAPE.sub("", str(text)).strip()


def melhor_thumbnail(info: dict | None) -> str:
    """URL da melhor miniatura disponível no dict retornado pelo yt-dlp."""
    if not info:
        return ""
    t = (info.get("thumbnail") or "").strip()
    if t:
        return t
    thumbs = info.get("thumbnails") or []
    if not thumbs:
        return ""

    def area(th):
        try:
            return int(th.get("width") or 0) * int(th.get("height") or 0)
        except (TypeError, ValueError):
            return 0

    return (max(thumbs, key=area).get("url") or "").strip()


def _str_lista_ou_valor(val) -> str:
    if val is None or isinstance(val, bool):
        return ""
    if isinstance(val, str):
        return val.strip()
    if isinstance(val, (list, tuple)):
        partes = [str(x).strip() for x in val if str(x).strip()]
        return ", ".join(partes) if partes else ""
    return str(val).strip()


# Primeiro segmento do path em soundcloud.com/{usuario}/… (não é o nome do artista)
_SOUNDCLOUD_PATH_RESERVADO = frozenset({
    "discover", "charts", "pages", "you", "feed", "likes", "popular",
    "stations", "upload", "search", "imprint", "terms-of-use", "community-guidelines",
})


def artista_soundcloud_por_url(url: str) -> str:
    """Extrai o usuário/perfil do link do SoundCloud quando os metadados vêm vazios."""
    if not url or "soundcloud.com" not in url.lower():
        return ""
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return ""
    host = (parsed.netloc or "").lower().split(":")[0]
    if "soundcloud.com" not in host:
        return ""
    partes = [unquote(p) for p in parsed.path.strip("/").split("/") if p]
    if not partes:
        return ""
    user = partes[0].strip()
    if not user or user.lower() in _SOUNDCLOUD_PATH_RESERVADO:
        return ""
    if user.islower() or (user.isascii() and user.isalpha() and user.isupper()):
        user = user.title()
    return user


def _urls_para_fallback_artista(info: dict, url_na_fila: str) -> list[str]:
    ordem: list[str] = []
    if info:
        for chave in ("uploader_url", "webpage_url", "original_url", "url"):
            v = (info.get(chave) or "").strip()
            if v:
                ordem.append(v)
    v = (url_na_fila or "").strip()
    if v and v not in ordem:
        ordem.append(v)
    return ordem


def extrair_artista_metadata(info: dict, url_na_fila: str = "") -> str:
    """Tenta obter o artista a partir dos campos que o yt-dlp preenche por plataforma."""
    info = info or {}
    for chave in ("artist", "album_artist", "artists", "creator", "creators", "composer"):
        s = _str_lista_ou_valor(info.get(chave))
        if s:
            return s
    s = (info.get("uploader") or "").strip()
    if s and s not in ("Unknown", "N/A"):
        return s
    s = (info.get("channel") or "").strip()
    if s and s not in ("Unknown", "-", "N/A"):
        return s
    for u in _urls_para_fallback_artista(info, url_na_fila):
        sc = artista_soundcloud_por_url(u)
        if sc:
            return sc
    return ""


def _separador_titulo_musica():
    return r"[-–—‒:｜|]+"


def _titulo_sem_prefixo_artista(artista: str, faixa: str) -> str:
    """Se a faixa começa com o mesmo artista + separador, devolve só o nome da música."""
    if not artista or not faixa:
        return faixa.strip() if faixa else ""
    a, f = artista.strip(), faixa.strip()
    if not a or not f:
        return f
    novo = re.sub(r"^" + re.escape(a) + r"\s*" + _separador_titulo_musica() + r"\s*", "", f, flags=re.IGNORECASE)
    return (novo.strip() or f) if novo != f else f


def _inferir_artista_faixa_pelo_titulo(titulo: str) -> tuple[str, str]:
    """Quando não há artista nos metadados: 'Autor - Nome' no próprio título (ex.: YouTube)."""
    t = (titulo or "").strip()
    if not t:
        return "", ""
    m = re.match(r"^(.+?)\s*" + _separador_titulo_musica() + r"\s+(.+)$", t)
    if not m:
        return "", t
    art, rest = m.group(1).strip(), m.group(2).strip()
    if not art or not rest:
        return "", t
    return art, rest


def titulo_audio_exibicao(info: dict | None, url_fallback: str) -> str:
    """Título para downloads só áudio: 'Artista - Nome do som', sem repetir artista."""
    if not info:
        return url_fallback
    titulo_bruto = (info.get("title") or "").strip()
    faixa_meta = (info.get("track") or "").strip()
    faixa = faixa_meta or titulo_bruto or url_fallback
    artista = extrair_artista_metadata(info, url_fallback)
    if not artista:
        a_inf, f_inf = _inferir_artista_faixa_pelo_titulo(titulo_bruto)
        if a_inf:
            artista = a_inf
            if not faixa_meta:
                faixa = _titulo_sem_prefixo_artista(artista, f_inf) or f_inf
    else:
        faixa = _titulo_sem_prefixo_artista(artista, faixa) or faixa
    return f"{artista} - {faixa}".strip() if artista else (faixa or url_fallback)


_INVALIDOS_NOME_ARQ = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitizar_nome_arquivo(nome: str, max_len: int = 200) -> str:
    """Remove caracteres proibidos e limita o tamanho para salvar em disco."""
    s = _INVALIDOS_NOME_ARQ.sub("", (nome or "").strip())
    s = re.sub(r"\s+", " ", s).strip().rstrip(". ")
    if len(s) > max_len:
        s = s[:max_len].rstrip(". ")
    return s or "audio"


def _formato_tem_video_util(f: dict) -> bool:
    """Vídeo com resolução mínima (ignora capas / artefatos minúsculos)."""
    if (f.get("vcodec") or "none").lower() in ("none", "", "unknown"):
        return False
    try:
        return int(f.get("width") or 0) >= 160 and int(f.get("height") or 0) >= 160
    except (TypeError, ValueError):
        return False


def info_e_somente_audio(info: dict | None) -> bool:
    """True se o item não tiver faixa de vídeo útil (só música / áudio)."""
    if not info or info.get("_type") == "playlist":
        return False
    ex = (info.get("extractor") or "").lower()
    if "soundcloud" in ex or "bandcamp" in ex:
        return True
    formats = info.get("formats") or []
    if not formats:
        vc = (info.get("vcodec") or "none").lower()
        ac = (info.get("acodec") or "none").lower()
        return ac != "none" and vc == "none"
    return not any(_formato_tem_video_util(f) for f in formats)


# ── Estado global ─────────────────────────────────────────────────────────────
_DIR_SERVIDOR = os.path.dirname(os.path.abspath(__file__))
PASTA_DOWNLOAD_PADRAO = os.environ.get("VDGET_DOWNLOADS") or os.path.join(_DIR_SERVIDOR, "downloads")
PASTA_DADOS = os.environ.get("VDGET_DATA") or _DIR_SERVIDOR

downloads: dict[str, dict] = {}       # id -> dados públicos (vão para a interface)
controles: dict[str, "Controle"] = {}  # id -> estado de execução (nunca serializado)
clientes: set = set()
_shutdown: asyncio.Event | None = None
_loop: asyncio.AbstractEventLoop | None = None

# Configuração global (mensagem "configurar", repetida em cada "adicionar"). Ver opcoes_ytdlp.PADROES
# para as opções de cada download; as chaves abaixo são da fila e dos motores.
CONFIG_PADRAO = {
    "simultaneos": 3,
    "tentativas": 3,
    "regras": [],
    "organizar_por_plataforma": False,
    "playlist_inteira": False,
    "limite_playlist": 200,
    "playlist_em_pasta": True,
    "limite_galeria": 0,
    "usar_nativos": True,
    "usar_galeria": True,
    "usar_navegador": True,
    "torrent_porta": 6881,
    "torrent_upnp": True,
    "torrent_trackers": True,
}
config: dict = {**opcoes_ytdlp.PADROES, **CONFIG_PADRAO}

# Por site: (downloads ao mesmo tempo, intervalo mínimo entre inícios em s). Mesmos números do OmniGet.
_LIMITES_SITE = {"youtube": (2, 1.5), "instagram": (2, 2.0), "tiktok": (2, 1.5), "twitter": (2, 1.5), "reddit": (3, 1.0)}
_LIMITE_SITE_PADRAO = (4, 0.0)
ESPACO_MINIMO_BYTES = 300 * 1024 * 1024

# Encerramento automático após N s sem atividade (com a interface já conectada). 0 desliga.
SEGUNDOS_INATIVIDADE_SEM_DOWNLOAD = float(_int_env("VDGET_IDLE_SECONDS", 180))
_t_mono_ultima_atividade_download = 0.0
_houve_cliente_ws_para_inatividade = False

ATIVOS = ("pendente", "analisando", "baixando", "processando")


class Controle:
    """O que só o backend precisa saber sobre um download em execução."""

    def __init__(self, opcoes: dict):
        self.opcoes = opcoes
        self.sinal: str | None = None        # "pausar" | "cancelar"
        self.motor = None                    # objeto com parar()/cancelar() (direto, galeria, torrent)
        self.tmp: set[str] = set()           # arquivos parciais do yt-dlp (apagados ao cancelar)
        self.tentativas = 0
        self.bytes_baixados = 0
        self.agendado_ts = 0.0
        self.tarefa: asyncio.Task | None = None
        self.via_sniffer = False
        self.nativo_tentado = False
        self.destino = ""
        self.retomar_apos_pausa = False


def marcar_atividade_download_servidor() -> None:
    global _t_mono_ultima_atividade_download
    _t_mono_ultima_atividade_download = time.monotonic()


def _downloads_com_transferencia_ativa() -> bool:
    return any(v.get("status") in ATIVOS for v in downloads.values())


def publico(dl: dict) -> dict:
    return {k: v for k, v in dl.items() if not k.startswith("_")}


async def broadcast(mensagem: dict):
    if clientes:
        dados = json.dumps(mensagem, ensure_ascii=False, default=str)
        await asyncio.gather(*[ws.send(dados) for ws in clientes], return_exceptions=True)


def broadcast_de_thread(mensagem: dict) -> None:
    if _loop and not _loop.is_closed():
        asyncio.run_coroutine_threadsafe(broadcast(mensagem), _loop)


async def atualizar(dl_id: str, **campos) -> None:
    dl = downloads.get(dl_id)
    if dl is None:
        return
    dl.update(campos)
    await broadcast({"tipo": "atualizar", "download": publico(dl)})


def atualizar_de_thread(dl_id: str, **campos) -> None:
    dl = downloads.get(dl_id)
    if dl is None:
        return
    dl.update(campos)
    broadcast_de_thread({"tipo": "atualizar", "download": publico(dl)})


async def avisar(mensagem: str, nivel: str = "info") -> None:
    await broadcast({"tipo": "aviso", "mensagem": mensagem, "nivel": nivel})


def _bytes_legiveis(n: float) -> str:
    n = float(n or 0)
    for unidade in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024 or unidade == "TiB":
            return f"{n:.1f}{unidade}" if unidade != "B" else f"{int(n)}B"
        n /= 1024
    return ""


def _eta(restante: float, velocidade: float) -> str:
    if velocidade <= 0 or restante <= 0:
        return ""
    s = int(restante / velocidade)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


class Medidor:
    """Velocidade média móvel para motores que não calculam a própria (HTTP direto, nativos)."""

    def __init__(self):
        self.t = time.monotonic()
        self.feito = 0
        self.vel = 0.0

    def medir(self, feito: int) -> float:
        agora = time.monotonic()
        dt = agora - self.t
        if dt >= 0.5:
            inst = (feito - self.feito) / dt
            self.vel = inst if self.vel == 0 else 0.7 * self.vel + 0.3 * inst
            self.t, self.feito = agora, feito
        return self.vel


# ── Arquivos ──────────────────────────────────────────────────────────────────
def caminho_arquivo_baixado(ydl, info, exts_audio: tuple[str, ...] | None = None) -> str:
    """Resolve o caminho final no disco após o yt-dlp (inclui pós-processamento de áudio)."""
    if not info:
        return ""
    for rd in info.get("requested_downloads") or []:
        fp = rd.get("filepath")
        if fp and os.path.isfile(fp):
            return os.path.abspath(fp)
    fp = info.get("filepath")
    if fp and os.path.isfile(fp):
        return os.path.abspath(fp)
    try:
        prepared = ydl.prepare_filename(info)
    except Exception:
        prepared = ""
    if prepared and os.path.isfile(prepared):
        return os.path.abspath(prepared)
    if prepared:
        stem, _ = os.path.splitext(prepared)
        for ext in (exts_audio or ()) + (".mp4", ".mkv", ".webm", ".m4a", ".opus", ".mp3", ".ogg", ".wav", ".flac"):
            if os.path.isfile(stem + ext):
                return os.path.abspath(stem + ext)
    return ""


def revelar_pasta_do_arquivo(caminho_arquivo: str) -> bool:
    if not caminho_arquivo or not os.path.isfile(caminho_arquivo):
        return False
    caminho_arquivo = os.path.abspath(caminho_arquivo)
    system = platform.system()
    if system == "Windows":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(caminho_arquivo)], shell=False)
        return True
    if system == "Darwin":
        subprocess.run(["open", "-R", caminho_arquivo], check=False)
        return True
    pasta = os.path.dirname(caminho_arquivo)
    if os.path.isdir(pasta):
        subprocess.run(["xdg-open", pasta], check=False)
        return True
    return False


def abrir_pasta(pasta: str) -> bool:
    if not pasta or not os.path.isdir(pasta):
        return False
    pasta = os.path.abspath(pasta)
    if platform.system() == "Windows":
        os.startfile(pasta)
    elif platform.system() == "Darwin":
        subprocess.run(["open", pasta], check=False)
    else:
        subprocess.run(["xdg-open", pasta], check=False)
    return True


# Extensões que o Cachalot de fato produz. Caminho vindo do cliente só é aberto com o app padrão se casar
# com esta lista — evita que uma página local transforme o servidor num "abra este .exe pra mim".
_EXTS_MIDIA_ABRIVEL = frozenset({
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".flv", ".ts",
    ".mp3", ".m4a", ".opus", ".ogg", ".oga", ".wav", ".flac", ".aac", ".wma",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf", ".epub",
})


def caminho_midia_do_cliente(caminho: str) -> str:
    c = (caminho or "").strip()
    if not c:
        return ""
    try:
        c = os.path.abspath(c)
    except (OSError, ValueError):
        return ""
    if not os.path.isfile(c) or os.path.splitext(c)[1].lower() not in _EXTS_MIDIA_ABRIVEL:
        return ""
    return c


def abrir_arquivo_com_app_padrao(caminho: str) -> bool:
    if not caminho or not os.path.isfile(caminho):
        return False
    caminho = os.path.abspath(caminho)
    if platform.system() == "Windows":
        os.startfile(caminho)
    elif platform.system() == "Darwin":
        subprocess.run(["open", caminho], check=False)
    else:
        subprocess.run(["xdg-open", caminho], check=False)
    return True


def _subprocess_flags_windows_silencioso() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


# ── Cookies ───────────────────────────────────────────────────────────────────
NAVEGADORES_COOKIES = ("firefox", "edge", "chrome", "brave", "opera", "vivaldi", "chromium")


def cookies_gerenciados(url: str) -> str:
    """cookies/<domínio>.txt importado nas configurações (por site), quando existe."""
    host = fontes.host_de(url)
    raiz = fontes.dominio_raiz(host)
    pasta = os.path.join(PASTA_DADOS, "cookies")
    candidatos = [raiz]
    if raiz in ("youtu.be", "youtube-nocookie.com"):
        candidatos.append("youtube.com")
    if raiz in ("x.com", "twitter.com"):
        candidatos += ["x.com", "twitter.com"]
    for c in candidatos:
        p = os.path.join(pasta, c + ".txt")
        if os.path.isfile(p):
            return p
    return ""


def cookies_para(url: str, o: dict) -> dict:
    gerenciado = cookies_gerenciados(url)
    if gerenciado:
        return {"arquivo": gerenciado}
    if o.get("cookies_arquivo") and os.path.isfile(o["cookies_arquivo"]):
        return {"arquivo": o["cookies_arquivo"]}
    if o.get("cookies_navegador"):
        return {"navegador": o["cookies_navegador"]}
    return {}


def cookie_header_de_arquivo(caminho: str, dominio: str) -> str:
    """Linha 'Cookie:' a partir de um cookies.txt (formato Netscape) para os extratores nativos."""
    if not caminho:
        return ""
    pares = []
    try:
        with open(caminho, encoding="utf-8", errors="replace") as f:
            for linha in f:
                if linha.startswith("#HttpOnly_"):
                    linha = linha[len("#HttpOnly_"):]
                if not linha.strip() or linha.startswith("#"):
                    continue
                partes = linha.rstrip("\n").split("\t")
                if len(partes) >= 7 and partes[0].lstrip(".").endswith(dominio):
                    pares.append(f"{partes[5]}={partes[6]}")
    except OSError:
        return ""
    return "; ".join(pares)


def caminhos_cookies_txt() -> list[str]:
    return [os.path.join(p, "cookies.txt") for p in (PASTA_DADOS, _DIR_SERVIDOR)
            if p and os.path.isfile(os.path.join(p, "cookies.txt"))]


# ── Atualização automática do yt-dlp (no máximo 1x por dia, em segundo plano) ─
INTERVALO_ATUALIZACAO_YTDLP_S = 24 * 3600


def atualizar_yt_dlp_em_segundo_plano() -> None:
    if os.environ.get("VDGET_AUTO_UPDATE", "1") == "0":
        return
    marca = os.path.join(PASTA_DADOS, ".ytdlp_update")
    try:
        if time.time() - os.path.getmtime(marca) < INTERVALO_ATUALIZACAO_YTDLP_S:
            return
    except OSError:
        pass

    def _atualizar():
        try:
            r = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-U", "-q", "--disable-pip-version-check", "yt-dlp[default,curl-cffi]"],
                capture_output=True, text=True, timeout=600, creationflags=_subprocess_flags_windows_silencioso(),
            )
            if r.returncode == 0:
                with open(marca, "w", encoding="utf-8") as f:
                    f.write(datetime.now().isoformat())
                print("[*] yt-dlp verificado/atualizado (vale no próximo início).")
            else:
                print(f"[!] Falha ao atualizar yt-dlp: {(r.stderr or '').strip()[:300]}")
        except Exception as e_upd:
            print(f"[!] Falha ao atualizar yt-dlp: {e_upd}")

    threading.Thread(target=_atualizar, name="ytdlp-update", daemon=True).start()


# SHA-256 (8 bytes) de ie_key de extractors que exigem impersonate antecipado
_IE_KEY_IMPERSONATE_PREFIXOS = frozenset({bytes.fromhex("69b450ac6db385cf")})


def url_exige_impersonate_browser(url: str) -> bool:
    try:
        for ie in yt_dlp.extractor.gen_extractors():
            if ie.suitable(url):
                if hashlib.sha256(ie.ie_key().encode()).digest()[:8] in _IE_KEY_IMPERSONATE_PREFIXOS:
                    return True
                if ie.ie_key() != "Generic":
                    return False
    except Exception:
        pass
    return False


def impersonate_disponivel() -> bool:
    try:
        import curl_cffi  # noqa: F401
        return True
    except Exception:
        try:
            instalar("curl-cffi")
            return True
        except Exception:
            return False


# ── Encerramento ──────────────────────────────────────────────────────────────
def matar_instancias_terminal_vdget_windows():
    """Encerra janelas do launcher avulso (cmd em pause) e outros Python deste servidor. Nunca no modo hospedado."""
    if platform.system() != "Windows" or MODO_HOSPEDADO:
        return
    fl = _subprocess_flags_windows_silencioso()
    for titulo in ("VDGET - Gerenciador de Downloads", "VDGET Servidor"):
        subprocess.run(["taskkill", "/FI", f"WINDOWTITLE eq {titulo}", "/F"], capture_output=True, creationflags=fl)
    script_path = os.path.abspath(__file__)
    controlador_path = os.path.join(os.path.dirname(script_path), "controlador.py")
    ps_body = (
        "$ErrorActionPreference = 'SilentlyContinue'\n"
        f"$me = {os.getpid()}\n"
        f"$p = @'\n{script_path}\n'@\n"
        f"$pc = @'\n{controlador_path}\n'@\n"
        "Get-CimInstance Win32_Process | Where-Object {\n"
        "  $_.CommandLine -and $_.ProcessId -ne $me -and\n"
        "  ($_.CommandLine.Contains($p) -or $_.CommandLine.Contains($pc))\n"
        "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\n"
    )
    fd, ps_path = tempfile.mkstemp(suffix=".ps1", text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig", newline="\n") as f:
            f.write(ps_body)
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps_path],
                       capture_output=True, creationflags=fl)
    finally:
        try:
            os.unlink(ps_path)
        except OSError:
            pass


async def disparar_encerramento_vdget() -> None:
    ev = _shutdown
    if not ev or ev.is_set():
        return
    await broadcast({"tipo": "servidor_encerrando"})
    if sniffer is not None:
        try:
            await asyncio.wait_for(sniffer.encerrar(), timeout=15)
        except Exception:
            pass
    matar_instancias_terminal_vdget_windows()
    ev.set()


async def watchdog_inatividade_sem_download() -> None:
    while True:
        await asyncio.sleep(1)
        ev = _shutdown
        if ev is None or ev.is_set():
            return
        if SEGUNDOS_INATIVIDADE_SEM_DOWNLOAD <= 0 or not _houve_cliente_ws_para_inatividade:
            continue
        if _downloads_com_transferencia_ativa():
            continue
        if time.monotonic() - _t_mono_ultima_atividade_download < SEGUNDOS_INATIVIDADE_SEM_DOWNLOAD:
            continue
        await disparar_encerramento_vdget()
        return


# ── Fila ──────────────────────────────────────────────────────────────────────
def chave_site(url: str) -> str:
    chave, _ = fontes.plataforma(url)
    if chave and chave not in ("galeria", "torrent"):
        return chave
    if chave == "torrent":
        return "torrent:" + url[:60]
    return fontes.dominio_raiz(fontes.host_de(url)) or "?"


class Agendador:
    """Inicia downloads pendentes respeitando o limite global, o limite por site e o intervalo por site."""

    def __init__(self):
        self._acordar = asyncio.Event()
        self.rodando: dict[str, str] = {}          # id -> chave do site
        self._ultimo_inicio: dict[str, float] = {}
        self._despertador: asyncio.TimerHandle | None = None

    def acordar(self):
        self._acordar.set()

    async def laco(self):
        while True:
            await self._acordar.wait()
            self._acordar.clear()
            try:
                await self._despachar()
            except Exception as e:
                print(f"[!] agendador: {type(e).__name__}: {e}")

    async def _despachar(self):
        maximo = max(1, min(10, int(config.get("simultaneos") or 3)))
        proximo: float | None = None
        for dl_id in list(downloads.keys()):
            if len(self.rodando) >= maximo:
                break
            dl, ctl = downloads.get(dl_id), controles.get(dl_id)
            if not dl or not ctl or dl.get("status") != "pendente" or dl_id in self.rodando:
                continue
            agora = time.time()
            if ctl.agendado_ts > agora:
                proximo = min(proximo or ctl.agendado_ts, ctl.agendado_ts)
                continue
            site = chave_site(dl["url"])
            limite, intervalo = _LIMITES_SITE.get(site, _LIMITE_SITE_PADRAO)
            if sum(1 for s in self.rodando.values() if s == site) >= limite:
                continue
            livre_em = self._ultimo_inicio.get(site, 0) + intervalo
            if livre_em > agora:
                proximo = min(proximo or livre_em, livre_em)
                continue
            self.rodando[dl_id] = site
            self._ultimo_inicio[site] = agora
            ctl.tarefa = asyncio.create_task(self._executar(dl_id))
            await asyncio.sleep(0.15)
        if self._despertador:
            self._despertador.cancel()
            self._despertador = None
        if proximo is not None:
            atraso = max(0.05, proximo - time.time())
            self._despertador = asyncio.get_running_loop().call_later(atraso, self.acordar)

    async def _executar(self, dl_id: str):
        try:
            await executar_download(dl_id)
        except Exception as e:
            print(f"[!] download {dl_id} quebrou: {type(e).__name__}: {e}")
            if dl_id in downloads and downloads[dl_id].get("status") in ATIVOS:
                await atualizar(dl_id, status="erro", erro=f"Interrompido: {e}", progresso=0, finalizado_ts=time.time())
        finally:
            self.rodando.pop(dl_id, None)
            marcar_atividade_download_servidor()
            self.acordar()


fila: Agendador | None = None


def aplicar_regras(url: str, destino: str, o: dict) -> tuple[str, dict]:
    """Primeira regra ativa que casar (site, trecho do link ou plataforma) troca pasta/qualidade/modo."""
    host = fontes.host_de(url)
    chave, nome = fontes.plataforma(url)
    for r in config.get("regras") or []:
        if not r.get("ativo", True):
            continue
        valor = (r.get("valor") or "").strip().lower()
        if not valor:
            continue
        quando = r.get("quando") or "site"
        casou = (
            (quando == "site" and (host == valor.removeprefix("www.") or host.endswith("." + valor.removeprefix("www."))))
            or (quando == "contem" and valor in url.lower())
            or (quando == "plataforma" and valor in (chave, nome.lower()))
        )
        if casou:
            o = dict(o)
            if r.get("modo") in ("video", "audio"):
                o["modo"] = r["modo"]
            if r.get("qualidade"):
                o["qualidade"] = r["qualidade"]
            return (r.get("pasta") or destino), o
    return destino, o


def destino_organizado(destino: str, url: str, o: dict) -> str:
    if not o.get("organizar_por_plataforma"):
        return destino
    chave, nome = fontes.plataforma(url)
    if chave == "torrent":
        nome = "Torrents"
    return os.path.join(destino, sanitizar_nome_arquivo(nome or "Outros", 60)) if nome else destino


def criar_download(url: str, destino: str, o: dict, *, dl_id: str = "", grupo: str = "", titulo: str = "") -> str:
    dl_id = dl_id or str(uuid.uuid4())[:8]
    chave, nome = fontes.plataforma(url)
    modo = o.get("modo", "video")
    qualidade_legada = "audio" if modo == "audio" else ("pior" if o.get("qualidade") == "menor" else "melhor")
    downloads[dl_id] = {
        "id": dl_id,
        "url": url,
        "status": "pendente",
        "qualidade": qualidade_legada,
        "modo": modo,
        "resolucao": str(o.get("qualidade") or "melhor"),
        "destino": destino,
        "progresso": 0,
        "velocidade": "",
        "eta": "",
        "baixado": "",
        "total": "",
        "titulo": titulo or (url[len("ytsearch1:"):] if url.startswith("ytsearch1:") else url),
        "thumb": "",
        "plataforma": nome if chave else "",
        "motor": "",
        "fase": "",
        "grupo": grupo,
        "tentativa": 0,
        "aguardando_ate": 0,
        "dica": "",
        "arquivos": 0,
        "pares": 0,
        "inicio": datetime.now().strftime("%H:%M:%S"),
        "criado_ts": time.time(),
        "fim": "",
        "erro": "",
        "arquivo": "",
    }
    controles[dl_id] = Controle(o)
    return dl_id


def opcoes_de(dados: dict) -> dict:
    """Junta config global + escolhas da página (modo/qualidade). Aceita o protocolo antigo (qualidade=pior/audio)."""
    o = dict(config)
    extra = dados.get("opcoes") or {}
    o.update({k: v for k, v in extra.items() if v is not None})
    legado = dados.get("qualidade")
    if legado == "audio":
        o["modo"] = "audio"
    elif legado == "pior":
        o["modo"], o["qualidade"] = "video", "menor"
    elif legado == "melhor" and "opcoes" not in dados:
        o["modo"], o["qualidade"] = "video", "melhor"
    return o


def ja_na_fila(url: str) -> bool:
    chave = fontes.normalizar_para_comparar(url)
    return any(fontes.normalizar_para_comparar(d["url"]) == chave and d.get("status") in ATIVOS + ("pausado",)
               for d in downloads.values())


# ── Execução de um download ───────────────────────────────────────────────────
class Cancelado(Exception):
    """Pausa ou cancelamento pedido pela interface."""


def _checar_sinal(ctl: Controle):
    if ctl.sinal:
        raise Cancelado(ctl.sinal)


async def executar_download(dl_id: str):
    dl, ctl = downloads.get(dl_id), controles.get(dl_id)
    if not dl or not ctl:
        return
    o = ctl.opcoes
    url = dl["url"]
    destino = dl["destino"] or PASTA_DOWNLOAD_PADRAO
    ctl.destino = destino
    marcar_atividade_download_servidor()
    try:
        os.makedirs(destino, exist_ok=True)
        livre = shutil.disk_usage(destino).free
        if livre < ESPACO_MINIMO_BYTES:
            raise OSError(28, f"Espaço insuficiente: só {_bytes_legiveis(livre)} livres em {destino}")
        await atualizar(dl_id, status="analisando", tentativa=ctl.tentativas, aguardando_ate=0, erro="", dica="", fase="")
        sucesso = await rotear(dl_id, ctl, url, destino, o)
        if dl_id not in downloads:
            return
        if sucesso:
            await atualizar(dl_id, status="concluido", progresso=100, velocidade="", eta="", fase="",
                            fim=datetime.now().strftime("%H:%M:%S"), finalizado_ts=time.time())
    except Cancelado as c:
        await _parar(dl_id, ctl, str(c))
    except Exception as e:
        if dl_id not in downloads:
            return
        if ctl.sinal:  # pediram para parar enquanto uma conexão travava: vale o pedido, não o erro
            await _parar(dl_id, ctl, ctl.sinal)
            return
        texto = mensagem_erro_download(e)
        diag = diagnostico.classificar(texto)
        print(f"[!] {url} falhou ({diag.categoria}): {texto[:300]}")
        maximo = max(0, int(config.get("tentativas") or 0))
        if ctl.bytes_baixados > 5 * 1024 * 1024:
            ctl.tentativas = 0
        if diag.repetir and ctl.tentativas < maximo and not ctl.sinal:
            ctl.tentativas += 1
            espera = min(2 ** (ctl.tentativas - 1), 30) * (5 if diag.categoria == "rate_limited" else 1)
            ctl.agendado_ts = time.time() + espera
            await atualizar(dl_id, status="pendente", progresso=0, velocidade="", eta="", fase="",
                            tentativa=ctl.tentativas, aguardando_ate=ctl.agendado_ts, dica=diag.mensagem)
        else:
            await atualizar(dl_id, status="erro", erro=diag.mensagem if diag.categoria != "unknown" else texto,
                            dica=diag.dica, progresso=0, velocidade="", eta="", fase="", finalizado_ts=time.time())
    finally:
        marcar_atividade_download_servidor()


async def _parar(dl_id: str, ctl: Controle, sinal: str):
    if dl_id not in downloads:
        return
    if sinal == "pausar":
        if ctl.retomar_apos_pausa:  # "retomar" chegou antes de a pausa terminar
            ctl.retomar_apos_pausa = False
            ctl.sinal = None
            await atualizar(dl_id, status="pendente", velocidade="", eta="", fase="")
            if fila:
                fila.acordar()
        else:
            await atualizar(dl_id, status="pausado", velocidade="", eta="", fase="")
    else:
        apagar_parciais(ctl)
        downloads.pop(dl_id, None)
        controles.pop(dl_id, None)
        await broadcast({"tipo": "remover", "id": dl_id})


def mensagem_erro_download(err: BaseException) -> str:
    try:
        from yt_dlp.utils import error_to_str
        texto = error_to_str(err)
    except Exception:
        texto = f"{type(err).__name__}: {err}"
    if not str(err).strip() and isinstance(err, AssertionError):
        texto = "Falha ao configurar impersonate (yt-dlp); precisa de curl_cffi compatível."
    return (texto or type(err).__name__).strip()[:2000]


def apagar_parciais(ctl: Controle):
    """Só o que este download criou: .part/.ytdl/fragmentos do yt-dlp, .part do HTTP, arquivos novos do torrent."""
    pastas = set()
    for base in list(ctl.tmp):
        for p in [base, base + ".part", base + ".ytdl", *glob.glob(glob.escape(base) + "*.part"),
                  *glob.glob(glob.escape(base) + "-Frag*"), *glob.glob(glob.escape(base) + ".part-Frag*")]:
            try:
                if os.path.isfile(p) and (p.endswith((".part", ".ytdl")) or "-Frag" in p or p in ctl.tmp):
                    os.remove(p)
                    pastas.add(os.path.dirname(p))
            except OSError:
                pass
    raiz = os.path.normcase(os.path.abspath(ctl.destino)) if ctl.destino else ""
    for pasta in sorted(pastas, key=len, reverse=True):  # subpastas vazias que o torrent criou, nunca a pasta de destino
        while raiz and os.path.normcase(os.path.abspath(pasta)).startswith(raiz + os.sep):
            try:
                os.rmdir(pasta)
            except OSError:
                break
            pasta = os.path.dirname(pasta)


async def rotear(dl_id: str, ctl: Controle, url: str, destino: str, o: dict) -> bool:
    """Escolhe o motor e encadeia as reservas. True = concluído (False = já tratado, ex.: playlist expandida)."""
    if fontes.eh_magnet(url) or fontes.eh_torrent(url):
        return await baixar_torrent(dl_id, ctl, url, destino, o)
    if url.startswith(("ytsearch", "scsearch")):
        url = await resolver_busca(dl_id, url)
    chave, _ = fontes.plataforma(url)
    if config.get("usar_galeria", True) and fontes.eh_galeria(url) and chave != "youtube":
        try:
            return await baixar_galeria(dl_id, ctl, url, destino, o)
        except Cancelado:
            raise
        except Exception as e:
            print(f"[galeria] {url}: {e}; tentando o yt-dlp.")
    if fontes.eh_arquivo_direto(url) or (not chave and await _sondar_direto(url, o)):
        try:
            return await baixar_direto(dl_id, ctl, url, destino, o)
        except Cancelado:
            raise
        except direto.FalhaDireta as e:
            if "página" in str(e) or not any(c in str(e) for c in ("403", "401", "410", "HTML")):
                raise
            # Servidor que barra clientes simples: o yt-dlp tenta com impersonate, referer e cookies.
            print(f"[direto] {url}: {e}; tentando o yt-dlp.")
            return await baixar_ytdlp(dl_id, ctl, url, destino, o)

    extrator, primeiro = nativos.extrator_para(chave, url) if config.get("usar_nativos", True) else (None, False)
    erro_nativo = None
    if extrator and primeiro and o.get("modo") != "audio":
        try:
            return await baixar_nativo(dl_id, ctl, extrator, url, destino, o)
        except Cancelado:
            raise
        except Exception as e:
            erro_nativo = e
            print(f"[nativo] {chave}: {e}; tentando o yt-dlp.")
    try:
        return await baixar_ytdlp(dl_id, ctl, url, destino, o)
    except Cancelado:
        raise
    except Exception as e_ytdlp:
        texto = mensagem_erro_download(e_ytdlp)
        diag = diagnostico.classificar(texto)
        _checar_sinal(ctl)
        # Reservas, nesta ordem: extrator nativo → gallery-dl → navegador headless. O erro mostrado é
        # sempre o do yt-dlp (o mais informativo), a não ser que o nativo explique melhor (post privado).
        if extrator and not primeiro and not ctl.nativo_tentado:
            try:
                return await baixar_nativo(dl_id, ctl, extrator, url, destino, o)
            except Cancelado:
                raise
            except Exception as e:
                print(f"[nativo] reserva falhou ({chave}): {type(e).__name__}: {e}")
                erro_nativo = erro_nativo or e
        erro_galeria = None
        if (config.get("usar_galeria", True) and diag.categoria in ("unsupported", "format_unavailable", "unknown", "not_found")
                and await asyncio.get_running_loop().run_in_executor(None, galerias.suporta, url)):
            try:
                return await baixar_galeria(dl_id, ctl, url, destino, o)
            except Cancelado:
                raise
            except Exception as e:
                erro_galeria = e
                print(f"[galeria] reserva falhou: {e}")
        if (SNIFFER_HABILITADO and sniffer is not None and config.get("usar_navegador", True) and not ctl.via_sniffer
                and diag.categoria not in ("restricted", "auth_required", "bot_check", "disk_full", "permission", "drm", "copyright")):
            if await tentar_resgate_por_sniffer(dl_id, ctl, url, destino, o):
                return True
        if erro_nativo and isinstance(erro_nativo, nativos.NativoFalhou) and any(
                p in str(erro_nativo).lower() for p in ("privado", "idade", "login", "verificação")):
            raise RuntimeError(str(erro_nativo)) from e_ytdlp
        # Ex.: Instagram sem login responde "There is no video in this post" ao yt-dlp mesmo em post com vídeo;
        # o gallery-dl mostra a causa real (redirecionado para o login).
        if erro_galeria and "login" in str(erro_galeria).lower() and diag.categoria not in ("restricted", "auth_required"):
            nome = fontes.plataforma(url)[1] or "O site"
            raise RuntimeError(f"{nome} pediu login para mostrar este conteúdo.") from e_ytdlp
        raise


async def resolver_busca(dl_id: str, consulta: str) -> str:
    """'ytsearch1:artista música' → link do primeiro resultado (o item passa a mostrar o vídeo achado)."""
    def _buscar():
        opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": "in_playlist",
                "playlistend": 1, "logger": LogYtdlp()}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(consulta, download=False)
        for e in (info or {}).get("entries") or []:
            if isinstance(e, dict):
                u = e.get("url") or e.get("webpage_url") or ""
                if u and not u.startswith("http") and e.get("id"):
                    u = f"https://www.youtube.com/watch?v={e['id']}"
                if u.startswith("http"):
                    return u, (e.get("title") or "").strip()
        return "", ""

    url, titulo = await asyncio.get_running_loop().run_in_executor(None, _buscar)
    if not url:
        raise RuntimeError("A busca no YouTube não encontrou nada para: " + consulta.split(":", 1)[-1])
    await atualizar(dl_id, url=url, titulo=titulo or url, plataforma=fontes.plataforma(url)[1])
    return url


async def _sondar_direto(url: str, o: dict) -> bool:
    ext = fontes.extensao_url(url)
    if not ext or not (1 <= len(ext) <= 6) or not ext.isalnum():
        return False
    if ext in ("html", "htm", "php", "asp", "aspx", "jsp", "json", "xml", "js", "css", "rss", "cgi", "m3u8", "mpd"):
        return False
    return await asyncio.get_running_loop().run_in_executor(None, fontes.sondar_arquivo_direto, url, o.get("user_agent") or "")


# ── Motor: yt-dlp ─────────────────────────────────────────────────────────────
# Chaves = PostProcessor.pp_key() (nome da classe sem "FFmpeg" e sem "PP").
_FASES_PP = {
    "Merger": "Juntando vídeo e áudio",
    "EmbedThumbnail": "Embutindo capa",
    "Metadata": "Gravando metadados",
    "SponsorBlock": "Buscando patrocínios",
    "ModifyChapters": "Removendo trechos",
    "ExtractAudio": "Convertendo áudio",
    "SubtitlesConvertor": "Preparando legendas",
    "EmbedSubtitle": "Embutindo legendas",
    "SplitChapters": "Dividindo capítulos",
    "MoveFiles": "Finalizando",
    "FixupM3u8": "Corrigindo o arquivo",
    "FixupM4a": "Corrigindo o arquivo",
    "FixupStretched": "Corrigindo o arquivo",
}


class LogYtdlp:
    """Recebe as mensagens do yt-dlp: quantos fluxos vão ser baixados, avisos de 429 e erros."""

    def __init__(self):
        self.fluxos = 1
        self.erros: list[str] = []
        self.avisos: list[str] = []

    def debug(self, msg):
        m = re.search(r"Downloading \d+ format\(s\):\s*(\S+)", msg or "")
        if m:
            self.fluxos = max(1, m.group(1).count("+") + 1)

    def info(self, msg):
        self.debug(msg)

    def warning(self, msg):
        self.avisos.append(strip_ansi(msg))

    def error(self, msg):
        self.erros.append(strip_ansi(msg))


def _hook_progresso(dl_id: str, ctl: Controle, log: LogYtdlp):
    estado = {"arquivos": [], "atual": None}

    def hook(d):
        if ctl.sinal:
            raise DownloadCancelled(ctl.sinal)
        tmp = d.get("tmpfilename") or ""
        nome = d.get("filename") or ""
        if tmp:
            ctl.tmp.add(tmp)
        if nome:
            ctl.tmp.add(nome + ".part")
        if d.get("status") == "downloading":
            marcar_atividade_download_servidor()
            if nome and nome != estado["atual"]:
                estado["atual"] = nome
                if nome not in estado["arquivos"]:
                    estado["arquivos"].append(nome)
            indice = max(0, estado["arquivos"].index(nome)) if nome in estado["arquivos"] else 0
            pct = _progresso_pct(d)
            fluxos = max(log.fluxos, len(estado["arquivos"]))
            geral = min(99.0, (min(indice, fluxos - 1) * 100 + pct) / fluxos)
            baixados = d.get("downloaded_bytes") or 0
            ctl.bytes_baixados = max(ctl.bytes_baixados, baixados)
            fase = ""
            if fluxos > 1:
                info = d.get("info_dict") or {}
                fase = "Áudio" if (info.get("vcodec") == "none") else "Vídeo"
            atualizar_de_thread(dl_id, status="baixando", progresso=geral,
                                velocidade=strip_ansi(d.get("_speed_str", "")) or "",
                                eta=strip_ansi(d.get("_eta_str", "")) or "",
                                baixado=strip_ansi(d.get("_downloaded_bytes_str", "")),
                                total=strip_ansi(d.get("_total_bytes_str") or d.get("_total_bytes_estimate_str") or ""),
                                fase=fase)
        elif d.get("status") == "finished":
            marcar_atividade_download_servidor()
            atualizar_de_thread(dl_id, velocidade="", eta="")

    def hook_pp(d):
        if d.get("status") == "started":
            marcar_atividade_download_servidor()
            nome = d.get("postprocessor") or ""
            fase = _FASES_PP.get(nome)
            if fase:
                atualizar_de_thread(dl_id, status="processando", progresso=99, fase=fase, velocidade="", eta="")

    return hook, hook_pp


def _progresso_pct(d: dict) -> float:
    p = d.get("_percent")
    if isinstance(p, (int, float)) and p == p:
        return max(0.0, min(100.0, float(p)))
    baixado = d.get("downloaded_bytes")
    total = d.get("total_bytes") or d.get("total_bytes_estimate")
    if baixado is not None and total and total > 0:
        return max(0.0, min(100.0, 100.0 * baixado / total))
    raw = strip_ansi(str(d.get("_percent_str") or "0%")).replace("%", "").strip()
    try:
        return max(0.0, min(100.0, float(raw)))
    except ValueError:
        return 0.0


def _montar_opts(dl_id, ctl, o, url, destino, ajustes, nome_fixo=""):
    chave, _ = fontes.plataforma(url)
    ff = dependencias.ffmpeg()
    if o.get("cabecalhos"):  # Referer/Origin/User-Agent capturados pela extensão do navegador
        ajustes = {**ajustes, "headers": {**o["cabecalhos"], **(ajustes.get("headers") or {})}}
    args = opcoes_ytdlp.argumentos(o, destino, chave, ffmpeg=ff, js_runtimes=dependencias.runtimes_js(),
                                   cookies=ajustes.get("cookies", cookies_para(url, o)), ajustes=ajustes, nome_fixo=nome_fixo)
    try:
        extras = opcoes_ytdlp.flags_extras_validas(o.get("flags_extras") or "")
    except ValueError as e:
        print(f"[!] {e}")
        extras = []
    opts = opcoes_ytdlp.ydl_opts(args, extras)
    # A CLI usa ignoreerrors="only_download": um download que falha devolve None em vez de erro e o item
    # pareceria concluído sem arquivo. Aqui toda falha precisa subir para as reservas/novas tentativas.
    opts["ignoreerrors"] = False
    log = LogYtdlp()
    hook, hook_pp = _hook_progresso(dl_id, ctl, log)
    opts["progress_hooks"] = [hook]
    opts["postprocessor_hooks"] = [hook_pp]
    opts["logger"] = log
    if ajustes.get("headers"):
        opts.setdefault("http_headers", {}).update(ajustes["headers"])
    return opts, log


def _estrategias_youtube(url: str, o: dict, erro: str) -> list[tuple[str, dict]]:
    """Ajustes a tentar, em ordem, depois de uma falha no YouTube."""
    t = erro.lower()
    estrategias: list[tuple[str, dict]] = []
    if "confirm you" in t and "not a bot" in t or "po token" in t:
        vistos = set()
        for caminho in [cookies_gerenciados(url), o.get("cookies_arquivo") or "", *caminhos_cookies_txt()]:
            if caminho and os.path.isfile(caminho) and caminho not in vistos:
                vistos.add(caminho)
                estrategias.append((f"cookies ({os.path.basename(caminho)})", {"cookies": {"arquivo": caminho}}))
        for nav in NAVEGADORES_COOKIES:
            estrategias.append((f"cookies do {nav}", {"cookies": {"navegador": nav}}))
        for cliente in (["tv"], ["web_safari"], ["android"]):
            estrategias.append((f"cliente {cliente[0]}", {"cookies": {}, "player_client": cliente}))
    elif ("http error 429" in t or "too many requests" in t) and "subtitle" in t:
        # 429 só nas legendas: o vídeo passa; tenta de novo sem elas (como o OmniGet).
        estrategias.append(("sem legendas (429)", {"sem_legendas": True, "_esperar": 3}))
    elif "http error 429" in t or "too many requests" in t:
        estrategias += [("esperar e ir devagar (429)", {"sono_requisicoes": True, "_esperar": 10, "sem_legendas": True}),
                        ("cliente tv (429)", {"player_client": ["tv"], "sono_requisicoes": True, "_esperar": 20, "sem_legendas": True})]
    elif "nsig" in t or "sabr" in t:
        estrategias += [("cliente ios", {"player_client": ["ios"]}), ("cliente mweb", {"player_client": ["mweb"]}),
                        ("cliente tv", {"player_client": ["tv"]})]
    elif "page needs to be reloaded" in t:
        estrategias += [("cliente web_safari", {"player_client": ["web_safari"]}), ("sem cookies", {"cookies": {}})]
    return estrategias


def _ajustes_genericos(url: str, o: dict, erro: str, ja: dict) -> list[tuple[str, dict]]:
    t = erro.lower()
    seq: list[tuple[str, dict]] = []
    if (any(s in t for s in ("unable to handshake", "sslv3_alert", "cloudflare", "just a moment", "enable javascript and cookies",
                             "http error 403", "http error 410", "impersonat"))
            and not ja.get("impersonate") and impersonate_disponivel()):
        seq.append(("impersonate chrome", {"impersonate": "chrome"}))
    if ("http error 403" in t or "forbidden" in t) and not ja.get("forcar_ipv4"):
        p = urlparse(url)
        seq.append(("ipv4 + referer", {"forcar_ipv4": True, "referer": f"{p.scheme}://{p.netloc}/"}))
    if "thumbnail" in t and "embed" in t and not ja.get("sem_capa"):
        seq.append(("sem capa embutida", {"sem_capa": True}))
    elif any(s in t for s in ("requested format", "format is not available", "no suitable format", "postprocessing", "ffmpeg")) \
            and not ja.get("formato"):
        if o.get("modo") == "audio":  # nunca cair num formato de vídeo quando pediram áudio
            seq.append(("formato simples", {"formato": "ba/b", "sem_capa": True}))
        else:
            seq.append(("formato simples", {"formato": "b/bv*+ba/bv*", "sem_merge": False}))
            seq.append(("formato padrão", {"formato": ["-f", "bv*+ba/b"]}))
    if ("invalid argument" in t or "errno 22" in t) and not ja.get("nomes_restritos"):
        seq.append(("nomes simples", {"nomes_restritos": True}))
    if "subtitle" in t and not ja.get("sem_legendas"):
        seq.append(("sem legendas", {"sem_legendas": True}))
    if any(s in t for s in ("cookies-from-browser", "failed to decrypt", "could not copy", "keyring")) and "cookies" not in ja:
        seq.append(("sem cookies do navegador", {"cookies": {}}))
    return seq


async def baixar_ytdlp(dl_id: str, ctl: Controle, url: str, destino: str, o: dict) -> bool:
    loop = asyncio.get_running_loop()
    chave, nome_plat = fontes.plataforma(url)
    ajustes: dict = {}
    if url_exige_impersonate_browser(url) and impersonate_disponivel():
        ajustes["impersonate"] = "chrome"
    if chave == "youtube" and not dependencias.runtimes_js():
        await atualizar(dl_id, status="analisando", fase="Preparando o YouTube (só na primeira vez)")
        try:
            await loop.run_in_executor(None, dependencias.garantir_runtime_js)
        except Exception as e:  # sem runtime o yt-dlp ainda tenta; o diagnóstico explica se faltar formato
            print(f"[!] Não foi possível instalar o Deno: {e}")
        await atualizar(dl_id, fase="")

    # 1) Metadados (sem baixar): título, miniatura, playlist ou não, fonte só de áudio.
    lista = fontes.eh_playlist(url) or (fontes.tem_lista_anexada(url) and config.get("playlist_inteira"))
    meta_opts, _ = _montar_opts(dl_id, ctl, o, url, destino, ajustes)
    meta_opts.update({"skip_download": True, "noplaylist": not lista, "extract_flat": "in_playlist" if lista else False,
                      "postprocessors": [], "progress_hooks": [], "postprocessor_hooks": []})
    if lista:
        meta_opts["playlistend"] = max(1, int(config.get("limite_playlist") or 200))

    def _meta():
        with yt_dlp.YoutubeDL(meta_opts) as ydl:
            return ydl.extract_info(url, download=False, process=False)

    info = None
    try:
        info = await loop.run_in_executor(None, _meta)
    except DownloadCancelled:
        raise Cancelado(ctl.sinal or "cancelar")
    except Exception as e:
        print(f"[meta] {url}: {mensagem_erro_download(e)[:200]}")
    _checar_sinal(ctl)
    if dl_id not in downloads:
        return False

    if info and info.get("_type") in ("playlist", "multi_video") and lista:
        await expandir_playlist(dl_id, info, destino, o)
        return False

    o = dict(o)
    nome_fixo = ""
    if info:
        somente_audio = info_e_somente_audio(info)
        if somente_audio and o.get("modo") == "video":
            o["modo"], o["formato_audio"] = "audio", "original"
            if o.get("qualidade") == "menor":
                ajustes.setdefault("formato", "wa/w")
        if o.get("modo") == "audio":
            titulo = titulo_audio_exibicao(info, url)
            nome_fixo = sanitizar_nome_arquivo(titulo)
        else:
            titulo = (info.get("title") or "").strip() or url
        if (o.get("legendas") or "nao") != "nao":
            o["legendas_exatas"] = escolher_legendas(info, o)
        plataforma_nome = fontes.nome_plataforma_por_extractor(info.get("extractor_key") or "", url)
        await atualizar(dl_id, titulo=titulo, thumb=melhor_thumbnail(info), plataforma=plataforma_nome, motor="yt-dlp")
        if info.get("is_live") and not o.get("ao_vivo_do_inicio"):
            await atualizar(dl_id, fase="Ao vivo: gravando a partir de agora")
    else:
        await atualizar(dl_id, motor="yt-dlp")

    # 2) Download, com ajustes progressivos conforme o erro (no máximo 6 tentativas internas).
    tentativas: list[tuple[str, dict]] = [("padrão", {})]
    feitos = 0
    ultimo_erro: BaseException | None = None
    sem_js = False   # o yt-dlp avisou que não resolveu o desafio do YouTube (sem runtime JavaScript aceito)
    usar_info = info if (info and info.get("_type") in (None, "video")) else None
    while tentativas and feitos < 6:
        descricao, extra = tentativas.pop(0)
        feitos += 1
        espera = extra.pop("_esperar", 0) if isinstance(extra, dict) else 0
        if espera:
            await asyncio.sleep(espera + random.random() * 4)
        ajustes = {**ajustes, **extra}
        opts, log = _montar_opts(dl_id, ctl, o, url, destino, ajustes, nome_fixo)
        exts = (".mp3", ".m4a", ".opus", ".ogg", ".wav", ".flac", ".webm") if o.get("modo") == "audio" else None

        def _baixar(opts=opts, reaproveitar=usar_info):
            with yt_dlp.YoutubeDL(opts) as ydl:
                if reaproveitar is not None:
                    resultado = ydl.process_ie_result(reaproveitar, download=True)
                else:
                    resultado = ydl.extract_info(url, download=True)
                return resultado, caminho_arquivo_baixado(ydl, resultado, exts)

        try:
            resultado, caminho = await loop.run_in_executor(None, _baixar)
            if descricao != "padrão":
                print(f"[*] {url}: contornado com {descricao}.")
            _checar_sinal(ctl)
            if dl_id not in downloads:
                return False
            if not caminho and resultado and resultado.get("_type") == "playlist":
                caminho = destino
            await atualizar(dl_id, arquivo=caminho or "",
                            titulo=downloads[dl_id]["titulo"] if downloads[dl_id]["titulo"] != url else
                            ((resultado or {}).get("title") or url),
                            thumb=downloads[dl_id]["thumb"] or melhor_thumbnail(resultado))
            if o.get("nfo") and caminho:
                escrever_nfo(caminho, resultado or info or {}, url, downloads[dl_id].get("plataforma") or nome_plat)
            return True
        except DownloadCancelled:
            raise Cancelado(ctl.sinal or "cancelar")
        except Exception as e:
            if ctl.sinal:
                raise Cancelado(ctl.sinal)
            ultimo_erro = e
            usar_info = None   # a próxima tentativa reextrai (cookies/cliente diferentes)
            texto = mensagem_erro_download(e) + "\n" + "\n".join(log.erros[-3:])
            sem_js = sem_js or any(s in a.lower() for a in log.avisos for s in
                                   ("n challenge solving failed", "no supported javascript runtime", "only images are available"))
            if diagnostico.eh_terminal(texto) and "429" not in texto:
                break
            if feitos == 1 or not tentativas:
                novas = (_estrategias_youtube(url, o, texto) if chave == "youtube" else []) + _ajustes_genericos(url, o, texto, ajustes)
                tentativas.extend(n for n in novas if n[0] not in {d for d, _ in tentativas})
            if tentativas:
                print(f"[!] {url}: {texto.strip()[:160]} → tentando {tentativas[0][0]}")
                await atualizar(dl_id, status="analisando", fase="Tentando de outro jeito", velocidade="", eta="")
    if ultimo_erro is not None:
        texto = mensagem_erro_download(ultimo_erro)
        if "confirm you" in texto.lower() and "not a bot" in texto.lower():
            raise RuntimeError(mensagem_bloqueio_youtube()) from ultimo_erro
        if chave == "youtube" and sem_js and not dependencias.runtimes_js():
            raise RuntimeError(f"Sem runtime JavaScript para o YouTube: {texto[:200]}") from ultimo_erro
        raise ultimo_erro
    raise RuntimeError("Falhou sem mensagem.")


def escolher_legendas(info: dict, o: dict) -> list[str]:
    """
    Faixas exatas a pedir, como o OmniGet: para cada idioma, a legenda feita por pessoas (o código ou uma
    variante regional, pt → pt-BR); sem ela e com automáticas ligadas, a automática do próprio idioma —
    nunca as traduções automáticas (en-de, en-fr…). Lista vazia = nenhuma legenda disponível.
    """
    manuais = info.get("subtitles") or {}
    automaticas = info.get("automatic_captions") or {}
    escolhidas: list[str] = []
    for codigo in [c.strip().lower() for c in re.split(r"[,;\s]+", o.get("idiomas_legenda") or "pt,en") if c.strip()]:
        exato = [k for k in manuais if k.lower() == codigo]
        variantes = sorted(k for k in manuais if k.lower().startswith(codigo + "-") and k != "live_chat")
        if exato or variantes:
            escolhidas.append((exato or variantes)[0])
            continue
        if o.get("legendas_auto"):
            for chave in (codigo + "-orig", codigo):
                achada = next((k for k in automaticas if k.lower() == chave), None)
                if achada:
                    escolhidas.append(achada)
                    break
    return list(dict.fromkeys(escolhidas))


def mensagem_bloqueio_youtube() -> str:
    return (
        "O YouTube bloqueou este IP (\"Sign in to confirm you're not a bot\") e nenhum contorno funcionou. "
        "Importe os cookies de uma sessão logada no YouTube (Configurações › Cookies) e tente de novo."
    )


async def expandir_playlist(dl_id: str, info: dict, destino: str, o: dict):
    """Troca o item da playlist por um item por entrada (até o limite), numa subpasta com o nome da lista."""
    titulo = (info.get("title") or info.get("id") or "Playlist").strip()
    pasta = os.path.join(destino, sanitizar_nome_arquivo(titulo, 120)) if config.get("playlist_em_pasta", True) else destino
    limite = max(1, int(config.get("limite_playlist") or 200))
    entradas = []
    for e in info.get("entries") or []:
        if len(entradas) >= limite:
            break
        if not isinstance(e, dict):
            continue
        u = e.get("url") or e.get("webpage_url") or ""
        if u and not u.startswith("http") and (e.get("ie_key") or "").lower().startswith("youtube"):
            u = f"https://www.youtube.com/watch?v={e.get('id') or u}"
        if u.startswith("http"):
            entradas.append((u, (e.get("title") or "").strip()))
    downloads.pop(dl_id, None)
    controles.pop(dl_id, None)
    await broadcast({"tipo": "remover", "id": dl_id})
    if not entradas:
        await avisar(f"A playlist \"{titulo}\" está vazia ou privada.", "aviso")
        return
    for u, t in entradas:
        novo = criar_download(u, pasta, dict(o), grupo=titulo, titulo=t)
        await broadcast({"tipo": "adicionar", "download": publico(downloads[novo])})
    await avisar(f"Playlist \"{titulo}\": {len(entradas)} itens na fila.", "info")
    if fila:
        fila.acordar()


def escrever_nfo(caminho: str, info: dict, url: str, plataforma: str):
    """Arquivo .nfo (Kodi/Jellyfin) ao lado da mídia."""
    from xml.sax.saxutils import escape
    try:
        duracao = int(float(info.get("duration") or 0) // 60)
        data = info.get("upload_date") or ""
        xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<movie>\n'
            f"  <title>{escape(info.get('title') or os.path.splitext(os.path.basename(caminho))[0])}</title>\n"
            f"  <plot>{escape((info.get('description') or '')[:4000])}</plot>\n"
            f"  <studio>{escape(info.get('uploader') or info.get('channel') or '')}</studio>\n"
            f"  <runtime>{duracao}</runtime>\n"
            + (f"  <premiered>{data[:4]}-{data[4:6]}-{data[6:8]}</premiered>\n" if len(data) == 8 else "")
            + f"  <thumb>{escape(melhor_thumbnail(info))}</thumb>\n"
            f"  <tag>{escape(plataforma or '')}</tag>\n"
            f"  <uniqueid type=\"url\">{escape(url)}</uniqueid>\n"
            f"  <dateadded>{datetime.now():%Y-%m-%d %H:%M:%S}</dateadded>\n</movie>\n"
        )
        with open(os.path.splitext(caminho)[0] + ".nfo", "w", encoding="utf-8") as f:
            f.write(xml)
    except OSError as e:
        print(f"[!] .nfo: {e}")


# ── Motor: extratores nativos ─────────────────────────────────────────────────
async def baixar_nativo(dl_id: str, ctl: Controle, extrator, url: str, destino: str, o: dict) -> bool:
    loop = asyncio.get_running_loop()
    ctl.nativo_tentado = True
    chave, _ = fontes.plataforma(url)
    cookie = cookie_header_de_arquivo(cookies_gerenciados(url) or o.get("cookies_arquivo") or "", fontes.dominio_raiz(fontes.host_de(url)))
    kwargs = {}
    if extrator in (nativos.twitter, nativos.reddit, nativos.twitch_clipe):
        kwargs["limite_altura"] = opcoes_ytdlp.altura_maxima(o)
    if extrator in (nativos.twitter, nativos.instagram) and cookie:
        kwargs["cookie_header"] = cookie
    await atualizar(dl_id, status="analisando", motor="nativo", fase="Lendo a publicação")
    res: nativos.Resultado = await loop.run_in_executor(None, lambda: extrator(url, **kwargs))
    _checar_sinal(ctl)
    if dl_id not in downloads:
        return False
    titulo = res.titulo or downloads[dl_id]["titulo"]
    thumb = res.thumb or next((m.url for m in res.midias if m.tipo == "imagem"), "")
    await atualizar(dl_id, titulo=titulo, thumb=thumb, fase="")
    base = sanitizar_nome_arquivo(titulo or chave or "midia", 150)
    total = len(res.midias)
    arquivos = []
    for i, m in enumerate(res.midias):
        _checar_sinal(ctl)
        nome = f"{base} ({i + 1})" if total > 1 else base
        if m.via_ytdlp:
            o_hls = dict(o, modo="video", embutir_miniatura=False)
            ok = await baixar_ytdlp_de_manifesto(dl_id, ctl, m.url, destino, o_hls, nome, m.headers)
            if ok:
                arquivos.append(ok)
            continue
        caminho = await baixar_http(dl_id, ctl, m.url, destino, f"{nome}.{m.ext}", m.headers, o, i, total)
        if m.audio_url:
            caminho = await juntar_audio(dl_id, ctl, caminho, m.audio_url, m.headers, o)
        arquivos.append(caminho)
    if not arquivos:
        raise nativos.NativoFalhou("Nenhuma mídia baixada.")
    await atualizar(dl_id, arquivo=arquivos[0], arquivos=len(arquivos))
    return True


async def baixar_ytdlp_de_manifesto(dl_id, ctl, manifesto, destino, o, nome, headers) -> str:
    loop = asyncio.get_running_loop()
    opts, _ = _montar_opts(dl_id, ctl, o, manifesto, destino, {"headers": headers or {}, "cookies": {}}, nome_fixo=nome)

    def _baixar():
        with yt_dlp.YoutubeDL(opts) as ydl:
            r = ydl.extract_info(manifesto, download=True)
            return caminho_arquivo_baixado(ydl, r)

    try:
        return await loop.run_in_executor(None, _baixar)
    except DownloadCancelled:
        raise Cancelado(ctl.sinal or "cancelar")


async def baixar_http(dl_id, ctl, url, destino, nome, headers, o, indice=0, total_itens=1) -> str:
    loop = asyncio.get_running_loop()
    medidor = Medidor()

    def progresso(feito, total):
        if ctl.sinal:
            return
        marcar_atividade_download_servidor()
        ctl.bytes_baixados = max(ctl.bytes_baixados, feito)
        vel = medidor.medir(feito)
        pct = (100.0 * feito / total) if total else 0.0
        geral = min(99.0, (indice * 100 + pct) / max(1, total_itens))
        atualizar_de_thread(dl_id, status="baixando", progresso=geral, velocidade=f"{_bytes_legiveis(vel)}/s" if vel else "",
                            eta=_eta(total - feito, vel) if total else "", baixado=_bytes_legiveis(feito),
                            total=_bytes_legiveis(total) if total else "")

    motor = direto.DownloadDireto(url, destino, nome, headers, conexoes=max(1, int(o.get("fragmentos") or 4)) * 2,
                                  limite=direto.LimiteVelocidade(direto.taxa_em_bytes(o.get("limite_velocidade") or "")),
                                  progresso=progresso, proxy=o.get("proxy") or "", verificar_tls=not o.get("ignorar_tls"))
    ctl.motor = motor
    try:
        return await loop.run_in_executor(None, motor.baixar)
    except direto.Interrompido as e:
        raise Cancelado(str(e))
    finally:
        ctl.motor = None
        if motor.parte:  # para o cancelamento depois de uma pausa apagar o parcial
            ctl.tmp.update((motor.parte, motor.parte + ".json"))


async def juntar_audio(dl_id, ctl, video: str, audio_url: str, headers: dict, o: dict) -> str:
    """Reddit entrega vídeo e áudio separados: baixa o áudio e junta sem recodificar (ffmpeg -c copy)."""
    ff = dependencias.ffmpeg()
    if not ff:
        return video
    base, _ = os.path.splitext(video)
    audio = await baixar_http(dl_id, ctl, audio_url, os.path.dirname(video), os.path.basename(base) + ".audio.mp4", headers, o)
    await atualizar(dl_id, status="processando", fase="Juntando vídeo e áudio", progresso=99)
    saida = base + ".merged.mp4"

    def _juntar():
        r = subprocess.run([ff, "-y", "-loglevel", "error", "-i", video, "-i", audio, "-c", "copy", "-map", "0:v:0", "-map", "1:a:0", saida],
                           capture_output=True, text=True, creationflags=_subprocess_flags_windows_silencioso())
        return r.returncode == 0 and os.path.isfile(saida)

    if await asyncio.get_running_loop().run_in_executor(None, _juntar):
        for p in (video, audio):
            try:
                os.remove(p)
            except OSError:
                pass
        os.replace(saida, video)
    return video


# ── Motor: HTTP direto ────────────────────────────────────────────────────────
async def baixar_direto(dl_id: str, ctl: Controle, url: str, destino: str, o: dict) -> bool:
    nome = direto.nome_da_url(url)
    ext = fontes.extensao_url(url)
    await atualizar(dl_id, motor="direto", titulo=nome or url, plataforma=downloads[dl_id].get("plataforma") or fontes.dominio_raiz(fontes.host_de(url)),
                    thumb=url if ext in ("jpg", "jpeg", "png", "gif", "webp") else "")
    caminho = await baixar_http(dl_id, ctl, url, destino, "", o.get("cabecalhos") or {}, o)
    if dl_id in downloads:
        await atualizar(dl_id, arquivo=caminho, titulo=os.path.basename(caminho))
    return True


# ── Motor: gallery-dl ─────────────────────────────────────────────────────────
async def baixar_galeria(dl_id: str, ctl: Controle, url: str, destino: str, o: dict) -> bool:
    loop = asyncio.get_running_loop()
    if not dependencias.modulo_presente("gallery_dl"):
        await atualizar(dl_id, status="analisando", fase="Instalando o suporte a galerias")
    await atualizar(dl_id, status="analisando", motor="galeria", plataforma=downloads[dl_id].get("plataforma") or fontes.dominio_raiz(fontes.host_de(url)),
                    fase="Lendo a galeria")

    def progresso(novos, existiam, caminho):
        marcar_atividade_download_servidor()
        atualizar_de_thread(dl_id, status="baixando", progresso=0, arquivos=novos,
                            fase=f"{novos} arquivo{'s' if novos != 1 else ''}" + (f" · {existiam} já existiam" if existiam else ""),
                            thumb=downloads.get(dl_id, {}).get("thumb") or (caminho if caminho.lower().endswith((".jpg", ".jpeg", ".png", ".webp")) else ""))

    motor = galerias.Galeria(url, destino, PASTA_DADOS, cookies_para(url, o), o.get("proxy") or "", o.get("limite_velocidade") or "",
                             progresso, int(config.get("limite_galeria") or 0))
    ctl.motor = motor
    try:
        arquivos = await loop.run_in_executor(None, motor.baixar)
    except InterruptedError as e:
        raise Cancelado(str(e))
    finally:
        ctl.motor = None
    if dl_id not in downloads:
        return False
    pasta = os.path.commonpath(arquivos) if len(arquivos) > 1 else (arquivos[0] if arquivos else destino)
    titulo = downloads[dl_id]["titulo"]
    if titulo == url:
        titulo = os.path.basename(pasta.rstrip("\\/")) or url
    await atualizar(dl_id, arquivo=arquivos[0] if len(arquivos) == 1 else "", destino=pasta if os.path.isdir(pasta) else destino,
                    arquivos=len(arquivos) + motor.ja_existiam, titulo=titulo, fase="")
    return True


# ── Motor: torrent ────────────────────────────────────────────────────────────
async def baixar_torrent(dl_id: str, ctl: Controle, url: str, destino: str, o: dict) -> bool:
    loop = asyncio.get_running_loop()
    if not dependencias.modulo_presente("libtorrent"):
        await atualizar(dl_id, status="analisando", motor="torrent", plataforma="Torrent", fase="Instalando o suporte a torrent")
    m = re.search(r"[?&]dn=([^&]+)", url)
    if m:
        await atualizar(dl_id, titulo=unquote(m.group(1)).replace("+", " "))
    await atualizar(dl_id, status="analisando", motor="torrent", plataforma="Torrent", fase="Buscando metadados")

    def progresso(st):
        if ctl.sinal:
            return
        marcar_atividade_download_servidor()
        d = torrents.descricao(st)
        ctl.bytes_baixados = d["baixado_bytes"]
        campos = {"pares": d["pares"], "fase": d["fase"] + (f" · {d['pares']} pares" if d["pares"] else "")}
        if d["nome"] and downloads.get(dl_id, {}).get("titulo", "").startswith("magnet:"):
            campos["titulo"] = d["nome"]
        if d["total_bytes"]:
            campos.update(status="baixando", progresso=min(99.0, d["progresso"]),
                          velocidade=f"{_bytes_legiveis(d['velocidade_bps'])}/s" if d["velocidade_bps"] else "",
                          eta=_eta(d["total_bytes"] - d["baixado_bytes"], d["velocidade_bps"]),
                          baixado=_bytes_legiveis(d["baixado_bytes"]), total=_bytes_legiveis(d["total_bytes"]))
        atualizar_de_thread(dl_id, **campos)

    motor = torrents.Torrent(url, destino, int(config.get("torrent_porta") or 6881), bool(config.get("torrent_upnp", True)),
                             bool(config.get("torrent_trackers", True)), direto.taxa_em_bytes(o.get("limite_velocidade") or ""), progresso,
                             os.path.join(PASTA_DADOS, "torrents"))
    ctl.motor = motor
    try:
        caminho = await loop.run_in_executor(None, motor.baixar)
    except InterruptedError as e:
        raise Cancelado(str(e))
    finally:
        ctl.motor = None
        ctl.tmp.update(motor.parciais)
    if dl_id in downloads:
        await atualizar(dl_id, arquivo=caminho if os.path.isfile(caminho) else "", titulo=motor.nome or downloads[dl_id]["titulo"],
                        destino=caminho if os.path.isdir(caminho) else destino, pares=0, fase="")
    return True


# ── Motor: navegador headless (players blob/MSE) ──────────────────────────────
async def tentar_resgate_por_sniffer(dl_id: str, ctl: Controle, url: str, destino: str, o: dict) -> bool:
    """
    Sobe o Chromium headless do sniffer.py para descobrir o manifesto HLS/DASH quando o yt-dlp já falhou
    (players MSE/blob) e baixa a partir dele. Falha aqui devolve False — quem chamou mantém o erro do yt-dlp.
    """
    if dl_id not in downloads:
        return False
    ctl.via_sniffer = True

    def _reportar(msg: str):
        marcar_atividade_download_servidor()
        atualizar_de_thread(dl_id, status="analisando", fase=msg)

    try:
        await atualizar(dl_id, status="analisando", fase="Procurando o vídeo na página", motor="navegador")
        resultado = await sniffer.descobrir_manifesto(url, reportar=_reportar)
        _checar_sinal(ctl)
        if not resultado or dl_id not in downloads:
            return False
        thumb = (resultado.get("thumb") or "").strip()
        if not thumb:
            try:
                thumb = await sniffer.gerar_thumbnail_ffmpeg(resultado["manifesto"], resultado.get("headers") or {})
            except Exception:
                thumb = ""
        titulo = (resultado.get("titulo") or "").strip() or url
        await atualizar(dl_id, titulo=titulo, thumb=thumb)
        _checar_sinal(ctl)
        caminho = await baixar_ytdlp_de_manifesto(dl_id, ctl, resultado["manifesto"], destino, o,
                                                  sanitizar_nome_arquivo(titulo), resultado.get("headers") or {})
        if dl_id not in downloads:
            return False
        await atualizar(dl_id, arquivo=caminho or "")
        return True
    except Cancelado:
        raise
    except Exception as e_resgate:
        print(f"[sniffer] resgate falhou para {url}: {type(e_resgate).__name__}: {e_resgate}")
        return False


# ── Canais seguidos ───────────────────────────────────────────────────────────
def _url_canal(url: str) -> str:
    """Raiz de canal do YouTube → aba de vídeos (senão o yt-dlp lista as abas, não os vídeos)."""
    p = urlparse(url)
    if fontes.plataforma(url)[0] == "youtube":
        segs = [s for s in p.path.split("/") if s]
        if (len(segs) == 1 and segs[0].startswith("@")) or (len(segs) == 2 and segs[0] in ("channel", "c", "user")):
            return url.rstrip("/") + "/videos"
    return url


def verificar_canal(url: str, vistos: list[str] | None, o: dict) -> dict:
    """Últimos 30 itens do canal/perfil/playlist; `novos` são os que não estão em `vistos`."""
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": "in_playlist",
            "playlistend": 30, "lazy_playlist": True, "socket_timeout": 30, "logger": LogYtdlp(),
            "http_headers": {"User-Agent": (o.get("user_agent") or opcoes_ytdlp.UA_PADRAO)}}
    c = cookies_para(url, o)
    if c.get("arquivo"):
        opts["cookiefile"] = c["arquivo"]
    if o.get("proxy"):
        opts["proxy"] = o["proxy"]
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(_url_canal(url), download=False)
    itens = []
    for e in (info or {}).get("entries") or []:
        if not isinstance(e, dict) or not e.get("id"):
            continue
        u = e.get("url") or e.get("webpage_url") or ""
        if u and not u.startswith("http") and (e.get("ie_key") or "").lower().startswith("youtube"):
            u = f"https://www.youtube.com/watch?v={e['id']}"
        if u.startswith("http"):
            itens.append({"id": str(e["id"]), "url": u, "titulo": (e.get("title") or "").strip()})
    vistos_set = set(vistos or [])
    novos = [] if vistos is None else [i for i in itens if i["id"] not in vistos_set]
    return {"titulo": (info or {}).get("channel") or (info or {}).get("uploader") or (info or {}).get("title") or "",
            "ids": [i["id"] for i in itens], "novos": novos}


# ── Handler de conexão WebSocket ──────────────────────────────────────────────
async def handler(ws):
    global _houve_cliente_ws_para_inatividade
    clientes.add(ws)
    _houve_cliente_ws_para_inatividade = True
    marcar_atividade_download_servidor()
    print(f"[+] Cliente conectado  ({len(clientes)} total)")
    await ws.send(json.dumps({"tipo": "estado_inicial", "downloads": [publico(d) for d in downloads.values()],
                              "dependencias": dependencias.estado()}, ensure_ascii=False, default=str))
    try:
        async for msg in ws:
            try:
                dados = json.loads(msg)
            except json.JSONDecodeError:
                continue
            try:
                await tratar(ws, dados)
            except Exception as e:
                print(f"[!] ação {dados.get('acao')}: {type(e).__name__}: {e}")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        clientes.discard(ws)
        print(f"[-] Cliente desconectado ({len(clientes)} total)")


def _aplicar_config(nova: dict | None):
    if not nova:
        return
    for k, v in nova.items():
        if v is not None:
            config[k] = v
    dependencias.definir_ffmpeg(config.get("ffmpeg") or "")


async def tratar(ws, dados: dict):
    acao = dados.get("acao")
    marcar_atividade_download_servidor()
    _aplicar_config(dados.get("config"))

    if acao == "configurar":
        if fila:
            fila.acordar()

    elif acao == "adicionar":
        destino_base = dados.get("destino") or PASTA_DOWNLOAD_PADRAO
        repetidos = 0
        novos = 0
        for bruto in dados.get("urls", []):
            for url in fontes.extrair_entradas(str(bruto)):
                if ja_na_fila(url):
                    repetidos += 1
                    continue
                o = opcoes_de(dados)
                destino, o = aplicar_regras(url, destino_base, o)
                destino = destino_organizado(destino, url, o)
                dl_id = criar_download(url, destino, o)
                novos += 1
                await broadcast({"tipo": "adicionar", "download": publico(downloads[dl_id])})
        if repetidos:
            await avisar(f"{repetidos} link{'s' if repetidos > 1 else ''} já estava{'m' if repetidos > 1 else ''} na fila.", "info")
        if novos and fila:
            fila.acordar()

    elif acao == "pausar":
        pausar(dados.get("id"))

    elif acao == "pausar_todos":
        for dl_id in list(downloads):
            pausar(dl_id)

    elif acao == "retomar":
        await retomar(dados)

    elif acao == "retomar_todos":
        for dl_id, d in list(downloads.items()):
            if d.get("status") == "pausado":
                await retomar({"id": dl_id})
        for item in dados.get("itens") or []:
            await retomar(item)

    elif acao in ("remover", "cancelar"):
        dl_id = dados.get("id")
        d, ctl = downloads.get(dl_id), controles.get(dl_id)
        if d and ctl and d.get("status") in ("analisando", "baixando", "processando") and ctl.tarefa and not ctl.tarefa.done():
            ctl.sinal = "cancelar"
            if ctl.motor:
                ctl.motor.cancelar()
            return  # a tarefa remove o item e apaga os parciais ao parar
        if d and ctl and d.get("status") in ("pausado", "pendente", "erro"):
            apagar_parciais(ctl)
        downloads.pop(dl_id, None)
        controles.pop(dl_id, None)
        if dl_id:
            await broadcast({"tipo": "remover", "id": dl_id})

    elif acao == "limpar_concluidos":
        removidos = [k for k, v in downloads.items() if v["status"] == "concluido"]
        for k in removidos:
            downloads.pop(k, None)
            controles.pop(k, None)
        await broadcast({"tipo": "limpar_concluidos", "ids": removidos})

    # O servidor pode ter reiniciado (inatividade) e já não conhecer o dl_id: aceita arquivo/destino do cliente.
    elif acao == "abrir_pasta_arquivo":
        dl_id = dados.get("id")
        d = downloads.get(dl_id) or {}
        arq = (d.get("arquivo") or dados.get("arquivo") or "").strip()
        dest = (d.get("destino") or dados.get("destino") or "").strip()
        if arq and os.path.isfile(arq):
            revelar_pasta_do_arquivo(arq)
        elif dest:
            abrir_pasta(dest)

    elif acao == "abrir_arquivo":
        dl_id = dados.get("id")
        arq = (downloads[dl_id].get("arquivo") or "").strip() if dl_id in downloads else caminho_midia_do_cliente(dados.get("arquivo"))
        if arq:
            abrir_arquivo_com_app_padrao(arq)

    elif acao == "verificar_canais":
        resultados = []
        for canal in dados.get("canais") or []:
            try:
                r = await asyncio.get_running_loop().run_in_executor(
                    None, verificar_canal, canal.get("url") or "", canal.get("vistos"), dict(config))
                r["id"] = canal.get("id")
            except Exception as e:
                r = {"id": canal.get("id"), "erro": diagnostico.classificar(mensagem_erro_download(e)).mensagem}
            resultados.append(r)
            marcar_atividade_download_servidor()
            await asyncio.sleep(2)
        await ws.send(json.dumps({"tipo": "canais", "resultados": resultados}, ensure_ascii=False))

    elif acao == "dependencias":
        await ws.send(json.dumps({"tipo": "dependencias", "estado": dependencias.estado()}, ensure_ascii=False))

    elif acao == "encerrar_servidor":
        await disparar_encerramento_vdget()


def pausar(dl_id: str | None):
    d, ctl = downloads.get(dl_id), controles.get(dl_id)
    if not d or not ctl:
        return
    if d.get("status") == "pendente":
        d["status"] = "pausado"
        broadcast_de_thread({"tipo": "atualizar", "download": publico(d)})
    elif d.get("status") in ("analisando", "baixando", "processando"):
        ctl.sinal = "pausar"
        if ctl.motor:
            ctl.motor.parar()


async def retomar(dados: dict):
    """Pausado → fila. Se o servidor reiniciou e não conhece o id, recria com os dados que o cliente guardou."""
    dl_id = dados.get("id")
    d, ctl = downloads.get(dl_id), controles.get(dl_id)
    if d and ctl:
        if ctl.sinal == "pausar" and d.get("status") in ATIVOS:
            ctl.retomar_apos_pausa = True
            return
        if d.get("status") not in ("pausado", "erro"):
            return
        ctl.sinal = None
        ctl.agendado_ts = 0
        ctl.tentativas = 0
        await atualizar(dl_id, status="pendente", erro="", dica="", aguardando_ate=0)
    elif dl_id and dados.get("url"):
        o = opcoes_de(dados)
        criar_download(dados["url"], dados.get("destino") or PASTA_DOWNLOAD_PADRAO, o, dl_id=dl_id,
                       grupo=dados.get("grupo") or "", titulo=dados.get("titulo") or "")
        await broadcast({"tipo": "adicionar", "download": publico(downloads[dl_id])})
    if fila:
        fila.acordar()


# ── Entry point ───────────────────────────────────────────────────────────────
async def main():
    global _shutdown, _t_mono_ultima_atividade_download, _houve_cliente_ws_para_inatividade, _loop, fila
    host = os.environ.get("VDGET_HOST") or "localhost"
    porta = _int_env("VDGET_PORT", 8765)
    _shutdown = asyncio.Event()
    _loop = asyncio.get_running_loop()
    fila = Agendador()
    _t_mono_ultima_atividade_download = time.monotonic()
    _houve_cliente_ws_para_inatividade = False
    print(f"[*] Cachalot · servidor em ws://{host}:{porta} · yt-dlp {dependencias.versao_ytdlp()}")
    atualizar_yt_dlp_em_segundo_plano()
    async with websockets.serve(handler, host, porta, max_size=8 * 1024 * 1024):
        tarefas = [asyncio.create_task(watchdog_inatividade_sem_download()), asyncio.create_task(fila.laco())]
        try:
            await _shutdown.wait()
        finally:
            for t in tarefas:
                t.cancel()
            for t in tarefas:
                try:
                    await t
                except asyncio.CancelledError:
                    pass
    print("[*] Servidor encerrado.")


if __name__ == "__main__":
    asyncio.run(main())
