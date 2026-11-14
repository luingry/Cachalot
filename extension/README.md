# Extensão do Cachalot para Chrome

Extensão (Manifest V3) que envia a página atual, links e mídias detectadas para o
**Cachalot**, o módulo de downloads do SwissTechKnife. Ela só encaminha pedidos: quem
baixa é o Cachalot, no seu computador.

Funciona no Chrome, Edge, Brave e outros navegadores baseados no Chromium (versão 112 ou
mais nova).

## O que ela faz

- **Ícone na barra**: fica colorido em sites que o Cachalot sabe baixar (YouTube,
  Instagram, TikTok, X/Twitter, Reddit, Twitch, Pinterest, Bluesky, Threads, Vimeo,
  SoundCloud, Facebook, Bilibili, Dailymotion, Kick, Bandcamp, Tumblr, Douyin) e em
  qualquer aba onde ela detectou vídeo ou áudio; cinza nas demais. O número no ícone é a
  quantidade de mídias detectadas na aba.
- **Popup** (clique no ícone):
  - estado da conexão: *Conectado ao Cachalot*, *Cachalot fechado — abra o
    SwissTechKnife* ou o campo para colar o código de pareamento;
  - botão de janela ao lado da engrenagem: abre o Cachalot no SwissTechKnife, na frente do navegador;
  - cartão da página atual com **Baixar** e **Só áudio**;
  - **Mídias detectadas nesta página**: listas HLS (`.m3u8`), DASH (`.mpd`) e arquivos
    diretos de vídeo/áudio, com tamanho quando conhecido. As variantes de qualidade de um
    mesmo HLS aparecem numa linha só, e pedaços de streaming (`.ts`, `.m4s`, trechos de
    menos de 1 MB) ficam de fora. A lista vem da **mais recente para a mais antiga**; o botão
    ao lado da contagem inverte a ordem (a escolha fica lembrada). No YouTube o vídeo da própria
    página aparece no cartão da página (miniatura do YouTube e duração, no lugar do ícone do
    site) e é enviado pela página — o Cachalot escolhe a melhor qualidade sozinho; a lista mostra
    os **outros vídeos** que a página exibe com miniatura (recomendados, feed, Shorts), com título
    e duração, inclusive os que forem carregando enquanto o popup está aberto. A prévia desses
    vídeos passa pelos quadros que o YouTube tira do vídeo (início, meio e fim), já que o stream
    do YouTube só toca no player dele. Em **sites de música** (SoundCloud, Bandcamp, Mixcloud,
    Audiomack) o stream do que está tocando vira "Áudio HLS", com título, artista e capa que a
    página informa ao navegador (Media Session), e é baixado como áudio; as outras faixas que a
    página mostra (cards do SoundCloud, faixas de um álbum do Bandcamp, dados `MusicRecording`
    de outros sites) entram na lista com capa, artista e duração, inclusive as que forem
    carregando. **Sons tocam no popup**: clique na capa — a linha ganha um player com o botão que
    vira parar e a linha de progresso que marca a posição e deixa escolher o trecho (clique,
    arraste ou setas). Faixas do SoundCloud listadas na página tocam pelo player oficial do
    SoundCloud, escondido. Cada mídia mostra uma **miniatura**, nesta ordem de preferência:
    a capa (`poster`) do player, um quadro do próprio arquivo ou stream, um recorte do vídeo
    que está tocando na tela ou a imagem de capa da página (`og:image`). A **prévia** segue o
    tipo: com o ponteiro sobre a miniatura, vídeos (arquivo, HLS e DASH) tocam sem som numa
    janela maior — HLS pelo player do próprio Chrome, na variante mais leve; DASH pelos
    primeiros segmentos —, e áudios tocam com som ao clicar na miniatura (clique de novo para
    pausar);
  - o botão que enviou algo acompanha o download no Cachalot (*Na fila…*, *42%*, *✓ Baixado*,
    *Falhou*). Com o ponteiro em cima, enquanto baixa ele vira **Cancelar** (vermelho) e, depois de
    baixado, **Baixar** de novo; quando termina, um botão de **pasta** à esquerda dele abre o Explorer
    com o arquivo selecionado;
  - **Modo transiente** (ícone de waveform à direita do **Baixar** de cada mídia e, no YouTube e em sites de
    música, ao lado do **Só áudio**): o cartão vira a waveform do áudio, com **play/pause** e o título no canto
    superior esquerdo e, no direito, desfazer/refazer e **Baixar todos**. O play toca a seleção (ou a música inteira),
    vira pause enquanto toca, e o pause guarda o ponto para continuar dali (Espaço faz o mesmo). O Cachalot baixa o áudio (sem converter, sem aparecer na lista de
    downloads) e o popup acha os **transientes** — ataques separados por timbre (graves, médios, agudos, cada faixa com
    o seu peso) — e o **andamento** (BPM e compassos) e marca as divisões na própria waveform. Controles pequenos no
    topo, em tempo real. Antes de cortar, a música inteira é marcada em **compassos** (as barras aparecem sempre na
    waveform, numa grade que segue o andamento detectado e as batidas fortes) e os cortes saem dela: a divisão
    **1:1, 1:2, 1:4, 1:8, 1:16, 1:32, 1:64** e, na linha de baixo, **2:1, 4:1, 8:1, 16:1, 32:1** (2 a 32 compassos,
    contados de onde a música começa) deixa cada seção desse tamanho — o corte só gruda no ataque de um transiente
    a até 15 ms da linha; **Auto** corta em todo começo de compasso e, dentro dele, em cada 1/16 onde um transiente é
    tocado (sem pulso estável, em cada transiente); **Sensibilidade** (à esquerda só os transientes fortes, à direita
    também os fracos); e **Loop** (a seção clicada para ouvir toca em volta até clicar de novo; redimensionada, juntada ou
    com fade mudado enquanto toca, o loop passa na hora a usar o novo início e fim). Nenhuma seção termina com o
    começo do próximo ataque: o corte fica 2 ms antes dele e, nas grades, recua até o ataque que começa pouco antes da
    linha (até 60 ms). Cada seção ouvida ou salva tem rampas de 2 ms no começo e 3 ms no fim contra estalo (o corte
    quase nunca cai onde a onda cruza o zero — sem elas cada volta do loop começava com um "pop").
    - Abaixo, a **música inteira** numa waveform de ¼ da altura: a janela laranja é o trecho que aparece em cima —
      arraste-a para andar pela música, arraste uma das bordas para mudar o zoom, clique fora para ir até lá, role
      o mouse para zoom. O que está tocando aparece marcado em verde, com a barra no ponto exato.
    - Ao fundo da waveform fica a grade de compassos, na proporção do zoom: afastado, só os grupos de 16 e 4
      compassos; aproximando, aparecem os compassos (numerados a partir do compasso 1, onde a música começa), os
      tempos e as subdivisões 1/8 … 1/64 — cada nível surge quando suas linhas ficam a ~12 px uma da outra.
    - Rolar o mouse dá zoom; arrastar com o botão direito (ou do meio), Shift+rolar ou a rolagem lateral move a
      vista para os lados.
    - Perto de uma divisória aparece, no meio dela, o botão **juntar** (⇥⇤): une as duas seções (a nova fica com o
      fade-in da primeira e o fade-out da segunda).
    - As divisórias arrastam com o mouse (grudam no transiente mais próximo; com Alt, livres), inclusive o início e o
      fim; duplo clique cria ou remove uma divisória; clique ouve a seção.
    - Arrastar numa área vazia **seleciona** as seções que cruza (Ctrl/Shift somam, Ctrl+clique liga/desliga uma,
      Ctrl+A seleciona todas, clique simples limpa).
    - Com o ponteiro numa seção aparecem **baixar**, **÷2** (divide em duas partes iguais), **×2** (dobra: junta o que
      vier depois até o dobro do tamanho), **voltar ao tamanho original** (desfaz o que mudou nas divisórias dela) e
      **desativar**. Sobre uma seleção, todos valem para todas as seções selecionadas; baixar uma seleção
      salva um arquivo por seção, na pasta de downloads.
    - **Fade-in e fade-out** por seção: com o ponteiro na seção aparecem, nas bordas de cima, um quadrado em cada
      ponta — arraste para dentro para o comprimento do fade — e, quando há fade, um ponto sobre a curva: para cima
      fica mais agressiva (alto até perto da borda, corte rápido), para baixo mais suave (cauda longa). Duplo clique
      no quadrado tira o fade; no ponto, volta a curva linear. A waveform mostra o volume com o fade, a prévia toca
      com ele e o arquivo sai com ele (mais um fade de 3 ms no fim contra estalo).
    - **Baixar todos** salva cada seção ativa num arquivo, todos numa pasta nova `<título> - seções`. Os cortes saem do
      áudio original (taxa e canais originais).
    - Ao baixar (uma seção, uma seleção ou todas), um popup pergunta o formato: **MP3** (320 kbps), **WAV** ou
      **FLAC**, com **Lembrar escolha**. A escolha lembrada fica nas configurações do Cachalot (*Formato das seções*),
      onde dá para trocá-la ou voltar a **Perguntar sempre**.
    - **Início da música**: a bandeira azul na régua (com uma linha tracejada sobre a waveform) marca o compasso 1.
      Arraste-a para onde a música começa de verdade (gruda no transiente mais próximo; com Alt, livre): a grade e
      todas as seções andam junto, contadas a partir dela, e o que vem antes vira uma seção só. Duplo clique na
      bandeira volta ao início detectado; Ctrl+Z desfaz.
    - **Ctrl+Z** desfaz e **Ctrl+Shift+Z** / **Ctrl+Y** refaz as edições (divisórias, junções, fades, seções
      desativadas, resets). As edições ficam guardadas na sessão do navegador e o modo volta aberto se o popup fechar;
  - chave **Enviar cookies deste site** (ligada por padrão, lembrada por site) e o atalho
    **Sincronizar**, que entrega agora os cookies do site ao Cachalot.
- **Menu do botão direito**: *Baixar com o Cachalot* (página, link — inclusive `magnet:` —,
  vídeo, áudio, imagem, quadro) e *Baixar só o áudio com o Cachalot* (página, link, vídeo,
  áudio). O ícone mostra ✓ ou ! por 2 segundos com o resultado.
- **Atalho** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>: envia a página atual (dá para
  mudar em `chrome://extensions/shortcuts`).

## Instalar (sem compactação)

O jeito fácil: ao instalar o módulo, o SwissTechKnife pergunta se você quer a extensão (a pergunta
aparece uma vez; depois, **Cachalot** → **Configurações** → **Extensão do navegador** → **Instalar no
Chrome…** abre o mesmo assistente). Ao clicar em **Instalar**, o Cachalot:

- copia a extensão para uma pasta fixa (`%LOCALAPPDATA%\SwissTechKnife\data\vd-get\extensao-chrome`,
  que não muda nas atualizações do módulo), junto com o código de pareamento deste PC;
- copia o caminho, abre o `chrome://extensions` no perfil que o Chrome usa por padrão e o Explorer com a
  pasta selecionada;
- acompanha os arquivos do perfil do Chrome e marca cada passo sozinho: **Modo do desenvolvedor**
  ligado, extensão carregada, extensão pareada.

O que fica com você, porque o Chrome não deixa outro programa fazer (as duas opções são assinadas no
perfil): ligar o **Modo do desenvolvedor** (canto superior direito de `chrome://extensions`) e clicar em
**Carregar sem compactação** → colar o caminho (Ctrl+V) → **Selecionar pasta**. Arrastar a pasta do
Explorer para a página de extensões também funciona. Se o modo já estiver ligado, o assistente avisa e
pula esse passo. No fim, fixe o ícone do Cachalot: ícone de quebra-cabeça → alfinete.

Sem o assistente: ligue o Modo do desenvolvedor, **Carregar sem compactação** e escolha a pasta
`extension\chrome` deste repositório (a que contém o `manifest.json`); aí o pareamento é manual (abaixo).

**Atualizações:** quando o módulo traz uma versão nova, ele copia por cima da pasta e grava um
`build.json` novo; a extensão percebe na próxima vez que acorda e se recarrega sozinha (a não ser que o
popup ou a página de configurações esteja aberta: aí espera a próxima). Quem instalou com uma versão
anterior do módulo precisa clicar em ↻ (recarregar) uma única vez.

Na primeira instalação a página de configurações abre sozinha.

Para gerar um `.zip` (por exemplo, para enviar a outra pessoa ou à Chrome Web Store):

```powershell
powershell -ExecutionPolicy Bypass -File extension\chrome\scripts\package.ps1
# gera artifacts\cachalot-chrome-<versão>.zip; use -OutDir <pasta> para outro destino
```

## Parear com o Cachalot

Instalada pelo assistente, a extensão se pareia sozinha: ela lê o código do `pairing.json` que o
Cachalot grava na pasta dela (e o regrava quando o código é trocado). À mão:

1. Abra o SwissTechKnife → **Cachalot** → **Configurações** → **Extensão do navegador** e
   copie o código de 8 caracteres.
2. Cole no popup da extensão (campo que aparece quando ela ainda não está pareada) ou nas
   configurações da extensão, e clique em **Parear** / **Salvar código**.

Espaços, hífens e letras minúsculas são aceitos (`abcd-2345` vira `ABCD2345`). Se o código
for trocado no Cachalot, a extensão mostra de novo o campo de pareamento no próximo envio.

A extensão procura o Cachalot em `127.0.0.1`, portas **47821 a 47830**, e lembra a porta
que funcionou. Nas configurações dá para fixar uma porta.

## Privacidade

- Tudo vai **só para `http://127.0.0.1`** (o Cachalot no seu computador). A extensão não
  fala com nenhum servidor na internet, não tem telemetria e não guarda histórico.
- Cookies só são enviados quando a chave **Enviar cookies deste site** está ligada, e só os
  do site da página (por exemplo, em `www.youtube.com` vão os cookies de `youtube.com` e
  subdomínios — nunca os de outros sites). Eles servem para baixar vídeos que exigem login.
- Para as mídias detectadas, são repassados ao Cachalot apenas os cabeçalhos `Referer`,
  `Origin` e `User-Agent` que o navegador usou, para que o download funcione como no site.
- A lista de mídias detectadas fica na memória da sessão do navegador e some quando a aba
  navega para outra página, é fechada ou o navegador é encerrado. Cada aba guarda no máximo
  as **50 mídias mais recentes** (as mais antigas saem), cerca de 55 KB — rolar um feed
  infinito por horas não faz a lista crescer. A gravação é agrupada (no máximo a cada 0,4 s
  por aba), então um feed com muitas mídias por segundo não sobrecarrega a extensão.
- Por que a extensão pede acesso a todos os sites: para enxergar as requisições de vídeo e
  áudio das páginas e ler os cookies do site quando você pede. Nada disso sai do computador.
- As miniaturas são montadas só quando o popup abre: a extensão lê na página os players e a
  imagem de capa (permissão `scripting`) e, se o vídeo está visível, recorta um quadro da aba.
  Nada é guardado depois que o popup fecha.
- Para as prévias carregarem em sites que exigem a página de origem (proteção contra
  hotlink), enquanto o popup está aberto os pedidos de prévia da própria extensão levam o
  `Referer` da página (permissão `declarativeNetRequestWithHostAccess`). A regra vale só para
  esses pedidos e é removida quando o popup fecha.

## Desenvolvimento

```text
extension/chrome/
  manifest.json
  src/background.js      service worker: ícone, badge, menus, atalho, ponte
  src/sniffer.js         detecção de mídia (webRequest + chrome.storage.session)
  src/lib/*.js           lógica pura (plataformas, mídia, domínio, pareamento, ponte, transientes...)
  popup/transient.js     modo transiente (waveform, seções, zoom, divisórias)
  popup/  pages/  ui/    popup, configurações e tema compartilhado
  icons/                 active-<n>.png (colorido) / inactive-<n>.png (cinza)
  scripts/package.ps1    empacota em .zip
  (ícones gerados por stk/scripts/render-icon.ps1 a partir de assets/brand/cachalot-icon.json)
  tests/*.test.mjs       testes unitários (node --test)
  tests/e2e/             teste ponta a ponta (Playwright + ponte simulada)
```

Testes:

```powershell
node --test extension/chrome/tests/
py -3 extension/chrome/tests/e2e/run_e2e.py --work $env:TEMP\cachalot-ext-e2e
```

O teste ponta a ponta sobe uma ponte simulada na porta 47821 e um site de teste na 47900,
abre o Chromium do Playwright com a extensão e confere o que a ponte recebeu. As portas
47821–47830 precisam estar livres (feche o SwissTechKnife antes, ou use `--wait-ports 120`).
Capturas de tela ficam em `<work>\screens`.

Uma parte só, ao lado de um Cachalot aberto (a extensão do teste fala só com a ponte simulada, pela porta fixa):

```powershell
py -3 extension/chrome/tests/e2e/run_e2e.py --only transient --bridge-port 47951 --work $env:TEMP\cachalot-ext-e2e
```

Para depurar, o console do service worker (em `chrome://extensions` → *service worker*)
expõe `cachalot.handleContextClick(info, tab)`, `cachalot.handleCommand('send-page', tab)` e
`cachalot.status()`.
