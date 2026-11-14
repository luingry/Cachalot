# Desenvolvimento do Cachalot

Arquitetura, build, releases e variáveis do backend. Para usar o Cachalot, veja o [README](../README.md).

## Como ele decide

1. **Reconhece a fonte** (`fontes.py`): plataforma, playlist ou item, arquivo direto (pela extensão ou por um `HEAD` rápido), galeria, torrent ou busca.
2. **Escolhe o motor** e encadeia reservas: extrator nativo → yt-dlp → gallery-dl → navegador invisível. O erro mostrado é o mais útil, em português, com o que fazer (`diagnostico.py`).
3. **Contorna bloqueios** antes de desistir: cookies do site, outro cliente do YouTube, impersonação de navegador (curl_cffi), IPv4 + referer em 403, formato mais simples quando o pedido não existe.
4. **Fila educada**: N downloads ao mesmo tempo, limite e intervalo por site (YouTube, Instagram, TikTok e X: 2; Reddit: 3; outros: 4), novas tentativas com espera crescente só para falhas passageiras.
5. **Pausar é pausar**: retomar continua do ponto (yt-dlp e HTTP segmentado), cancelar apaga só os parciais daquele download. O que estava baixando quando o SwissTechKnife fechou volta pausado.

## Estrutura

| Pasta/arquivo | Papel |
|---|---|
| `servidor.py` | Backend: WebSocket, fila (`Agendador`), motores e reservas |
| `fontes.py`, `nativos.py`, `opcoes_ytdlp.py`, `diagnostico.py` | Reconhecimento, extratores próprios, opções do yt-dlp, erros |
| `direto.py`, `galerias.py`, `torrents.py`, `sniffer.py`, `dependencias.py` | Motores HTTP, gallery-dl, libtorrent, navegador invisível, instalação sob demanda |
| `stk/Cachalot.Module` | Módulo WPF (.NET Framework 4.8): página, configurações, ponte da extensão, canais, atalho |
| `stk/Cachalot.DevHost` | Roda o módulo fora do host; `--snapshot <pasta>` renderiza a UI |
| `stk/Cachalot.Tests` | Testes C# (`--integration` usa o backend real e a rede) |
| `tests/` | Testes do backend Python (`py -3 -m unittest discover -s tests`) |
| `extension/chrome` | Extensão MV3 ([README](../extension/README.md)) |
| `assets/brand/cachalot-icon.json` | Fonte vetorial do ícone; `stk/scripts/render-icon.ps1` gera PNGs e SVG |

## Build, testes e release

```powershell
powershell -File stk/scripts/build.ps1                # build + testes + snapshots + pacote
powershell -File stk/scripts/build.ps1 -Integration   # + teste com o backend real e a rede
powershell -File stk/scripts/sync-extension.ps1       # copia a extensão para a pasta que o Chrome carrega
powershell -File stk/scripts/install-local.ps1        # instala o build no SwissTechKnife desta máquina e reinicia
powershell -File stk/scripts/render-icon.ps1          # depois de editar o ícone
powershell -File stk/scripts/update-sdk.ps1 -HostRepo ..\SwissTechKnife
```

- Pacote: `artifacts/vd-get-<versão>.zip`.
- Release: subir a `Version` em `stk/Directory.Build.props` na `main` publica `module-v<versão>` (`.github/workflows/module-release.yml`) e o catálogo do SwissTechKnife se atualiza sozinho. As notas (em inglês) ficam em `releaseNotes` de `stk/Cachalot.Module/module.json`.
- O id do módulo continua `vd-get` (nome antigo), para manter histórico e configurações de quem já usava.

## Variáveis do `servidor.py`

Todas opcionais:

| Variável | Efeito |
|---|---|
| `VDGET_HOSTED=1` | Modo módulo: não mexe em janelas da versão avulsa |
| `VDGET_HOST` / `VDGET_PORT` | Endereço e porta do WebSocket (padrão `localhost:8765`) |
| `VDGET_IDLE_SECONDS` | Segundos sem atividade até fechar (padrão 180; `0` desliga) |
| `VDGET_DOWNLOADS` / `VDGET_DATA` | Pasta de downloads padrão / pasta gravável (cookies, histórico do gallery-dl, metadados de torrent) |
| `VDGET_SNIFFER=0` / `VDGET_AUTO_UPDATE=0` | Desligam o navegador invisível / a atualização diária do yt-dlp |

## Versão avulsa (navegador)

`iniciar.bat` + `index.html` continuam funcionando com o mesmo backend (protocolo compatível), com os recursos de antes; as opções novas existem só no módulo. Detalhes do protocolo `vdget://` e do `controlador.py` no histórico do repositório.
