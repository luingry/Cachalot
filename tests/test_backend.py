"""Testes do backend sem rede: py -3 -m unittest discover -s tests"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import dependencias  # noqa: E402
import diagnostico  # noqa: E402
import direto  # noqa: E402
import fontes  # noqa: E402
import nativos  # noqa: E402
import opcoes_ytdlp  # noqa: E402


class Fontes(unittest.TestCase):
    def test_plataformas(self):
        self.assertEqual(fontes.plataforma("https://youtu.be/abc")[1], "YouTube")
        self.assertEqual(fontes.plataforma("https://x.com/u/status/1")[0], "twitter")
        self.assertEqual(fontes.plataforma("magnet:?xt=urn:btih:abc")[0], "torrent")
        self.assertEqual(fontes.plataforma("https://cdn.exemplo.com.br/a.mp4"), ("", "exemplo.com.br"))
        self.assertEqual(fontes.dominio_raiz("127.0.0.1"), "127.0.0.1")

    def test_galeria_e_perfis(self):
        self.assertTrue(fontes.eh_galeria("https://www.deviantart.com/artista/gallery"))
        self.assertTrue(fontes.eh_galeria("https://www.reddit.com/r/EarthPorn/top"))
        self.assertTrue(fontes.eh_galeria("https://x.com/nasa/media"))
        self.assertFalse(fontes.eh_galeria("https://x.com/nasa/status/1"))
        self.assertFalse(fontes.eh_galeria("https://x.com/home"))
        self.assertFalse(fontes.eh_galeria("https://www.reddit.com/r/pics/comments/abc/titulo"))

    def test_arquivo_direto(self):
        self.assertTrue(fontes.eh_arquivo_direto("https://site.com/arquivos/setup.exe"))
        self.assertTrue(fontes.eh_arquivo_direto("https://cdn.site.com/video.mp4?token=1"))
        self.assertFalse(fontes.eh_arquivo_direto("https://www.youtube.com/watch?v=1"))
        self.assertFalse(fontes.eh_arquivo_direto("https://site.com/pagina.html"))

    def test_playlists(self):
        self.assertTrue(fontes.eh_playlist("https://www.youtube.com/playlist?list=PL1"))
        self.assertTrue(fontes.eh_playlist("https://www.youtube.com/@canal"))
        self.assertFalse(fontes.eh_playlist("https://www.youtube.com/watch?v=1&list=PL1"))
        self.assertTrue(fontes.tem_lista_anexada("https://www.youtube.com/watch?v=1&list=PL1"))

    def test_entradas(self):
        texto = "https://a.com/1 https://b.com/2\n# comentário\nartista - música\nhttps://a.com/1?utm_source=x\n"
        self.assertEqual(fontes.extrair_entradas(texto), ["https://a.com/1", "https://b.com/2", "ytsearch1:artista - música"])
        self.assertEqual(fontes.normalizar_para_comparar("https://youtu.be/xyz?si=abc"),
                         fontes.normalizar_para_comparar("https://www.youtube.com/watch?v=xyz"))


class Diagnostico(unittest.TestCase):
    def test_categorias(self):
        casos = {
            "ERROR: [youtube] x: Sign in to confirm you're not a bot": ("bot_check", False),
            "HTTP Error 429: Too Many Requests": ("rate_limited", True),
            "ERROR: [youtube] x: Private video. Sign in if you've been granted access": ("restricted", False),
            "ERROR: Unsupported URL: https://exemplo.com": ("unsupported", False),
            "ERROR: Postprocessing: ffprobe and ffmpeg not found": ("ffmpeg_needed", False),
            "FalhaDireta: HTTP Error 403: Forbidden": ("forbidden", False),
            "[Errno 28] No space left on device": ("disk_full", False),
            "<urlopen error timed out>": ("network", True),
            "Instagram pediu login para mostrar este conteúdo.": ("auth_required", False),
            "Sem runtime JavaScript para o YouTube: ERROR: [youtube] x: Requested format is not available": ("js_runtime", False),
            "alguma coisa estranha": ("unknown", True),
        }
        for texto, (categoria, repetir) in casos.items():
            d = diagnostico.classificar(texto)
            self.assertEqual((d.categoria, d.repetir), (categoria, repetir), texto)

    def test_runtimes_js_respeita_versao_minima(self):
        # Node 20 é ignorado pelo yt-dlp (mínimo 22): sem outro runtime, a lista fica vazia e o Deno é instalado.
        versoes = {"C:/node.exe": (20, 19, 5), "C:/deno.exe": (2, 9, 8), "C:/bun.exe": (1, 1, 0)}
        com = {"node": "C:/node.exe", "bun": "C:/bun.exe"}
        dependencias._runtimes = None
        with mock.patch.object(dependencias.shutil, "which", side_effect=lambda n: com.get(n)), \
                mock.patch.object(dependencias, "_versao_exe", side_effect=lambda c: versoes.get(c, ())), \
                mock.patch.object(dependencias, "_deno_do_pip", return_value=""):
            self.assertEqual(dependencias.runtimes_js(), [])
            dependencias._runtimes = None
            versoes["C:/node.exe"] = (22, 1, 0)
            self.assertEqual(dependencias.runtimes_js(), ["node:C:/node.exe"])
            dependencias._runtimes = None
            with mock.patch.object(dependencias, "_deno_do_pip", return_value="C:/deno.exe"):
                self.assertEqual(dependencias.runtimes_js(), ["deno:C:/deno.exe", "node:C:/node.exe"])
        dependencias._runtimes = None

    def test_ultima_linha(self):
        texto = "WARNING: x\nERROR: [generic] abc: Unable to download webpage; please report this issue on GitHub"
        self.assertEqual(diagnostico.ultima_linha_de_erro(texto), "Unable to download webpage")


class Opcoes(unittest.TestCase):
    def test_formatos(self):
        o = opcoes_ytdlp.completar({"qualidade": "720"})
        self.assertIn("bv*[height<=720]+ba[ext=m4a]", opcoes_ytdlp.seletor_formato(o, True)[1])
        self.assertEqual(opcoes_ytdlp.seletor_formato(o, False)[1], "b[height<=720]/bv*[height<=720]/b")
        a = opcoes_ytdlp.completar({"modo": "audio", "formato_audio": "flac"})
        self.assertEqual(opcoes_ytdlp.seletor_formato(a, True), ["-f", "ba/b", "-x", "--audio-format", "flac", "--audio-quality", "0"])
        self.assertEqual(opcoes_ytdlp.seletor_formato(a, False), ["-f", "ba/b"])  # sem FFmpeg, nunca converte
        original = opcoes_ytdlp.completar({"modo": "audio"})
        self.assertEqual(opcoes_ytdlp.seletor_formato(original, True), ["-f", "ba/b", "--remux-video", "webm>opus"])

    def test_flags_proibidas(self):
        self.assertEqual(opcoes_ytdlp.flags_extras_validas('--exec "rm -rf x" --embed-chapters --downloader=aria2c'), ["--embed-chapters"])

    def test_parse(self):
        o = opcoes_ytdlp.completar({"legendas": "arquivo", "sponsorblock": "remover", "limite_velocidade": "2M"})
        args = opcoes_ytdlp.argumentos(o, r"C:\tmp", "youtube", ffmpeg="ffmpeg.exe", js_runtimes=[])
        y = opcoes_ytdlp.ydl_opts(args, ["--nao-existe"])  # flag extra inválida é ignorada
        self.assertEqual(y["ratelimit"], 2 * 1024 * 1024)
        self.assertTrue(y["writesubtitles"])
        self.assertIn("SponsorBlock", [p["key"] for p in y["postprocessors"]])


class Direto(unittest.TestCase):
    def test_taxa(self):
        self.assertEqual(direto.taxa_em_bytes("500K"), 500 * 1024)
        self.assertEqual(direto.taxa_em_bytes("1.5M"), int(1.5 * 1024 * 1024))
        self.assertEqual(direto.taxa_em_bytes(""), 0)

    def test_nomes(self):
        self.assertEqual(direto.nome_do_cabecalho("attachment; filename*=UTF-8''v%C3%ADdeo.mp4"), "vídeo.mp4")
        self.assertEqual(direto.nome_do_cabecalho('attachment; filename="a b.zip"'), "a b.zip")
        self.assertEqual(direto.nome_seguro('a<b>:c?.mp4'), "abc.mp4")


class Nativos(unittest.TestCase):
    def test_token_syndication(self):
        # Mesmo algoritmo do embed oficial (base36 de id/1e15*π, sem ponto e zeros das pontas).
        token = nativos._x_token_syndication("1785427906330611745")
        self.assertTrue(token.isalnum() and not token.startswith("0") and not token.endswith("0"))

    def test_extrator_para(self):
        self.assertEqual(nativos.extrator_para("twitter", "https://x.com/a/status/1")[0], nativos.twitter)
        self.assertEqual(nativos.extrator_para("twitch", "https://www.twitch.tv/canal")[0], None)
        self.assertEqual(nativos.extrator_para("twitch", "https://clips.twitch.tv/Slug")[0], nativos.twitch_clipe)


if __name__ == "__main__":
    unittest.main()
