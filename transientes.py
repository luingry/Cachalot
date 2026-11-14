"""Modo transiente: prepara o áudio de uma mídia para a extensão analisar e exporta as seções escolhidas.

O áudio vem do mesmo motor dos downloads (um download oculto, só áudio, sem converter) para uma pasta de cache;
daí sai uma cópia mono de 22 050 Hz em PCM s16le que a extensão desenha e analisa (transientes, BPM, grade).
As seções voltam como intervalos em segundos e são cortadas do arquivo original em WAV, FLAC ou MP3.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

TAXA_ANALISE = 22050
MAX_SEGUNDOS = 30 * 60
MANTER_NO_CACHE = 8
FADE_FINAL_S = 0.003  # tira o estalo do corte no fim de cada seção
FADE_INICIAL_S = 0.002  # e no começo (o corte quase nunca cai num cruzamento por zero)
# formato das seções exportadas -> (extensão, argumentos do codificador)
FORMATOS_EXPORTACAO = {
    "wav": (".wav", ["-c:a", "pcm_s16le"]),
    "flac": (".flac", ["-c:a", "flac", "-compression_level", "5"]),
    "mp3": (".mp3", ["-c:a", "libmp3lame", "-b:a", "320k"]),
}
FORMATO_PADRAO = "wav"
_EXT_IGNORADAS = (".part", ".ytdl", ".json", ".jpg", ".jpeg", ".png", ".webp", ".vtt", ".srt", ".ass", ".nfo", ".pcm", ".tmp")


def chave(url: str) -> str:
    return hashlib.sha1((url or "").strip().encode("utf-8")).hexdigest()[:12]


def sem_lista_anexada(url: str) -> str:
    """watch?v=x&list=y → watch?v=x: o modo transiente quer só a faixa, nunca a playlist inteira."""
    partes = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(partes.query, keep_blank_values=True) if k not in ("list", "index", "start_radio")]
    return urlunsplit(partes._replace(query=urlencode(query)))


def pasta_raiz(pasta_dados: str) -> str:
    return os.path.join(pasta_dados, "transientes")


class Trabalho:
    """Um áudio sendo preparado (ou pronto) para o modo transiente."""

    def __init__(self, tid: str, url: str, pasta: str, titulo: str = ""):
        self.id = tid
        self.url = url
        self.pasta = pasta
        self.titulo = titulo
        self.estado = "baixando"  # baixando | decodificando | pronto | erro
        self.progresso = 0.0
        self.fase = ""
        self.erro = ""
        self.arquivo = ""
        self.duracao = 0.0
        self.dl_id = ""
        self.ultimo = ""  # o que a última exportação gravou (arquivo ou pasta)
        self.criado = time.time()

    @property
    def pcm(self) -> str:
        return os.path.join(self.pasta, "analise.pcm")

    @property
    def info(self) -> str:
        return os.path.join(self.pasta, "info.json")

    def publico(self) -> dict:
        d = {"id": self.id, "estado": self.estado, "progresso": round(self.progresso, 1), "fase": self.fase,
             "erro": self.erro, "titulo": self.titulo}
        if self.estado == "pronto":
            d.update(duracao=self.duracao, taxa=TAXA_ANALISE, pcm=self.pcm, bytes=os.path.getsize(self.pcm))
        return d

    def salvar(self) -> None:
        with open(self.info, "w", encoding="utf-8") as f:
            json.dump({"url": self.url, "titulo": self.titulo, "arquivo": self.arquivo, "duracao": self.duracao,
                       "taxa": TAXA_ANALISE}, f, ensure_ascii=False)


def carregar(tid: str, url: str, pasta: str) -> Trabalho | None:
    """Trabalho já pronto no cache (mesmo link, arquivo e PCM ainda lá), ou None."""
    try:
        with open(os.path.join(pasta, "info.json"), encoding="utf-8") as f:
            info = json.load(f)
    except (OSError, ValueError):
        return None
    t = Trabalho(tid, url, pasta, info.get("titulo") or "")
    t.arquivo = info.get("arquivo") or ""
    t.duracao = float(info.get("duracao") or 0)
    if info.get("url") != url or not os.path.isfile(t.arquivo) or not os.path.isfile(t.pcm) or t.duracao <= 0:
        return None
    t.estado, t.progresso = "pronto", 100.0
    os.utime(pasta)  # o mais recente fica no cache
    return t


def podar_cache(raiz: str, manter: int = MANTER_NO_CACHE, em_uso: set[str] | None = None) -> None:
    """Apaga as pastas mais antigas do cache, nunca as dos trabalhos em andamento."""
    try:
        pastas = [os.path.join(raiz, p) for p in os.listdir(raiz) if os.path.isdir(os.path.join(raiz, p))]
    except OSError:
        return
    pastas.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for p in pastas[manter:]:
        if em_uso and os.path.basename(p) in em_uso:
            continue
        shutil.rmtree(p, ignore_errors=True)


def achar_audio(pasta: str) -> str:
    """O arquivo de mídia que o download deixou na pasta (o maior, sem parciais nem metadados)."""
    melhor, tamanho = "", -1
    try:
        nomes = os.listdir(pasta)
    except OSError:
        return ""
    for nome in nomes:
        caminho = os.path.join(pasta, nome)
        if not os.path.isfile(caminho) or nome.lower().endswith(_EXT_IGNORADAS) or nome == "info.json":
            continue
        t = os.path.getsize(caminho)
        if t > tamanho:
            melhor, tamanho = caminho, t
    return melhor


def _flags_silencioso() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def _rodar(cmd: list[str], timeout: float) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                       creationflags=_flags_silencioso())
    if r.returncode != 0:
        linhas = [l for l in (r.stderr or "").strip().splitlines() if l.strip()]
        raise RuntimeError("ffmpeg: " + (linhas[-1] if linhas else f"código {r.returncode}"))


def decodificar(ffmpeg: str, origem: str, destino_pcm: str) -> float:
    """Mono, 22 050 Hz, PCM s16le (no máximo MAX_SEGUNDOS). Retorna a duração em segundos."""
    if not ffmpeg:
        raise RuntimeError("O modo transiente precisa do ffmpeg. Instale-o nas configurações do Cachalot.")
    tmp = destino_pcm + ".tmp"
    _rodar([ffmpeg, "-v", "error", "-nostdin", "-y", "-i", origem, "-vn", "-map", "0:a:0", "-ac", "1",
            "-ar", str(TAXA_ANALISE), "-t", str(MAX_SEGUNDOS), "-f", "s16le", "-acodec", "pcm_s16le", tmp], timeout=600)
    os.replace(tmp, destino_pcm)
    duracao = os.path.getsize(destino_pcm) / 2 / TAXA_ANALISE
    if duracao <= 0:
        raise RuntimeError("A mídia não tem áudio.")
    return duracao


def titulo_de(texto: str) -> str:
    """'faixa.mp3' → 'faixa'; títulos de verdade passam como vieram."""
    base, ext = os.path.splitext((texto or "").strip())
    return base if base and re.fullmatch(r"\.[A-Za-z0-9]{2,5}", ext or "") else (texto or "").strip()


def nome_seguro(nome: str, max_len: int = 120) -> str:
    nome = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", (nome or "").strip())
    nome = re.sub(r"\s+", " ", nome).strip(" .")
    return (nome[:max_len].rstrip(" .") or "audio")


def caminho_livre(caminho: str) -> str:
    """O próprio caminho se ainda não existe, senão 'nome (2)', 'nome (3)'…"""
    if not os.path.exists(caminho):
        return caminho
    base, ext = os.path.splitext(caminho) if not os.path.isdir(caminho) else (caminho, "")
    n = 2
    while os.path.exists(f"{base} ({n}){ext}"):
        n += 1
    return f"{base} ({n}){ext}"


def validar_segmentos(brutos, duracao: float) -> list[tuple[float, float, int, dict]]:
    """
    [(início, fim, número, fades)] dentro da duração; descarta o que não faz sentido. Número começa em 1.
    fades = {"entrada", "curva_entrada", "saida", "curva_saida"} (segundos; curvas em [-1, 1]), ajustados à seção.
    """
    segmentos = []
    for i, s in enumerate(brutos or []):
        try:
            ini = max(0.0, float(s.get("inicio")))
            fim = min(float(duracao) + 0.05, float(s.get("fim")))
            numero = int(s.get("numero") or i + 1)
            entrada = max(0.0, float(s.get("fade_entrada") or 0))
            saida = max(0.0, float(s.get("fade_saida") or 0))
            curva_entrada = min(1.0, max(-1.0, float(s.get("curva_entrada") or 0)))
            curva_saida = min(1.0, max(-1.0, float(s.get("curva_saida") or 0)))
        except (TypeError, ValueError, AttributeError):
            continue
        if fim - ini < 0.005:
            continue
        entrada = min(entrada, fim - ini)
        saida = min(saida, fim - ini - entrada)
        segmentos.append((ini, fim, numero, {"entrada": entrada, "curva_entrada": curva_entrada,
                                             "saida": saida, "curva_saida": curva_saida}))
    return segmentos


def potencia_curva(curva: float) -> float:
    """Mesma fórmula da extensão: ganho = x^p, p = 4^-curva (curva > 0 agressiva, < 0 suave, 0 linear)."""
    return 4 ** -min(1.0, max(-1.0, float(curva or 0)))


def filtro_fades(duracao: float, fades: dict | None) -> str:
    """-af do corte: fade-in/fade-out com a curva escolhida (aeval, por amostra) e, sempre, rampas de 2/3 ms contra estalo."""
    fades = fades or {}
    entrada, saida = fades.get("entrada") or 0, fades.get("saida") or 0
    partes = []
    if entrada > 0:
        p = potencia_curva(fades.get("curva_entrada"))
        partes.append(f"if(lt(t,{entrada:.6f}),pow(max(t,0)/{entrada:.6f},{p:.6f}),1)")
    if saida > 0:
        p = potencia_curva(fades.get("curva_saida"))
        inicio = duracao - saida
        partes.append(f"if(gt(t,{inicio:.6f}),pow(max({duracao:.6f}-t,0)/{saida:.6f},{p:.6f}),1)")
    filtros = []
    if partes:
        filtros.append("asetpts=PTS-STARTPTS")
        filtros.append("aeval=exprs='val(ch)*" + "*".join(f"({x})" for x in partes) + "':c=same")
    # sempre, contra estalo: o corte começa e termina onde a onda raramente está em zero
    # (e mesmo um fade-out agressivo não chega a zero na última amostra)
    filtros.append(f"afade=t=in:st=0:d={FADE_INICIAL_S}")
    filtros.append(f"afade=t=out:st={max(0.0, duracao - FADE_FINAL_S):.6f}:d={FADE_FINAL_S}")
    return ",".join(filtros)


def normalizar_formato(formato) -> str:
    """'MP3' → 'mp3'; o que não for wav, flac ou mp3 vira wav."""
    f = str(formato or "").strip().lower()
    return f if f in FORMATOS_EXPORTACAO else FORMATO_PADRAO


def exportar(ffmpeg: str, origem: str, segmentos: list[tuple[float, float, int, dict]], destino: str, titulo: str,
             em_pasta: bool, formato: str = FORMATO_PADRAO) -> tuple[str, list[str]]:
    """
    Corta cada seção do arquivo original em WAV, FLAC ou MP3 (formato). em_pasta: todas numa pasta nova '<título> - seções';
    senão (uma seção só) direto no destino. Retorna (pasta ou arquivo gravado, arquivos).
    """
    if not ffmpeg:
        raise RuntimeError("O modo transiente precisa do ffmpeg. Instale-o nas configurações do Cachalot.")
    if not segmentos:
        raise ValueError("Nenhuma seção para baixar.")
    base = nome_seguro(titulo)
    pasta = caminho_livre(os.path.join(destino, f"{base} - seções")) if em_pasta else destino
    os.makedirs(pasta, exist_ok=True)
    extensao, codificador = FORMATOS_EXPORTACAO[normalizar_formato(formato)]
    largura = max(2, len(str(max(seg[2] for seg in segmentos))))
    arquivos = []
    for seg in segmentos:
        ini, fim, numero = seg[:3]
        fades = seg[3] if len(seg) > 3 else None
        duracao = fim - ini
        saida = caminho_livre(os.path.join(pasta, f"{base} - {numero:0{largura}d}{extensao}"))
        _rodar([ffmpeg, "-v", "error", "-nostdin", "-y", "-ss", f"{ini:.6f}", "-i", origem, "-t", f"{duracao:.6f}",
                "-vn", "-map", "0:a:0", "-af", filtro_fades(duracao, fades), *codificador, saida],
               timeout=300)
        arquivos.append(saida)
    return (pasta if em_pasta else arquivos[0]), arquivos
