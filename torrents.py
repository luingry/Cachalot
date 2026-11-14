"""
torrents.py — magnet links e arquivos .torrent (locais ou por URL) com libtorrent.

Uma sessão por processo, criada no primeiro torrent. Ao terminar, o torrent sai da sessão e os arquivos
ficam na pasta (sem semear depois). Pausar mantém o que já veio; cancelar apaga o parcial.
O pacote `libtorrent` é instalado na primeira vez que um torrent aparece.
"""

import os
import re
import threading
import time
import urllib.request

import dependencias

TRACKERS_PUBLICOS = (
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://explodie.org:6969/announce",
    "https://tracker.tamersunion.org:443/announce",
    "udp://opentracker.io:6969/announce",
)

_sessao = None
_lock = threading.Lock()


def _lt():
    return dependencias.garantir_modulo("libtorrent", "libtorrent")


def sessao(porta: int = 6881, upnp: bool = True):
    global _sessao
    with _lock:
        if _sessao is None:
            lt = _lt()
            ajustes = {
                "listen_interfaces": f"0.0.0.0:{porta},[::]:{porta}",
                "enable_upnp": bool(upnp),
                "enable_natpmp": bool(upnp),
                "enable_dht": True,
                "enable_lsd": True,
                "alert_mask": 0,
                "user_agent": "Cachalot/1.0 libtorrent",
            }
            _sessao = lt.session(ajustes)
        return _sessao


def encerrar():
    global _sessao
    with _lock:
        _sessao = None


class Torrent:
    def __init__(self, fonte: str, destino: str, porta: int = 6881, upnp: bool = True,
                 trackers_extras: bool = True, limite_bytes: int = 0, progresso=None, pasta_cache: str = ""):
        self.fonte = fonte.strip()
        self.pasta_cache = pasta_cache
        self.parciais: list[str] = []
        self.destino = destino
        self.porta = porta
        self.upnp = upnp
        self.trackers_extras = trackers_extras
        self.limite = limite_bytes
        self.progresso = progresso
        self.nome = ""
        self.arquivo = ""
        self._sinal = None
        self._handle = None

    def parar(self):
        self._sinal = "pausar"

    def cancelar(self):
        self._sinal = "cancelar"

    def baixar(self) -> str:
        lt = _lt()
        s = sessao(self.porta, self.upnp)
        os.makedirs(self.destino, exist_ok=True)
        self._antes = set(os.listdir(self.destino))
        if self.fonte.lower().startswith("magnet:"):
            params = lt.parse_magnet_uri(self.fonte)
            cache = self._cache_metadados()
            if cache and os.path.isfile(cache):
                # Retomada: os metadados já vieram antes, não precisa esperar os pares de novo.
                try:
                    params.ti = lt.torrent_info(cache)
                except RuntimeError:
                    pass
        else:
            dados = self._ler_torrent()
            params = lt.add_torrent_params()
            params.ti = lt.torrent_info(lt.bdecode(dados))
        params.save_path = self.destino
        if self.trackers_extras:
            params.trackers = list(params.trackers) + [t for t in TRACKERS_PUBLICOS if t not in params.trackers]
        h = s.add_torrent(params)
        self._handle = h
        if self.limite:
            h.set_download_limit(int(self.limite))
        try:
            return self._acompanhar(lt, s, h)
        finally:
            self._handle = None

    def _cache_metadados(self) -> str:
        m = re.search(r"btih:([0-9a-zA-Z]{32,40})", self.fonte)
        if not m or not self.pasta_cache:
            return ""
        return os.path.join(self.pasta_cache, m.group(1).lower() + ".torrent")

    def _guardar_metadados(self, lt, h):
        caminho = self._cache_metadados()
        if not caminho or os.path.isfile(caminho):
            return
        try:
            ti = h.torrent_file()
            if ti is None:
                return
            os.makedirs(os.path.dirname(caminho), exist_ok=True)
            with open(caminho, "wb") as f:
                f.write(lt.bencode(lt.create_torrent(ti).generate()))
        except Exception:
            pass

    def _registrar_arquivos(self, h):
        """Arquivos do torrent que ainda não existiam: só esses são apagados num cancelamento."""
        try:
            ti = h.torrent_file()
            arquivos = ti.files()
            for i in range(arquivos.num_files()):
                relativo = arquivos.file_path(i)
                topo = relativo.replace("\\", "/").split("/")[0]
                p = os.path.join(self.destino, relativo)
                if topo not in self._antes and p not in self.parciais:
                    self.parciais.append(p)
        except Exception:
            pass

    def _ler_torrent(self) -> bytes:
        if os.path.isfile(self.fonte):
            with open(self.fonte, "rb") as f:
                return f.read()
        pedido = urllib.request.Request(self.fonte, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(pedido, timeout=30) as r:
            return r.read(20 * 1024 * 1024)

    def _acompanhar(self, lt, s, h) -> str:
        opcoes = getattr(lt, "options_t", None) or lt.session
        while True:
            if self._sinal:
                apagar = self._sinal == "cancelar"
                s.remove_torrent(h, opcoes.delete_files if apagar else 0)
                raise InterruptedError(self._sinal)
            st = h.status()
            if st.has_metadata and not self.nome:
                self.nome = st.name
                self._guardar_metadados(lt, h)
                self._registrar_arquivos(h)
            if self.progresso:
                self.progresso(st)
            if st.is_seeding or st.state in (lt.torrent_status.seeding, lt.torrent_status.finished):
                nome = self.nome or st.name
                s.remove_torrent(h)
                self.arquivo = os.path.join(self.destino, nome)
                return self.arquivo
            erro = getattr(st, "errc", None)
            if erro is not None and erro.value():
                s.remove_torrent(h)
                raise RuntimeError(f"Torrent com erro: {erro.message()}")
            time.sleep(1)


def descricao(st) -> dict:
    """Campos de progresso no formato dos outros downloads."""
    estados = {0: "Verificando", 1: "Verificando", 2: "Buscando metadados", 3: "Baixando", 4: "Concluído", 5: "Concluído",
               6: "Preparando", 7: "Verificando o que já veio"}
    return {
        "progresso": round(float(st.progress) * 100, 1) if st.has_metadata else 0.0,
        "velocidade_bps": int(st.download_rate),
        "baixado_bytes": int(st.total_wanted_done),
        "total_bytes": int(st.total_wanted),
        "pares": int(st.num_peers),
        "fase": estados.get(int(st.state), ""),
        "nome": st.name or "",
    }
