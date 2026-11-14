"""
diagnostico.py — traduz erros de download em causa, mensagem curta em português e o que fazer.

`classificar(texto)` devolve um `Diagnostico`:
  categoria   chave estável (rate_limited, auth_required, …), usada para decidir se vale nova tentativa
  mensagem    o que aparece no card (curta, sem jargão)
  dica        próximo passo para o usuário, quando existe
  repetir     True só para falhas transitórias (limite de taxa, rede) — a fila tenta de novo com espera
"""

import re
from dataclasses import dataclass


@dataclass
class Diagnostico:
    categoria: str
    mensagem: str
    dica: str = ""
    repetir: bool = False


# (padrões, categoria, mensagem, dica, repetir) — primeiro que casar vence.
_REGRAS = [
    ((r"no space left", r"disk full", r"os error 28", r"errno 28", r"espa[çc]o insuficiente"),
     "disk_full", "Sem espaço no disco de destino.", "Libere espaço ou escolha outra pasta.", False),
    ((r"sem runtime javascript",),
     "js_runtime", "O YouTube só liberou imagens: falta o Deno para ler os formatos de vídeo.",
     "Confira a internet e tente de novo (o Cachalot instala o Deno sozinho) ou instale-o em deno.com.", False),
    ((r"confirm you.{0,3}re not a bot", r"po token", r"missing a po token", r"content is not available on this app"),
     "bot_check", "O YouTube pediu verificação anti-robô para este IP.",
     "Importe cookies de uma conta logada (Configurações › Cookies) e tente de novo.", False),
    ((r"http error 429", r"too many requests", r"rate.?limit", r"captcha", r"is blocking requests"),
     "rate_limited", "O site limitou os pedidos por agora.", "Uma nova tentativa sai sozinha em alguns segundos.", True),
    ((r"private video", r"this video is private", r"video is private", r"post privado", r"members.only", r"requires purchase",
      r"join this channel"),
     "restricted", "Conteúdo privado ou só para membros.", "Importe cookies de uma conta com acesso.", False),
    ((r"sign in to", r"login required", r"\blog in\b", r"requires authentication", r"--cookies", r"pediu login",
      r"age.restricted", r"restri[çc][ãa]o de idade", r"inappropriate for some users"),
     "auth_required", "O site pede login para este conteúdo.",
     "Baixe pela extensão do Chrome com a conta logada no site (ela envia o login) ou importe cookies em Configurações › Cookies.", False),
    ((r"unable to handshake", r"sslv3_alert", r"cloudflare", r"just a moment", r"enable javascript and cookies"),
     "tls_fingerprint", "O site bloqueou o acesso automatizado.", "", True),
    ((r"http error 403", r"403 forbidden", r"\bforbidden\b"),
     "forbidden", "O site recusou o acesso (403).",
     "Pode exigir login (importe cookies) ou bloquear downloads fora do navegador; tente pela extensão do Chrome.", False),
    ((r"geo.?restrict", r"not available in your country", r"blocked in your country", r"bloqueado por regi"),
     "geo_blocked", "Conteúdo bloqueado na sua região.", "Use um proxy de outro país (Configurações › Rede).", False),
    ((r"ffmpeg", r"ffprobe", r"merging of multiple formats", r"postprocessing", r"conversion failed"),
     "ffmpeg_needed", "Falhou ao juntar ou converter o arquivo (FFmpeg).",
     "Instale o FFmpeg ou aponte o executável em Configurações › Avançado.", False),
    ((r"video unavailable", r"this video is not available", r"has been removed", r"removed by the uploader",
      r"http error 404", r"http error 410", r"not found", r"n[ãa]o encontrad", r"indispon[íi]vel", r"deleted",
      r"does not exist"),
     "not_found", "Conteúdo não encontrado: removido, privado ou link errado.", "", False),
    ((r"copyright", r"blocked it on copyright"),
     "copyright", "Conteúdo removido por direitos autorais.", "", False),
    ((r"invalid data found when processing input", r"\bdrm\b", r"widevine"),
     "drm", "Conteúdo protegido por DRM: não pode ser baixado.", "", False),
    ((r"unsupported url", r"is not a valid url", r"no suitable extractor"),
     "unsupported", "Este link não é suportado.", "Confira se é o link da página do vídeo ou da publicação.", False),
    ((r"requested format", r"format is not available", r"no video formats", r"no suitable format"),
     "format_unavailable", "O formato pedido não existe para este conteúdo.", "Tente outra qualidade.", False),
    ((r"nsig", r"signature", r"unable to extract", r"cannot parse data", r"please report this issue"),
     "extractor_outdated", "O site mudou e o extrator ainda não acompanhou.",
     "O yt-dlp se atualiza sozinho uma vez por dia; tente de novo mais tarde.", False),
    ((r"fragment.*not found", r"downloaded file is empty", r"conflicting range", r"unable to download video data"),
     "broken_source", "O servidor entregou o arquivo incompleto.", "", True),
    ((r"timed out", r"timeout", r"connection reset", r"connection refused", r"temporary failure in name resolution",
      r"getaddrinfo failed", r"network is unreachable", r"remote end closed", r"incompleteread", r"sem resposta"),
     "network", "Falha de rede durante o download.", "", True),
    ((r"permission denied", r"access is denied", r"errno 13", r"winerror 5"),
     "permission", "Sem permissão para gravar na pasta de destino.", "Escolha outra pasta.", False),
    ((r"invalid argument", r"errno 22", r"filename too long", r"winerror 206"),
     "bad_filename", "O nome do arquivo ficou inválido para o Windows.", "", True),
]

_COMPILADAS = [([re.compile(p, re.IGNORECASE) for p in padroes], cat, msg, dica, rep)
               for padroes, cat, msg, dica, rep in _REGRAS]


def classificar(texto: str) -> Diagnostico:
    t = texto or ""
    for padroes, cat, msg, dica, rep in _COMPILADAS:
        if any(p.search(t) for p in padroes):
            return Diagnostico(cat, msg, dica, rep)
    return Diagnostico("unknown", ultima_linha_de_erro(t), "", True)


def ultima_linha_de_erro(texto: str) -> str:
    """Última linha 'ERROR:' do yt-dlp (sem o prefixo e sem a sugestão de bug report)."""
    linhas = [l.strip() for l in (texto or "").splitlines() if l.strip()]
    erros = [l for l in linhas if l.upper().startswith("ERROR:")]
    linha = (erros[-1] if erros else (linhas[-1] if linhas else "Falhou sem mensagem.")).strip()
    linha = re.sub(r"^ERROR:\s*", "", linha, flags=re.IGNORECASE)
    linha = re.sub(r"\[[\w:]+\]\s*[\w-]+:\s*", "", linha, count=1)
    linha = re.sub(r";\s*please report this issue.*$", "", linha, flags=re.IGNORECASE)
    return linha[:400]


def eh_terminal(texto: str) -> bool:
    """Erros em que outra tentativa com o mesmo motor não adianta."""
    t = (texto or "").lower()
    return any(s in t for s in (
        "not found, unable to continue", "the downloaded file is empty", "video unavailable",
        "this video is not available", "video has been removed", "has been removed by the uploader",
        "this video is private", "video is private", "is not a valid url", "http error 404", "http error 410",
    ))
