"""
opcoes_ytdlp.py — transforma as opções de um download nas opções do yt-dlp.

Monta a mesma linha de comando que se usaria no terminal e deixa o próprio yt-dlp convertê-la
(`yt_dlp.parse_options`): assim pós-processadores com várias peças (SponsorBlock, legendas, extrair
áudio, embutir capa) saem exatamente como na CLI, e as "flags extras" do usuário entram do mesmo jeito.

Opções do download (todas opcionais; ver PADROES):
  modo                 video | audio
  qualidade            melhor | 2160 | 1440 | 1080 | 720 | 480 | 360 | menor
  formato_audio        original | m4a | mp3 | opus | flac | wav
  modelo_nome          titulo | titulo_id | canal_titulo | data_titulo | <modelo do yt-dlp>
  pular_existentes, embutir_metadados, embutir_miniatura, dividir_capitulos, ao_vivo_do_inicio
  salvar_capa          também deixa a capa como arquivo .jpg ao lado (desligado: só embutida, nunca solta)
  legendas             nao | arquivo | embutir ; legendas_auto ; idiomas_legenda "pt,en" ; manter_vtt
  sponsorblock         nao | remover | marcar ; sponsorblock_categorias "sponsor,selfpromo,interaction"
  limite_velocidade    "2M" ; fragmentos 1..16 ; proxy ; user_agent ; ignorar_tls
  cookies_arquivo ; cookies_navegador ; flags_extras
"""

import optparse
import re
import shlex

import yt_dlp

PADROES = {
    "modo": "video",
    "qualidade": "melhor",
    "formato_audio": "original",
    "modelo_nome": "titulo",
    "pular_existentes": True,
    "embutir_metadados": True,
    "embutir_miniatura": True,
    "salvar_capa": False,
    "dividir_capitulos": False,
    "ao_vivo_do_inicio": False,
    "legendas": "nao",
    "legendas_auto": False,
    "idiomas_legenda": "pt,en",
    "manter_vtt": False,
    "sponsorblock": "nao",
    "sponsorblock_categorias": "sponsor,selfpromo,interaction",
    "limite_velocidade": "",
    "fragmentos": 4,
    "proxy": "",
    "user_agent": "",
    "ignorar_tls": False,
    "cookies_arquivo": "",
    "cookies_navegador": "",
    "flags_extras": "",
    "ffmpeg": "",
}

MODELOS = {
    "titulo": "%(title).200B.%(ext)s",
    "titulo_id": "%(title).180B [%(id)s].%(ext)s",
    "canal_titulo": "%(uploader,channel|Desconhecido).60B - %(title).160B.%(ext)s",
    "data_titulo": "%(upload_date>%Y-%m-%d|0000-00-00)s - %(title).180B.%(ext)s",
}

UA_PADRAO = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"

# Nunca aceitas nas flags extras: executam programas ou trocam o motor de download.
_FLAGS_BLOQUEADAS = {
    "--exec", "--exec-before-download", "--external-downloader", "--downloader", "--external-downloader-args",
    "--downloader-args", "--config-location", "--config-locations", "--alias", "--print-to-file", "--batch-file",
    "-a", "--load-info-json", "--update", "-U", "--update-to",
}

ALTURAS = {"2160": 2160, "1440": 1440, "1080": 1080, "720": 720, "480": 480, "360": 360}


def completar(opcoes: dict | None) -> dict:
    o = dict(PADROES)
    for k, v in (opcoes or {}).items():
        if v is not None:
            o[k] = v
    return o


# Contêineres que aceitam capa embutida (yt-dlp EmbedThumbnailPP); WAV não aceita.
SEM_CAPA_EMBUTIDA = ("wav",)


def embutir_capa(o: dict, tem_ffmpeg: bool) -> bool:
    """Embute a capa no arquivo? Nunca em WAV (o yt-dlp falharia e o .jpg convertido ficaria solto na pasta)."""
    if not (o.get("embutir_miniatura", True) and tem_ffmpeg) or o.get("dividir_capitulos"):
        return False
    return not (o.get("modo") == "audio" and o.get("formato_audio") in SEM_CAPA_EMBUTIDA)


def altura_maxima(o: dict) -> int:
    return ALTURAS.get(str(o.get("qualidade")), 0)


def seletor_formato(o: dict, tem_ffmpeg: bool) -> list[str]:
    """Argumentos -f/-S/-x conforme modo e qualidade (mesma lógica do OmniGet, mais 'menor' e 'original')."""
    if o.get("modo") == "audio":
        fmt = o.get("formato_audio") or "original"
        if not tem_ffmpeg:
            return ["-f", "ba/b"]
        if fmt == "original":
            # Opus do YouTube vem em .webm, que não aceita capa embutida; .opus (Ogg) aceita e é só troca de
            # contêiner, sem recodificar.
            return ["-f", "ba/b", "--remux-video", "webm>opus"]
        if fmt == "m4a":
            return ["-f", "ba/b", "-S", "+codec:aac:m4a"]
        return ["-f", "ba/b", "-x", "--audio-format", fmt, "--audio-quality", "0"]
    if o.get("qualidade") == "menor":
        return ["-f", "wv*+wa/w" if tem_ffmpeg else "w/wv*"]
    h = altura_maxima(o)
    if tem_ffmpeg:
        if h:
            return ["-f", f"bv*[height<={h}]+ba[ext=m4a]/bv*[height<={h}]+ba/b[height<={h}]/b"]
        return ["-f", "bv*+ba[ext=m4a]/bv*+ba/b"]
    return ["-f", f"b[height<={h}]/bv*[height<={h}]/b" if h else "b/bv*"]


def _idiomas(texto: str) -> str:
    codigos = [c.strip() for c in re.split(r"[,;\s]+", texto or "") if c.strip()]
    if not codigos:
        codigos = ["pt", "en"]
    # Sem metadados para escolher a faixa exata: o código e variantes curtas (pt, pt-BR); o chat ao vivo
    # nunca é legenda. (O yt-dlp compara sem diferenciar maiúsculas, então não dá para separar en-GB de en-de.)
    return ",".join([f"{re.escape(c)}(-[A-Za-z]{{2}})?" if "*" not in c and "(" not in c else c for c in codigos] + ["-live_chat"])


def modelo_de(o: dict) -> str:
    m = (o.get("modelo_nome") or "titulo").strip()
    return MODELOS.get(m, m if "%(" in m else MODELOS["titulo"])


def argumentos(o: dict, destino: str, plataforma: str, *, ffmpeg: str, js_runtimes: list[str],
               cookies: dict | None = None, ajustes: dict | None = None, nome_fixo: str = "") -> list[str]:
    """Linha de comando do yt-dlp para este download (sem a URL)."""
    a = ajustes or {}
    yt = plataforma == "youtube"
    tem_ffmpeg = bool(ffmpeg)
    trim = max(40, min(200, 250 - len(destino or "")))
    args = [
        "--ignore-config", "--no-warnings", "--quiet", "--color", "never",
        "--no-playlist", "--no-mtime", "--windows-filenames", "--trim-filenames", str(trim),
        "--socket-timeout", "30", "--retries", "5", "--fragment-retries", "5", "--extractor-retries", "3",
        "--file-access-retries", "3", "--retry-sleep", "exp=1:30", "--skip-unavailable-fragments",
        "--buffer-size", "1M",
        "-N", str(max(1, min(16, int(a.get("fragmentos") or o.get("fragmentos") or 4)))),
        "-P", destino,
        "-o", nome_fixo.replace("%", "%%") + ".%(ext)s" if nome_fixo else modelo_de(o),
    ]
    if not yt:
        args += ["--http-chunk-size", "10M"]
    args.append("--no-overwrites" if o.get("pular_existentes", True) else "--force-overwrites")
    if ffmpeg:
        args += ["--ffmpeg-location", ffmpeg]

    formato = a.get("formato") or seletor_formato(o, tem_ffmpeg)
    if isinstance(formato, str):
        formato = ["-f", formato]
    args += formato
    if tem_ffmpeg and o.get("modo") != "audio" and not a.get("sem_merge"):
        args += ["--merge-output-format", "mp4"]

    if o.get("embutir_metadados", True) and tem_ffmpeg:
        args.append("--embed-metadata")
    if embutir_capa(o, tem_ffmpeg) and not a.get("sem_capa"):
        args.append("--embed-thumbnail")
    if o.get("salvar_capa") and not o.get("dividir_capitulos"):
        args.append("--write-thumbnail")
    if tem_ffmpeg and ("--embed-thumbnail" in args or "--write-thumbnail" in args):
        args += ["--convert-thumbnails", "jpg"]
    if o.get("dividir_capitulos") and tem_ffmpeg:
        args.append("--split-chapters")
    if o.get("ao_vivo_do_inicio"):
        args += ["--live-from-start", "--no-part"]

    legendas = o.get("legendas") or "nao"
    exatas = o.get("legendas_exatas")  # faixas escolhidas com os metadados em mãos (servidor.escolher_legendas)
    if exatas is not None and not exatas:
        legendas = "nao"  # o vídeo não tem legenda nesses idiomas: segue sem, em silêncio
    if legendas != "nao" and not a.get("sem_legendas"):
        idiomas = ",".join(re.escape(e) for e in exatas) if exatas else _idiomas(o.get("idiomas_legenda"))
        args += ["--write-subs", "--sub-langs", idiomas, "--sub-format", "best"]
        if o.get("legendas_auto"):
            args.append("--write-auto-subs")
        if tem_ffmpeg and not o.get("manter_vtt"):
            args += ["--convert-subs", "srt"]
        if legendas == "embutir" and tem_ffmpeg and o.get("modo") != "audio":
            args.append("--embed-subs")
        if yt:
            args += ["--sleep-subtitles", "5"]

    sb = o.get("sponsorblock") or "nao"
    if yt and sb in ("remover", "marcar"):
        cats = ",".join(c.strip() for c in (o.get("sponsorblock_categorias") or "").split(",") if c.strip()) or "default"
        args += ["--sponsorblock-remove" if sb == "remover" else "--sponsorblock-mark", cats]

    taxa = (o.get("limite_velocidade") or "").strip()
    if taxa and re.fullmatch(r"\d+(?:\.\d+)?[KkMmGg]?", taxa):
        args += ["--limit-rate", taxa.upper()]
    if o.get("proxy"):
        args += ["--proxy", o["proxy"].strip()]
    args += ["--user-agent", (o.get("user_agent") or "").strip() or UA_PADRAO]
    if o.get("ignorar_tls"):
        args.append("--no-check-certificates")
    if a.get("forcar_ipv4"):
        args.append("--force-ipv4")
    if a.get("referer"):
        args += ["--referer", a["referer"]]
    if a.get("nomes_restritos"):
        args.append("--restrict-filenames")
    if a.get("impersonate"):
        args += ["--impersonate", a["impersonate"]]
    for h, v in (a.get("headers") or {}).items():
        args += ["--add-headers", f"{h}:{v}"]

    c = cookies if cookies is not None else {}
    if c.get("arquivo"):
        args += ["--cookies", c["arquivo"]]
    elif c.get("navegador"):
        args += ["--cookies-from-browser", c["navegador"]]

    if yt:
        args += ["--throttled-rate", "100K"]
        partes = []
        if a.get("player_client"):
            partes.append("player_client=" + ",".join(a["player_client"]))
        if partes:
            args += ["--extractor-args", "youtube:" + ";".join(partes)]
        if a.get("sono_requisicoes"):
            args += ["--sleep-requests", "1", "--sleep-interval", "2", "--max-sleep-interval", "5"]
    for runtime in js_runtimes:
        args += ["--js-runtimes", runtime]
    return args


def flags_extras_validas(texto: str) -> list[str]:
    """Divide as flags extras e tira as proibidas; levanta ValueError com o motivo quando inválidas."""
    if not (texto or "").strip():
        return []
    try:
        partes = shlex.split(texto, posix=True)
    except ValueError as e:
        raise ValueError(f"Flags extras com aspas desbalanceadas: {e}")
    limpas = []
    pular = False
    for p in partes:
        if pular:
            pular = False
            continue
        base = p.split("=", 1)[0]
        if base in _FLAGS_BLOQUEADAS:
            pular = "=" not in p
            continue
        limpas.append(p)
    return limpas


def ydl_opts(args: list[str], extras: list[str]) -> dict:
    """parse_options do próprio yt-dlp. Flags extras inválidas são ignoradas (com ValueError para o log)."""
    try:
        return _parse(args + extras)
    except ValueError:
        if not extras:
            raise
        return _parse(args)


def _parse(argv: list[str]) -> dict:
    try:
        return yt_dlp.parse_options(argv).ydl_opts
    except (SystemExit, optparse.OptParseError) as e:  # argumento inválido
        raise ValueError(f"Opções inválidas para o yt-dlp: {e}") from e
