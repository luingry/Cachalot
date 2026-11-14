"""
galerias.py — galerias e perfis inteiros via gallery-dl (250+ sites de imagem: DeviantArt, Pixiv,
ArtStation, Imgur, Tumblr, perfis do X/Instagram/Pinterest, subreddits…).

Roda o gallery-dl como processo filho (cancelar = matar o processo), com arquivo de histórico próprio
para não baixar duas vezes o mesmo item. O pacote é instalado na primeira vez que faz falta.
"""

import os
import subprocess
import sys
import time

import dependencias


def suporta(url: str) -> bool:
    """True quando o gallery-dl tem extrator específico para o link (sem rede)."""
    try:
        gdl = dependencias.garantir_modulo("gallery_dl", "gallery-dl")
        from gallery_dl import extractor  # noqa: F401
        ex = gdl.extractor.find(url)
    except Exception:
        return False
    if ex is None:
        return False
    return (getattr(ex, "category", "") or "") not in ("directlink", "generic", "noop", "recursive")


class Galeria:
    def __init__(self, url: str, destino: str, pasta_dados: str, cookies: dict | None = None,
                 proxy: str = "", limite_velocidade: str = "", progresso=None, limite_itens: int = 0):
        self.url = url
        self.limite_itens = max(0, int(limite_itens or 0))
        self.destino = destino
        self.pasta_dados = pasta_dados
        self.cookies = cookies or {}
        self.proxy = proxy
        self.limite = limite_velocidade
        self.progresso = progresso
        self.arquivos: list[str] = []
        self.ja_existiam = 0
        self._proc: subprocess.Popen | None = None
        self._sinal = None

    def cancelar(self):
        self._sinal = "cancelar"
        self._matar()

    def parar(self):
        self._sinal = "pausar"
        self._matar()

    def _matar(self):
        p = self._proc
        if p and p.poll() is None:
            try:
                p.kill()
            except OSError:
                pass

    def baixar(self) -> list[str]:
        dependencias.garantir_modulo("gallery_dl", "gallery-dl")
        os.makedirs(self.destino, exist_ok=True)
        historico = os.path.join(self.pasta_dados, "galerias.sqlite3")
        args = [sys.executable, "-m", "gallery_dl", "--no-colors", "-d", self.destino,
                "--download-archive", historico, "-o", "output.progress=false", "-o", "output.mode=pipe"]
        if self.cookies.get("arquivo"):
            args += ["--cookies", self.cookies["arquivo"]]
        elif self.cookies.get("navegador"):
            args += ["--cookies-from-browser", self.cookies["navegador"]]
        if self.proxy:
            args += ["--proxy", self.proxy]
        if self.limite:
            args += ["--limit-rate", self.limite]
        if self.limite_itens:
            args += ["--range", f"1-{self.limite_itens}"]
        args += ["--", self.url]
        inicio = time.time()
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self._proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                      encoding="utf-8", errors="replace", creationflags=flags)
        erros: list[str] = []
        for linha in self._proc.stdout:
            linha = linha.rstrip("\r\n")
            if not linha:
                continue
            # Modo pipe: cada arquivo baixado vira uma linha com o caminho; "# caminho" = já existia.
            caminho = linha[2:] if linha.startswith("# ") else linha
            if os.path.isabs(caminho):
                if linha.startswith("# "):
                    self.ja_existiam += 1
                else:
                    self.arquivos.append(caminho)
                if self.progresso:
                    self.progresso(len(self.arquivos), self.ja_existiam, caminho)
        stderr = self._proc.stderr.read() if self._proc.stderr else ""
        codigo = self._proc.wait()
        if self._sinal:
            raise InterruptedError(self._sinal)
        for linha in stderr.splitlines():
            if "[error]" in linha.lower() or "error:" in linha.lower():
                erros.append(linha.strip())
        if not self.arquivos and not self.ja_existiam:
            novos = _arquivos_novos(self.destino, inicio)
            if novos:
                self.arquivos = novos
            elif codigo != 0 or erros:
                raise RuntimeError("gallery-dl: " + (erros[-1] if erros else f"terminou com código {codigo}"))
            else:
                raise RuntimeError("gallery-dl não encontrou nada para baixar neste link.")
        return self.arquivos


def _arquivos_novos(pasta: str, desde: float) -> list[str]:
    achados = []
    for raiz, _, nomes in os.walk(pasta):
        for n in nomes:
            p = os.path.join(raiz, n)
            try:
                if os.path.getmtime(p) >= desde - 1 and not n.endswith((".part", ".json")):
                    achados.append(p)
            except OSError:
                pass
    return achados
