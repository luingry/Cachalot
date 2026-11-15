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
  - estado da conexão só quando há problema: *Cachalot fechado — abra o SwissTechKnife* ou o
    campo para colar o código de pareamento (conectado, nada aparece);
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
    o seu peso) — e o **andamento** (BPM e compassos) e marca as divisões na própria waveform. O BPM é o que se
    conta, entre 90 e 180 como num software de DJ (um groove meio-tempo a 138 é 138, não 69). Controles pequenos no
    topo, em tempo real: na primeira linha **Loop**, **Show slices**, **Transient detection** e, com ele marcado, o
    ↻ e a **Sensibilidade**; embaixo, todas as
    divisões numa linha só, da maior para a menor — **32:1, 16:1, 8:1, 4:1, 2:1** (32 a 2 compassos por seção),
    **1:1** (o padrão de toda música nova), **1:2 … 1:64** e **Auto**. A música inteira é marcada em **compassos**
    numa grade como a de um CDJ: compasso 1 e o BPM exato (ajustado no grave da música inteira), cada tempo no mesmo
    espaçamento do começo ao fim, sem acumular erro; numa música de andamento variável (banda sem click) a grade
    acompanha, uma reta a cada 4 compassos. A divisão escolhida deixa cada seção desse tamanho.
    - **Transient detection** começa sempre desmarcado: cada seção fica exatamente na grade. Marcado, o corte vai
      para o ataque do próprio tempo (o golpe mais forte a até 15 ms da linha, ou um bumbo/baixo até 30 ms adiantado;
      clap, shaker ou chimbal tocados à frente de propósito não puxam o corte), as marcas dos transientes aparecem
      sob a waveform, a **Sensibilidade** aparece (à esquerda só os transientes fortes, à direita também os fracos) e
      **Auto** fica disponível: todo compasso começa uma seção, dividida ao meio (meio compasso, tempo, colcheia…)
      onde há transientes tocados, então toda seção tem um tamanho utilizável no BPM (quantizada: nunca 3/16 de
      compasso). A menor divisão é a primeira entre 1/16, 1/8 e um tempo que dure pelo menos 150 ms (a 120 BPM,
      1/8). Escolher Auto marca a caixa; desmarcá-la volta sempre à divisão padrão (1:1) e esconde o ↻ e a
      Sensibilidade.
    - **Recalcular** (ícone ↻ ao lado do Transient detection, só com ele marcado): refaz as seções a partir das
      marcas dos transientes na sensibilidade escolhida, quantizadas do mesmo jeito que o Auto, em blocos de até 4
      compassos (um trecho sem marcas vira uma seção de 4, 2 ou 1 compasso); as divisórias
      editadas saem (os cortes do começo/fim e o compasso 1 ficam). Fica aceso enquanto vale; escolher uma divisão
      volta à grade, e Ctrl+Z desfaz tudo, inclusive a divisão.
    - **BPM manual**: clique no BPM (à direita, na linha de cima) e digite o andamento certo (vírgula ou ponto,
      20 a 400); Enter aplica, Esc cancela e vazio volta ao detectado. A grade passa a ser exata nesse BPM a partir
      do compasso 1 e as divisões e os cortes nos transientes são recalculados. Fica em laranja e vale por música.
    - **Loop**: a seção clicada para ouvir toca em volta até clicar de novo; redimensionada, juntada ou com fade mudado
      enquanto toca, o loop passa na hora a usar o novo início e fim.
    - Cada seção ouvida ou salva tem rampas de 2 ms no começo e 3 ms no fim contra estalo (o corte quase nunca cai onde
      a onda cruza o zero — sem elas cada volta do loop começava com um "pop").
    - Abaixo, a **música inteira** numa waveform de ¼ da altura: a janela laranja é o trecho que aparece em cima —
      arraste-a para andar pela música, arraste uma das bordas para mudar o zoom, clique fora para ir até lá, role
      o mouse para zoom. O que está tocando aparece marcado em verde, com a barra no ponto exato.
    - Ao fundo da waveform fica a grade de compassos, na proporção do zoom: afastado, só os grupos de 16 e 4
      compassos; aproximando, aparecem os compassos (numerados a partir do compasso 1), os
      tempos e as subdivisões 1/8 … 1/64 — cada nível surge quando suas linhas ficam a ~12 px uma da outra.
    - Rolar o mouse dá zoom; arrastar com o botão direito (ou do meio), Shift+rolar ou a rolagem lateral move a
      vista para os lados.
    - Perto de uma divisória aparece, no meio dela, o botão **juntar** (⇥⇤): une as duas seções (a nova fica com o
      fade-in da primeira e o fade-out da segunda).
    - As divisórias arrastam com o mouse (grudam no transiente mais próximo; com Alt, livres), inclusive o início e o
      fim; duplo clique cria ou remove uma divisória; clique ouve a seção.
    - Arrastar numa área vazia **seleciona** as seções que cruza (Ctrl/Shift somam, Ctrl+A seleciona todas, clique
      simples limpa). **Ctrl+clique** seleciona uma seção qualquer se nada estiver selecionado e, depois, só a
      vizinha imediata de uma já selecionada (tirar, só pelas pontas); **Shift+clique** liga/desliga qualquer uma.
    - **Alt+clique** em qualquer ponto da waveform (até sobre uma divisória ou alça) toca a música dali até o fim;
      com Alt seguro os botões flutuantes ficam transparentes e deixam o clique passar.
    - **Show slices** (ao lado do Loop, sempre marcado ao abrir): desmarcado, a waveform mostra só a música, qualquer
      clique toca dali e o play segue pela música inteira. Com duas ou mais seções seguidas selecionadas aparece, no meio
      delas, o botão **agrupar**: junta todas numa seção só (fade-in da primeira, fade-out da última); **Ctrl+G** faz o
      mesmo.
    - Com o ponteiro numa seção aparecem **baixar**, **÷2** (divide em duas partes iguais), **×2** (dobra: junta o que
      vier depois até o dobro do tamanho), **voltar ao tamanho original** (desfaz o que mudou nas divisórias dela) e
      **desativar**. Sobre uma seleção, todos valem para todas as seções selecionadas; baixar uma seleção
      salva um arquivo por seção, na pasta de downloads.
    - **Arrastar a seção** (botão logo acima desses, centralizado): move a seção pela música sem mudar o tamanho.
      O espaço que ela deixa vira uma seção nova, desativada; a seção onde ela entra (ativa ou não) cede o tamanho,
      e some se ficar toda por baixo. O começo ou o fim grudam na grade da divisão escolhida e, com o Transient detection
      transient marcado, nas marcas dos transientes (Alt solta); perto de outra divisória, encaixa nela.
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
    - **Compasso 1**: a bandeira azul na régua (com uma linha tracejada sobre a waveform) fica no começo do áudio; a
      grade se alinha à música sozinha. Arraste-a para marcar onde a música começa (gruda no transiente mais próximo;
      com Alt, livre): a grade e todas as seções andam junto, contadas a partir dela, e o que vem antes vira uma seção
      só. Duplo clique na bandeira volta ao começo; Ctrl+Z desfaz.
    - **Ctrl+Z** desfaz e **Ctrl+Shift+Z** / **Ctrl+Y** refaz as edições (divisórias, junções, fades, seções
      desativadas, resets). As edições ficam guardadas na sessão do navegador e o modo volta aberto se o popup fechar;
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
- copia o caminho (que também fica no próprio assistente, com um botão de copiar) e abre `chrome://extensions`
  numa aba nova do Chrome que já está aberto (se o Chrome estiver fechado, ele o abre antes); enquanto você está
  no Chrome, o assistente fica por cima, com os passos e o caminho à vista;
- acompanha os arquivos do perfil do Chrome e marca cada passo sozinho: **Modo do desenvolvedor**
  ligado, extensão carregada, extensão pareada.

O que fica com você, porque o Chrome não deixa outro programa fazer (as duas opções são assinadas no
perfil): ligar o **Modo do desenvolvedor** (canto superior direito de `chrome://extensions`) e clicar em
**Carregar sem compactação** → colar o caminho (Ctrl+V) → **Selecionar pasta**. Se o modo já estiver ligado, o assistente avisa e
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
- Junto de cada envio vão só os cookies do site da página (por exemplo, em `www.youtube.com` vão
  os de `youtube.com` e subdomínios — nunca os de outros sites); eles servem para baixar vídeos
  que exigem login. Se são usados ou não é escolha do Cachalot: em **Configurações › Login e
  cookies** dá para desligar os cookies de todos os sites ou só de alguns, e aí ele os descarta.
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
