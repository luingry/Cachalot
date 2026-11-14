"""
dependencias.py — o que o backend precisa além do Python, encontrado ou instalado sob demanda.

- Pacotes pip (gallery-dl, libtorrent, …): instalados na primeira vez que fazem falta, nunca antes.
- FFmpeg: caminho configurado → PATH → pastas comuns. Sem FFmpeg o download continua, só com formatos
  que já vêm prontos (sem juntar vídeo+áudio, sem embutir nada).
- Runtime JavaScript (deno/node/bun): o yt-dlp precisa de um para os formatos completos do YouTube. Sem um
  aceito (ex.: Node 20), o Deno é instalado pelo pip no primeiro download do YouTube.
"""

import importlib
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import sysconfig
import threading

_lock = threading.Lock()
_ffmpeg_configurado = ""


def instalar_pacote(spec: str, timeout: int = 600) -> None:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check", spec],
                       capture_output=True, text=True, timeout=timeout, creationflags=flags)
    if r.returncode != 0:
        raise RuntimeError(f"pip install {spec} falhou: {(r.stderr or r.stdout or '').strip()[-400:]}")
    importlib.invalidate_caches()


def garantir_modulo(nome_import: str, spec: str):
    """Importa o módulo, instalando o pacote na primeira vez. Bloqueante (chame em executor)."""
    with _lock:
        try:
            return importlib.import_module(nome_import)
        except ImportError:
            instalar_pacote(spec)
            return importlib.import_module(nome_import)


def modulo_presente(nome_import: str) -> bool:
    try:
        return importlib.util.find_spec(nome_import) is not None
    except (ImportError, ValueError):
        return False


def definir_ffmpeg(caminho: str) -> None:
    global _ffmpeg_configurado
    _ffmpeg_configurado = (caminho or "").strip().strip('"')


def ffmpeg() -> str:
    """Caminho do ffmpeg.exe, ou "" quando não há."""
    c = _ffmpeg_configurado
    if c:
        if os.path.isdir(c):
            c = os.path.join(c, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if os.path.isfile(c):
            return c
    achado = shutil.which("ffmpeg")
    if achado:
        return achado
    for pasta in (r"C:\ffmpeg\bin", r"C:\Program Files\ffmpeg\bin", os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links")):
        candidato = os.path.join(pasta, "ffmpeg.exe")
        if os.path.isfile(candidato):
            return candidato
    return ""


def ffprobe() -> str:
    f = ffmpeg()
    if not f:
        return ""
    candidato = os.path.join(os.path.dirname(f), "ffprobe.exe" if os.name == "nt" else "ffprobe")
    return candidato if os.path.isfile(candidato) else (shutil.which("ffprobe") or "")


# Versões mínimas que o yt-dlp aceita (yt_dlp/utils/_jsruntime.py). Abaixo delas ele ignora o runtime, o
# desafio "n" do YouTube falha e, com cookies, sobram só imagens ("Requested format is not available").
_MINIMOS_JS = {"deno": (2, 3, 0), "node": (22, 0, 0), "bun": (1, 2, 11)}
_runtimes: list[str] | None = None


def _versao_exe(caminho: str) -> tuple[int, ...]:
    try:
        r = subprocess.run([caminho, "--version"], capture_output=True, text=True, timeout=20,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return ()
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", r.stdout or "")
    return tuple(int(x) for x in m.groups()) if m else ()


def _deno_do_pip() -> str:
    """deno.exe do pacote "deno" do PyPI (fica na pasta Scripts do Python, que nem sempre está no PATH)."""
    exe = "deno.exe" if os.name == "nt" else "deno"
    pastas = []
    for esquema in (None, f"{os.name}_user"):
        try:
            pastas.append(sysconfig.get_path("scripts", esquema) if esquema else sysconfig.get_path("scripts"))
        except KeyError:
            pass
    return next((c for c in (os.path.join(p, exe) for p in pastas if p) if os.path.isfile(c)), "")


def runtimes_js() -> list[str]:
    """Runtimes aceitos pelo yt-dlp, como 'nome:caminho' para --js-runtimes. Verificado uma vez por processo."""
    global _runtimes
    if _runtimes is None:
        achados = []
        for nome, minimo in _MINIMOS_JS.items():
            for caminho in (shutil.which(nome), _deno_do_pip() if nome == "deno" else ""):
                if caminho and _versao_exe(caminho) >= minimo:
                    achados.append(f"{nome}:{caminho}")
                    break
        _runtimes = achados
    return _runtimes


def garantir_runtime_js() -> list[str]:
    """Instala o Deno pelo pip quando não há runtime aceito (só na primeira vez que o YouTube precisa). Bloqueante."""
    global _runtimes
    with _lock:
        if runtimes_js():
            return _runtimes
        instalar_pacote("deno")
        _runtimes = None
        return runtimes_js()


def versao_ytdlp() -> str:
    try:
        import yt_dlp.version
        return yt_dlp.version.__version__
    except Exception:
        return ""


def estado() -> dict:
    """Resumo para a tela de configurações."""
    return {
        "python": sys.version.split()[0],
        "yt_dlp": versao_ytdlp(),
        "ffmpeg": ffmpeg(),
        "js": ", ".join(r.split(":", 1)[0] for r in runtimes_js()),
        "gallery_dl": modulo_presente("gallery_dl"),
        "libtorrent": modulo_presente("libtorrent"),
        "playwright": modulo_presente("playwright"),
    }
