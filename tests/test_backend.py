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
import transientes  # noqa: E402


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


class Transientes(unittest.TestCase):
    def test_lista_e_segmentos(self):
        self.assertEqual(transientes.sem_lista_anexada("https://www.youtube.com/watch?v=abc&list=PL1&index=3"),
                         "https://www.youtube.com/watch?v=abc")
        segs = transientes.validar_segmentos([{"inicio": -1, "fim": 2}, {"inicio": 5, "fim": 5.001},
                                              {"inicio": "x"}, {"inicio": 8, "fim": 99, "numero": 7}], 10)
        self.assertEqual([seg[:3] for seg in segs], [(0.0, 2.0, 1), (8.0, 10.05, 7)])
        com_fade = transientes.validar_segmentos([{"inicio": 0, "fim": 1, "fade_entrada": 0.8, "fade_saida": 0.5,
                                                   "curva_entrada": 3}], 10)[0][3]
        self.assertEqual({k: round(v, 6) for k, v in com_fade.items()},
                         {"entrada": 0.8, "curva_entrada": 1.0, "saida": 0.2, "curva_saida": 0.0})
        self.assertEqual(transientes.filtro_fades(1.0, None), "afade=t=in:st=0:d=0.002,afade=t=out:st=0.997000:d=0.003")
        self.assertIn("aeval=", transientes.filtro_fades(1.0, {"entrada": 0.1, "saida": 0.2}))
        self.assertEqual(transientes.nome_seguro(" a/b: c? "), "a_b_ c_")
        self.assertEqual(transientes.chave("https://a"), transientes.chave(" https://a "))

    def test_decodificar_exportar_e_cache(self):
        import shutil, struct, subprocess, tempfile, wave
        ff = dependencias.ffmpeg()
        if not ff:
            self.skipTest("sem ffmpeg")
        pasta = tempfile.mkdtemp()
        try:
            origem = os.path.join(pasta, "musica.wav")
            with wave.open(origem, "wb") as w:  # 3 s estéreo 44,1 kHz
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(44100)
                w.writeframes(b"".join(struct.pack("<hh", (i * 37) % 2000, 0) for i in range(3 * 44100)))
            t = transientes.Trabalho("abc", "https://x/1", pasta, "Faixa")
            t.arquivo = origem
            t.duracao = transientes.decodificar(ff, origem, t.pcm)
            self.assertAlmostEqual(t.duracao, 3.0, places=2)
            self.assertAlmostEqual(os.path.getsize(t.pcm), 3 * transientes.TAXA_ANALISE * 2, delta=200)
            t.salvar()
            self.assertEqual(transientes.carregar("abc", "https://x/1", pasta).duracao, t.duracao)
            self.assertIsNone(transientes.carregar("abc", "https://x/2", pasta))
            self.assertEqual(transientes.achar_audio(pasta), origem)

            destino = os.path.join(pasta, "saida")
            caminho, arquivos = transientes.exportar(ff, origem, [(0.5, 1.0, 1), (1.0, 2.5, 2)], destino, "Faixa: X", True)
            self.assertEqual(os.path.basename(caminho), "Faixa_ X - seções")
            self.assertEqual([os.path.basename(a) for a in arquivos], ["Faixa_ X - 01.wav", "Faixa_ X - 02.wav"])
            with wave.open(arquivos[1]) as w:
                self.assertEqual((w.getnchannels(), w.getframerate()), (2, 44100))
                self.assertAlmostEqual(w.getnframes() / 44100, 1.5, delta=0.01)
            caminho2, _ = transientes.exportar(ff, origem, [(0, 1, 1)], destino, "Faixa: X", True)
            self.assertTrue(caminho2.endswith("seções (2)"))
            unico, _ = transientes.exportar(ff, origem, [(0, 1, 4)], destino, "Faixa", False)
            self.assertEqual(unico, os.path.join(destino, "Faixa - 04.wav"))
            with wave.open(unico) as w:  # rampa de entrada contra estalo: começa do zero
                primeira = struct.unpack("<hh", w.readframes(1))
            self.assertEqual(primeira, (0, 0))

            # formatos: flac e mp3 saem com a extensão e o codec certos; qualquer outro vira wav
            self.assertEqual(transientes.normalizar_formato("MP3"), "mp3")
            self.assertEqual(transientes.normalizar_formato("ogg"), "wav")
            self.assertEqual(transientes.normalizar_formato(None), "wav")
            ffprobe = os.path.join(os.path.dirname(ff), "ffprobe" + (".exe" if os.name == "nt" else ""))
            for formato, codec in (("flac", "flac"), ("mp3", "mp3")):
                arq, _ = transientes.exportar(ff, origem, [(0.5, 2.0, 1)], destino, "Fmt", False, formato)
                self.assertTrue(arq.endswith("Fmt - 01." + formato), arq)
                if os.path.isfile(ffprobe):
                    r = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
                                        "stream=codec_name", "-of", "csv=p=0", arq], capture_output=True, text=True)
                    self.assertEqual(r.stdout.strip(), codec)
                else:
                    self.assertGreater(os.path.getsize(arq), 1000)

            # fades: a 0.5 s fade-in (linear) and a 0.5 s fade-out (aggressive) on a constant signal
            constante = os.path.join(pasta, "constante.wav")
            with wave.open(constante, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(8000)
                w.writeframes(struct.pack("<h", 16000) * (3 * 8000))
            _, (arq,) = transientes.exportar(ff, constante, [(1.0, 3.0, 1, {"entrada": 0.5, "curva_entrada": 0,
                                                                           "saida": 0.5, "curva_saida": 1})],
                                             destino, "Fade", False)
            with wave.open(arq) as w:
                amostras = struct.unpack(f"<{w.getnframes()}h", w.readframes(w.getnframes()))
            self.assertLess(abs(amostras[0]), 200)                       # começa em silêncio
            self.assertAlmostEqual(amostras[2000] / 16000, 0.5, delta=0.03)  # metade do fade-in linear
            self.assertAlmostEqual(amostras[8000] / 16000, 1.0, delta=0.01)  # meio da seção, volume cheio
            # fade-out agressivo (p = 0,25): no meio dele ainda está em 0,5^0,25 ≈ 0,84
            self.assertAlmostEqual(amostras[16000 - 2000] / 16000, 0.5 ** 0.25, delta=0.03)
            self.assertLess(abs(amostras[-1]), 200)  # o fade de 3 ms contra estalo zera o fim
        finally:
            shutil.rmtree(pasta, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
