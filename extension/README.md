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
  - chave **Enviar cookies deste site** (ligada por padrão, lembrada por site) e o atalho
    **Sincronizar**, que entrega agora os cookies do site ao Cachalot.
- **Menu do botão direito**: *Baixar com o Cachalot* (página, link — inclusive `magnet:` —,
  vídeo, áudio, imagem, quadro) e *Baixar só o áudio com o Cachalot* (página, link, vídeo,
  áudio). O ícone mostra ✓ ou ! por 2 segundos com o resultado.
- **Atalho** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>: envia a página atual (dá para
  mudar em `chrome://extensions/shortcuts`).

## Instalar (sem compactação)

O jeito fácil: no SwissTechKnife, **Cachalot** → **Configurações** → **Extensão do navegador** →
**Instalar no Chrome…**. O Cachalot copia a extensão para uma pasta fixa (que não muda nas
atualizações do módulo), copia o caminho e abre a pasta e o `chrome://extensions`. Depois:

1. Ligue o **Modo do desenvolvedor** (canto superior direito de `chrome://extensions`; no Edge,
   `edge://extensions`).
2. Clique em **Carregar sem compactação** e cole o caminho copiado (ou escolha a pasta
   `extension\chrome` deste repositório, a que contém o `manifest.json`).
3. Fixe o ícone do Cachalot: ícone de quebra-cabeça → alfinete.

Quando o módulo trouxer uma versão nova da extensão, clique de novo em **Instalar no Chrome…** e
depois em ↻ (recarregar) no cartão da extensão em `chrome://extensions`.

Na primeira instalação a página de configurações abre sozinha.

Para gerar um `.zip` (por exemplo, para enviar a outra pessoa ou à Chrome Web Store):

```powershell
powershell -ExecutionPolicy Bypass -File extension\chrome\scripts\package.ps1
# gera artifacts\cachalot-chrome-<versão>.zip; use -OutDir <pasta> para outro destino
```

## Parear com o Cachalot

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
  src/lib/*.js           lógica pura (plataformas, mídia, domínio, pareamento, ponte...)
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

Para depurar, o console do service worker (em `chrome://extensions` → *service worker*)
expõe `cachalot.handleContextClick(info, tab)`, `cachalot.handleCommand('send-page', tab)` e
`cachalot.status()`.
