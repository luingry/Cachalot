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
| `transientes.py` | Modo transiente: cache do áudio, PCM para a análise, corte das seções em WAV |
| `stk/Cachalot.Module` | Módulo WPF (.NET Framework 4.8): página, configurações, ponte da extensão, canais, atalho |
| `stk/Cachalot.DevHost` | Roda o módulo fora do host; `--snapshot <pasta>` renderiza a UI |
| `stk/Cachalot.Tests` | Testes C# (`--integration` usa o backend real e a rede) |
| `tests/` | Testes do backend Python (`py -3 -m unittest discover -s tests`) |
| `extension/chrome` | Extensão MV3 ([README](../extension/README.md)) |
| `assets/brand/cachalot-icon.json` | Fonte vetorial do ícone; `stk/scripts/render-icon.ps1` gera PNGs e SVG |

## Modo transiente

A extensão transforma o cartão de uma mídia na waveform do áudio, cortada nos transientes. Divisão do trabalho:

1. **Ponte** (`POST /transient/prepare|status|pcm|export|open`, `stk/Cachalot.Module/Bridge/TransientBridge.cs`):
   repassa à ação `transiente` do backend (pedido/resposta por `pedido`) e traduz as respostas; caminhos no disco
   nunca chegam à extensão. `pcm` devolve bytes (`application/octet-stream`), lidos só da pasta de dados do módulo.
2. **Backend** (`servidor.py` + `transientes.py`): `preparar` cria um download **oculto** (só áudio, `original`, sem
   sponsorblock nem capa) para `<dados>/transientes/<sha1 do link>`; `_ocultos` impede que ele chegue à interface
   (broadcast, `estado_inicial`, `ja_na_fila`, pausar todos). Pronto, o ffmpeg tira uma cópia mono de 22 050 Hz
   (`analise.pcm`, até 30 min). O cache guarda as 8 faixas mais recentes. `exportar` corta cada seção do arquivo
   original em WAV, FLAC ou MP3 (`formato`; a ponte manda o lembrado em `Preferences.TransientFormat`, vazio = a
   extensão pergunta, e `POST /transient/format` o devolve) (`-ss` antes do `-i`, fade de 3 ms no fim) na pasta de downloads; os fades de cada seção
   viram um `aeval` por amostra com ganho `x^p`, `p = 4^-curva` (a mesma fórmula de `fadeGain` na extensão).
3. **Extensão** (`src/lib/transients.js`, `popup/transient.js`): fluxo espectral multibanda (5 faixas normalizadas
   cada uma, estilo SuperFlux), picos com limiar adaptativo e força relativa, ataque refinado na energia fina,
   BPM por autocorrelação com preferência por ~120, fase do tempo e tempo forte pelo grave. Os tempos são
   rastreados (`trackBeats`: cada tempo puxado até a batida forte vizinha) e as grades (`gridLines`) cortam em cada
   linha, então a seção tem o tamanho da divisão; a sensibilidade filtra os candidatos do Auto e os ataques em que um
   corte de grade pode grudar (até 15 ms). Tudo recalcula em tempo real. As edições do usuário (divisórias fixadas,
   suprimidas, início/fim, `origin` = início da música marcado pela bandeira) sobrevivem a uma nova detecção.
   `withOrigin` põe o compasso 1 no início marcado: a grade é contada dali e, antes dele, não há cortes.

## Instalação da extensão pelo módulo

`stk/Cachalot.Module/Setup`: na primeira vez que o módulo inicia com a janela do SwissTechKnife visível,
`ExtensionSetup` abre `Views/ExtensionSetupWindow` (se o Chrome existe e a extensão ainda não está nele);
`Preferences.ExtensionPromptShown` (o popup já apareceu) impede que pergunte de novo. Sem Chrome, ou com a extensão já carregada, ele só anota a instalação atual em `ExtensionCheckedInstall` (pasta do módulo + data de criação): desinstalar mantém a pasta de dados, então reinstalar reavalia. O botão **Instalar no Chrome…** abre o mesmo assistente.

- **Detecção** (`ChromeProbe`, só leitura): `Local State` → `profile.last_used`; em `Preferences` e
  `Secure Preferences` de cada perfil, o modo do desenvolvedor fica em `extensions.ui.developer_mode` **ou**
  `account_values.extensions.ui.developer_mode` (perfil sincronizado com conta Google), e a extensão descompactada é
  uma entrada de `extensions.settings` com `location: 4` e `path` igual à pasta. Ambos são protegidos por MAC
  (`protection.macs`): escrever neles faz o Chrome descartar/resetar, por isso o usuário liga o modo e carrega a
  pasta; o assistente só acompanha (a cada 1,5 s, relendo apenas arquivos alterados) e a ponte (`LocalBridge.LastPairedContact`)
  confirma na hora quando a extensão chama com o código certo.
- **Abrir a página de extensões** (`Native/ChromeTab`): o Chrome descarta URLs `chrome://` recebidas pela linha de
  comando, então `chrome.exe chrome://extensions` só abre uma janela vazia. O módulo acha a janela do Chrome mais
  recente (classe `Chrome_WidgetWin_1` de um `chrome.exe`), traz para a frente e manda Ctrl+T, o endereço e Enter,
  conferindo antes de cada tecla que o Chrome continua em primeiro plano. Sem janela, abre o Chrome e espera ela aparecer.
- **Cópia** (`ExtensionInstaller`): espelha `extension/chrome` do pacote em `<dados>/extensao-chrome` e grava
  `pairing.json` (código da ponte: a extensão se pareia sozinha, `src/lib/selfsetup.js`) e `build.json` (carimbo novo a
  cada cópia). Na partida do módulo, se a pasta existe e o hash do pacote mudou (`Preferences.ExtensionBuild`), copia de
  novo; a extensão compara o `build.json` do disco com o que carregou e chama `chrome.runtime.reload()` (sem popup ou
  página da extensão aberta, no máximo uma vez a cada 5 min). `sync-extension.ps1` também grava um `build.json`.

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
