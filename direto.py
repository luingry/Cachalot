"""
direto.py — download HTTP direto, segmentado e retomável (arquivos soltos, mídia em CDN, extratores nativos).

- Servidor aceita Range e o arquivo passa de 10 MiB → até N conexões paralelas, uma faixa cada.
- Estado em `<arquivo>.part.json` (salvo a cada 2 s): pausar/fechar e voltar depois continua de onde parou.
- Sem Range → um fluxo só, retomando pelo tamanho do .part quando possível.
- 403 → sobe uma escada de headers (Range: bytes=0-, depois sec-fetch-*) antes de desistir.
- HTML no lugar do arquivo é erro (link de página, não de arquivo).

Bloqueante: chame em executor. O progresso vai por callback; `parar()` (pausa) e `cancelar()` funcionam
de qualquer thread.
"""

import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
SEGMENTO_MIN = 10 * 1024 * 1024
BLOCO = 256 * 1024
TIMEOUT = 30
TENTATIVAS = 3


class Interrompido(Exception):
    """Pausa ou cancelamento pedido pelo usuário (o .part fica para retomar, exceto no cancelamento)."""


class FalhaDireta(Exception):
    pass


class LimiteVelocidade:
    """Balde de fichas compartilhado entre as conexões (bytes/s; 0 = sem limite)."""

    def __init__(self, bytes_por_s: int):
        self.taxa = max(0, int(bytes_por_s or 0))
        self._fichas = float(self.taxa)
        self._t = time.monotonic()
        self._lock = threading.Lock()

    def consumir(self, n: int) -> None:
        if not self.taxa:
            return
        while True:
            with self._lock:
                agora = time.monotonic()
                self._fichas = min(self.taxa, self._fichas + (agora - self._t) * self.taxa)
                self._t = agora
                if self._fichas >= n or self._fichas >= self.taxa:
                    self._fichas -= n
                    return
                falta = (n - self._fichas) / self.taxa
            time.sleep(min(falta, 0.5))


def taxa_em_bytes(texto: str) -> int:
    """'500K', '2M', '1.5M' → bytes/s. Vazio ou inválido → 0 (sem limite)."""
    m = re.fullmatch(r"\s*(\d+(?:[.,]\d+)?)\s*([kmg]?)i?b?(?:/s)?\s*", (texto or "").lower())
    if not m:
        return 0
    valor = float(m.group(1).replace(",", "."))
    return int(valor * {"": 1, "k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}[m.group(2)])


def nome_do_cabecalho(disposicao: str) -> str:
    m = re.search(r"filename\*\s*=\s*[^']*''([^;]+)", disposicao or "", re.IGNORECASE)
    if m:
        return urllib.parse.unquote(m.group(1)).strip('" ')
    m = re.search(r'filename\s*=\s*"?([^";]+)"?', disposicao or "", re.IGNORECASE)
    return m.group(1).strip() if m else ""


def nome_da_url(url: str) -> str:
    try:
        return urllib.parse.unquote(urllib.parse.urlparse(url).path.rsplit("/", 1)[-1])
    except ValueError:
        return ""


_INVALIDOS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def nome_seguro(nome: str, padrao: str = "download") -> str:
    s = _INVALIDOS.sub("", (nome or "").strip()).strip(". ")
    if len(s) > 180:
        base, ext = os.path.splitext(s)
        s = base[: 180 - len(ext)] + ext
    return s or padrao


def caminho_livre(caminho: str) -> str:
    """'arquivo.ext' → 'arquivo (1).ext' quando já existe (nunca sobrescreve)."""
    if not os.path.exists(caminho):
        return caminho
    base, ext = os.path.splitext(caminho)
    i = 1
    while os.path.exists(f"{base} ({i}){ext}"):
        i += 1
    return f"{base} ({i}){ext}"


class _Aberta:
    """Resposta HTTP registrada no download enquanto está aberta (para pausar/cancelar a interromperem)."""

    def __init__(self, dono, resposta):
        self._dono = dono
        self._r = dono._registrar(resposta)

    def __enter__(self):
        return self._r

    def __exit__(self, *exc):
        self._dono._abertas.discard(self._r)
        try:
            self._r.close()
        except Exception:
            pass
        return False


class DownloadDireto:
    def __init__(self, url: str, pasta: str, nome: str = "", headers: dict | None = None,
                 conexoes: int = 8, limite: LimiteVelocidade | None = None, progresso=None,
                 proxy: str = "", verificar_tls: bool = True):
        self.url = url
        self.pasta = pasta
        self.nome = nome
        self.headers = {"User-Agent": UA, **(headers or {})}
        self.conexoes = max(1, min(32, int(conexoes or 1)))
        self.limite = limite or LimiteVelocidade(0)
        self.progresso = progresso
        self._sinal = None          # None | "pausar" | "cancelar"
        self._lock = threading.Lock()
        self._baixado = 0
        self.total = 0
        self.arquivo_final = ""
        self.parte = ""             # caminho do .part, conhecido depois da sondagem
        self._abertas: set = set()
        self._abridor = self._montar_abridor(proxy, verificar_tls)

    # ── controle ──
    def parar(self):
        self._sinal = "pausar"
        self._fechar_conexoes()

    def cancelar(self):
        self._sinal = "cancelar"
        self._fechar_conexoes()

    def _fechar_conexoes(self):
        """Fecha as respostas abertas: um read() bloqueado volta na hora em vez de esperar o timeout."""
        for r in list(self._abertas):
            try:
                r.close()
            except Exception:
                pass

    def _registrar(self, r):
        self._abertas.add(r)
        if self._sinal:
            self._fechar_conexoes()
        return r

    def _checar(self):
        if self._sinal:
            raise Interrompido(self._sinal)

    # ── rede ──
    @staticmethod
    def _montar_abridor(proxy: str, verificar_tls: bool):
        manipuladores = []
        if proxy:
            manipuladores.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        if not verificar_tls:
            import ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            manipuladores.append(urllib.request.HTTPSHandler(context=ctx))
        return urllib.request.build_opener(*manipuladores)

    def _abrir(self, extra: dict | None = None, metodo: str | None = None):
        h = dict(self.headers)
        h.update(extra or {})
        return _Aberta(self, self._abridor.open(urllib.request.Request(self.url, headers=h, method=metodo), timeout=TIMEOUT))

    def _sondar(self):
        """(tamanho, aceita_range, nome, tipo). Tenta HEAD, depois GET bytes=0-0; 403 sobe a escada de headers."""
        escadas = [{}, {"Range": "bytes=0-"}, {"Range": "bytes=0-", "Sec-Fetch-Dest": "document",
                                                "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none"}]
        ultimo = None
        fila_degraus = list(escadas)
        esperas_429 = 2
        while fila_degraus:
            degrau = fila_degraus.pop(0)
            try:
                with self._abrir({**degrau, "Range": "bytes=0-0"}) as r:
                    tipo = (r.headers.get("Content-Type") or "").lower()
                    nome = nome_do_cabecalho(r.headers.get("Content-Disposition") or "")
                    faixa = r.headers.get("Content-Range") or ""
                    if r.status == 206 and "/" in faixa:
                        total = int(faixa.rsplit("/", 1)[-1]) if faixa.rsplit("/", 1)[-1].isdigit() else 0
                        self.headers.update({k: v for k, v in degrau.items() if k != "Range"})
                        return total, True, nome, tipo
                    total = int(r.headers.get("Content-Length") or 0)
                    aceita = "bytes" in (r.headers.get("Accept-Ranges") or "").lower()
                    self.headers.update({k: v for k, v in degrau.items() if k != "Range"})
                    return total, aceita and total > 0, nome, tipo
            except urllib.error.HTTPError as e:
                ultimo = e
                if e.code == 403:
                    continue
                if e.code == 429 and esperas_429 > 0:
                    esperas_429 -= 1
                    time.sleep(4)
                    fila_degraus.insert(0, degrau)
                    continue
                if e.code in (400, 401, 404, 405, 410, 451):
                    raise FalhaDireta(f"HTTP Error {e.code}: {e.reason}") from e
                if e.code == 416:
                    break
                raise FalhaDireta(f"HTTP Error {e.code}: {e.reason}") from e
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                raise FalhaDireta(f"Sem resposta do servidor: {e}") from e
        if isinstance(ultimo, urllib.error.HTTPError):
            raise FalhaDireta(f"HTTP Error {ultimo.code}: {ultimo.reason}")
        return 0, False, "", ""

    # ── execução ──
    def baixar(self) -> str:
        total, aceita, nome_srv, tipo = self._sondar()
        self._checar()
        if "text/html" in tipo:
            raise FalhaDireta("O link abre uma página, não um arquivo.")
        self.total = total
        nome = nome_seguro(self.nome or nome_srv or nome_da_url(self.url))
        os.makedirs(self.pasta, exist_ok=True)
        destino = os.path.join(self.pasta, nome)
        if os.path.exists(destino) and total and os.path.getsize(destino) == total:
            self.arquivo_final = destino
            return destino        # já baixado (mesmo tamanho): não duplica
        parte = destino + ".part"
        self.parte = parte
        estado_path = parte + ".json"
        try:
            if aceita and total >= SEGMENTO_MIN and self.conexoes > 1:
                self._segmentado(parte, estado_path, total)
            else:
                self._continuo(parte, aceita)
        except Interrompido as e:
            if str(e) == "cancelar":
                for p in (parte, estado_path):
                    try:
                        os.remove(p)
                    except OSError:
                        pass
            raise
        if total and os.path.getsize(parte) != total:
            raise FalhaDireta(f"Arquivo incompleto ({os.path.getsize(parte)} de {total} bytes).")
        with open(parte, "rb") as f:
            inicio = f.read(512).lstrip().lower()
        if inicio.startswith((b"<!doctype html", b"<html")):
            os.remove(parte)
            raise FalhaDireta("O servidor devolveu uma página HTML em vez do arquivo.")
        final = caminho_livre(destino)
        os.replace(parte, final)
        try:
            os.remove(estado_path)
        except OSError:
            pass
        self.arquivo_final = final
        return final

    def _avisar(self, n: int):
        with self._lock:
            self._baixado += n
            feito = self._baixado
        if self.progresso:
            self.progresso(feito, self.total)

    def _continuo(self, parte: str, aceita: bool):
        inicio = os.path.getsize(parte) if (aceita and os.path.exists(parte)) else 0
        for tentativa in range(TENTATIVAS):
            self._checar()
            try:
                extra = {"Range": f"bytes={inicio}-"} if inicio else {}
                with self._abrir(extra) as r, open(parte, "ab" if inicio else "wb") as f:
                    if inicio and r.status != 206:
                        f.seek(0)
                        f.truncate()
                        inicio = 0
                    self._baixado = inicio
                    if not self.total:
                        self.total = int(r.headers.get("Content-Length") or 0) + inicio
                    while True:
                        self._checar()
                        bloco = r.read(BLOCO)
                        if not bloco:
                            return
                        self.limite.consumir(len(bloco))
                        f.write(bloco)
                        inicio += len(bloco)
                        self._avisar(len(bloco))
            except Interrompido:
                raise
            except Exception as e:
                if self._sinal:  # a conexão foi fechada de propósito (pausa/cancelamento)
                    raise Interrompido(self._sinal) from e
                if isinstance(e, urllib.error.HTTPError):
                    if e.code in (400, 401, 403, 404, 405, 410, 451) or tentativa == TENTATIVAS - 1:
                        raise FalhaDireta(f"HTTP Error {e.code}: {e.reason}") from e
                elif isinstance(e, (urllib.error.URLError, TimeoutError, OSError, ValueError, AttributeError)):
                    if tentativa == TENTATIVAS - 1:
                        raise FalhaDireta(f"Conexão caiu: {e}") from e
                else:
                    raise
            time.sleep(1 + tentativa)

    def _segmentado(self, parte: str, estado_path: str, total: int):
        chave = hashlib.sha256(self.url.encode()).hexdigest()[:16]
        faixas = None
        if os.path.exists(parte) and os.path.exists(estado_path):
            try:
                with open(estado_path, encoding="utf-8") as f:
                    salvo = json.load(f)
                if salvo.get("url_hash") == chave and salvo.get("total") == total:
                    faixas = salvo["faixas"]
            except (OSError, ValueError, KeyError):
                faixas = None
        if faixas is None:
            n = min(self.conexoes, max(1, -(-total // SEGMENTO_MIN)))
            passo = total // n
            faixas = [{"ini": i * passo, "fim": (total - 1 if i == n - 1 else (i + 1) * passo - 1), "feito": 0} for i in range(n)]
            with open(parte, "wb") as f:
                f.truncate(total)
        self._baixado = sum(fx["feito"] for fx in faixas)
        erros: list[BaseException] = []
        travas = threading.Lock()

        def salvar():
            with travas:
                dados = {"url_hash": chave, "total": total, "faixas": faixas}
            try:
                with open(estado_path, "w", encoding="utf-8") as f:
                    json.dump(dados, f)
            except OSError:
                pass

        def trabalhar(fx):
            for tentativa in range(TENTATIVAS):
                if self._sinal or erros:
                    return
                pos = fx["ini"] + fx["feito"]
                if pos > fx["fim"]:
                    return
                try:
                    with self._abrir({"Range": f"bytes={pos}-{fx['fim']}"}) as r, open(parte, "r+b") as f:
                        if r.status != 206:
                            raise FalhaDireta("O servidor parou de aceitar downloads em partes.")
                        f.seek(pos)
                        while not self._sinal:
                            bloco = r.read(min(BLOCO, fx["fim"] - (fx["ini"] + fx["feito"]) + 1))
                            if not bloco:
                                break
                            self.limite.consumir(len(bloco))
                            f.write(bloco)
                            with travas:
                                fx["feito"] += len(bloco)
                            self._avisar(len(bloco))
                    if fx["ini"] + fx["feito"] > fx["fim"] or self._sinal:
                        return
                except Exception as e:
                    if self._sinal:  # conexão fechada de propósito (pausa/cancelamento)
                        return
                    if isinstance(e, urllib.error.HTTPError):
                        if e.code == 429:
                            time.sleep(5)
                        elif e.code in (400, 401, 403, 404, 410) or tentativa == TENTATIVAS - 1:
                            erros.append(FalhaDireta(f"HTTP Error {e.code}: {e.reason}"))
                            return
                    elif tentativa == TENTATIVAS - 1:
                        erros.append(e if isinstance(e, FalhaDireta) else FalhaDireta(f"Conexão caiu: {e}"))
                        return
                time.sleep(1 + tentativa * 0.5)

        threads = [threading.Thread(target=trabalhar, args=(fx,), daemon=True) for fx in faixas]
        for t in threads:
            t.start()
        ultimo_salvo = time.monotonic()
        while any(t.is_alive() for t in threads):
            for t in threads:
                t.join(timeout=0.25)
            if time.monotonic() - ultimo_salvo > 2:
                salvar()
                ultimo_salvo = time.monotonic()
        salvar()
        self._checar()
        if erros:
            raise erros[0]
