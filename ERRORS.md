# ERRORS.md — Log de erros e soluções (VDGET)

Registro de problemas não-triviais encontrados durante o desenvolvimento e suas soluções.
Antes de investigar um erro novo, consulte esta lista.

---

## -16. `state.json` do SwissTechKnife "velho" e módulo instalado invisível a partir da sessão do Claude

**Sintoma:** o shell mostrava `vd-get` 1.1.0 no `state.json` (data de outubro) enquanto o SwissTechKnife rodava o
Cachalot 2.0.0; o e2e da extensão achava a porta 47821 ocupada sem `netstat` mostrar o dono.
**Causa:** o app Claude é um pacote MSIX; processos iniciados dele veem `%LOCALAPPDATA%` virtualizado (cópias em
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local`). O que se lê pode ser essa cópia velha e arquivos novos não
chegam ao perfil real (mesmo problema do `ERRORS.md` do SwissTechKnife).
**Solução:** `stk/scripts/install-local.ps1` e `stk/scripts/sync-extension.ps1` se reexecutam via
`Win32_Process.Create` (WMI), fora do pacote, e só então copiam e reiniciam o SwissTechKnife. Para ler o perfil
real, rode a leitura também num processo criado via WMI.

---

## -15. Pasta aberta pela extensão ficava atrás do navegador

**Sintoma:** `explorer.exe /select,"arquivo"` disparado por um processo em segundo plano (o módulo, atendendo
ao `POST /open-folder` da extensão) abre a janela, mas ela não recebe o foco: fica atrás da janela ativa e só
pisca na barra de tarefas (medido: `GetForegroundWindow` igual antes e depois).
**Causa:** o Windows só entrega o primeiro plano ao processo que recebeu a última entrada do usuário; quem
clicou foi o Chrome, não o SwissTechKnife. Pela página do Cachalot isso não acontece (o clique é no host).
**Solução:** `Native/ExplorerWindow.cs`: antes de abrir, guarda as janelas `CabinetWClass` visíveis; depois
espera (fora da thread de UI, até 5 s) pela janela nova — ou, se o Explorer reaproveitou uma, a de título igual
ao da pasta — e a ativa na thread de UI com `AttachThreadInput` à thread em primeiro plano +
`SetForegroundWindow`, e um `mouse_event` nulo como reserva (o mesmo truque do Kiwindow). Só vale para pedidos
da extensão (`OpenFolder(item, bringForward: true)`).
**Limite:** jogos em tela cheia seguram o foco mesmo assim (testado com um jogo aberto: a pasta abre atrás).

---

## -14. SoundCloud real: página da música sem capa e faixas da página não listadas

**Evidência (página real aberta no navegador embutido):** os tiles da home apontam para playlists
(`/usuário/sets/nome`, 3 segmentos) e o filtro só aceitava `/usuário/faixa`; a capa fica num `<span>` interno
com `background-image` (o `.sc-artwork` externo não tem estilo); o botão de play é `<a href="">`, que resolvido
vira a própria página e parecia "outra faixa"; e o SoundCloud é SPA: depois de navegar por dentro o
`og:image` continua o da primeira página carregada (capa errada ou nenhuma).
**Solução:** extrator do SoundCloud sem depender de classes — link de faixa ou playlist + o ancestral mais
próximo com `background-image` que não contenha outra faixa, preferindo o que tem o link do usuário
(`username`); título pelo `aria-label` da capa; links vazios ignorados; capa da página pela arte do herói
(`.listenArtworkWrapper`) e nunca pelo `og:image` no SoundCloud.
**Nota (PowerShell 5):** `Get-Content`/`Set-Content` sem `-Encoding` estragam UTF-8 (acentos viram `Ã©`) e
`-Encoding utf8` grava BOM. Para JSON/manifest use `[IO.File]::ReadAllText/WriteAllText` com
`UTF8Encoding($false)`.

---

## -13. Extensão: em feed rápido (muitas mídias por segundo) o sniffer ficava para trás

**Sintoma:** página de teste com 200 mídias em lotes de 10: 20 s depois do fim a lista ainda tinha só as
primeiras (0–49); numa sonda com 80, 4 s depois só 10 tinham entrado. O `webRequest` recebia todos os
eventos (contados com um listener extra no worker).
**Causa:** cada mídia nova fazia, em série por aba, `chrome.tabs.get` + leitura e escrita da lista inteira no
`storage.session` + `refreshTab` (badge e `setIcon` com 4 PNGs). A fila crescia mais rápido do que esvaziava.
**Solução:** a lista de cada aba fica na memória do worker; o storage é gravado no máximo a cada 400 ms por
aba e só então badge/ícone são atualizados; `chrome.tabs.get` só na primeira mídia da página. Resultado: 200
mídias → lista estável 0,2 s após o fim, 50 itens (os mais novos), 54 KB. Teste E2E "200 media on one page".

---

## -12. E2E da extensão: um segundo `<video>` tocando na página de teste sumiu com o `song.mp3`

**Sintoma:** ao pôr um `<video>` alimentado por `canvas.captureStream()` na página de teste (para simular um
player MSE nas miniaturas), o sniffer deixou de ver o `<audio preload="auto">`: 3 linhas em vez de 4.
**Causa (dedução):** o Chromium adia o carregamento de mídia com vários players ativos; o áudio não pediu o
arquivo dentro da janela do teste. **Solução:** o player falso é injetado (`page.evaluate`) só na fase da
captura, depois das verificações do sniffer. **Notas:** `captureVisibleTab` só mostra a aba visível da
janela — no teste o popup roda numa aba, então a captura exige `page.bring_to_front()`; em aba de fundo o
`requestAnimationFrame` não roda (verifique `data-preview`, não a classe animada).
**DASH de teste com ffmpeg no Windows:** o muxer `dash` grava `init-*.m4s`/`chunk-*.m4s` na pasta de
trabalho do processo, não ao lado do `.mpd` (o manifesto ficou sem segmentos → 404 na prévia, e os
segmentos foram parar na raiz do repositório). Rode o ffmpeg com `cwd=` na pasta do manifesto.

---

## -11. YouTube: "O formato pedido não existe" (yt-dlp: "Requested format is not available")

**Sintoma:** vídeo comum do YouTube falhava com `format_unavailable` ("Tente outra qualidade"), sobretudo
vindo da extensão (que manda os cookies do YouTube). Sem cookies: "This video is not available".

**Evidência:** `yt-dlp -v` → `JS runtimes: node-20.19.5 (unsupported)`, `JS Challenge Providers: … (unavailable)`,
`n challenge solving failed`, `Only images are available for download`. O yt-dlp 2026.x exige runtime
JavaScript para o YouTube e só aceita Deno ≥ 2.3, Bun ≥ 1.2.11 ou **Node ≥ 22** (`yt_dlp/utils/_jsruntime.py`).
O `runtimes_js()` antigo passava o Node 20, que o yt-dlp ignora. Com o Deno do PyPI: 1080p com e sem cookies.

**Solução:** `dependencias.runtimes_js()` só devolve runtimes na versão mínima (inclui o `deno.exe` do pip na
pasta Scripts) e `garantir_runtime_js()` instala o pacote `deno` (pip, ~42 MB) no primeiro download do
YouTube sem runtime aceito (fase "Preparando o YouTube (só na primeira vez)"). Se mesmo assim faltar, o erro
vira `js_runtime` com mensagem própria em vez de "Tente outra qualidade".

---

## -10. "Este módulo não abriu: Referência de objeto não definida" ao atualizar do VDGET 1.x

**Sintoma:** com o `state.json` do 1.1.0, a página falhava ao abrir. `host.log`:
`NullReferenceException em DownloadService.PreferencesChanged() ← DownloadService..ctor ← CachalotModule.CreateView`.

**Causa:** o `state.json` do 1.x tem `"Quality"` (melhor/pior/audio). `MigrateLegacyQuality` roda no construtor
e chama `PreferencesChanged()`, que usa `_prefsTimer` — criado só no fim do construtor. Os testes usavam pasta
de dados limpa, sem estado legado.

**Solução:** timers criados antes de carregar o estado; a migração também agenda salvar o `state.json`.
Teste `upgrade: 1.x state.json opens the page` (estado real do 1.1.0 → cria a página, migra o modo).
**Evitar:** todo código que o construtor chama precisa encontrar os campos já prontos; testar upgrade com
dados da versão anterior.

---

## -9. Módulo instalado localmente aparecia como "VDGET" (nome e ícone antigos) no SwissTechKnife

**Sintoma:** o host carregava o Cachalot 2.0.0 ("Activated vd-get 2.0.0" no `host.log`), mas a lista mostrava
"VDGET" com o ícone antigo e o usuário não achava o módulo.

**Causa:** `ModuleItem.Info` usa a entrada do catálogo publicado antes do snapshot gravado no `state.json`
(`_catalogEntry ?? _installed.Entry`). Editar o `state.json` não basta enquanto o catálogo remoto disser VDGET.

**Solução (teste local, antes de lançar):** cópia de `SwissTechKnife/catalog` (json + `icons/`) em
`%LOCALAPPDATA%\SwissTechKnife\catalog-local` e `"catalog"` apontando para ela no `settings.json` do host
(backup em `settings.json.pre-catalog-local`); reiniciar o host. **Ao lançar:** remover a chave `catalog`
(volta ao catálogo publicado) e apagar `catalog-local`, senão o host deixa de ver novas versões.

---

## -8. Cachalot 2.0: armadilhas da fila, dos motores e do módulo

**Sintomas encontrados (e a causa de cada um)**

- *Download "concluído" sem arquivo depois de um contorno de 429.* `yt_dlp.parse_options` devolve o padrão
  da CLI `ignoreerrors="only_download"`: uma falha de download vira `None`, sem exceção. Com o cliente `mweb`
  (hoje exige PO token) veio "No video formats found!" engolido. `_montar_opts` força `ignoreerrors=False`.
- *Legendas de tradução automática (`en-de`, `en-en`) e 429 do YouTube nelas.* O yt-dlp compara
  `--sub-langs` com `re.I` + `fullmatch`, então não há regex que separe `en-GB` de `en-de`. Como o OmniGet,
  o servidor escolhe as faixas exatas com os metadados (`escolher_legendas`): manual do idioma ou variante
  regional; senão a automática do próprio idioma. 429 só nas legendas → repete sem legendas.
- *Fase "Convertendo áudio" nunca aparecia.* O `postprocessor_hooks` do yt-dlp manda
  `PostProcessor.pp_key()`, que tira o prefixo `FFmpeg` e o sufixo `PP` (`FFmpegExtractAudioPP` →
  `ExtractAudio`, `FFmpegMetadataPP` → `Metadata`). O mapa `_FASES_PP` usava os nomes de classe.
- *Cancelar um download HTTP pausado/lento deixava `.part` e `.part.json`.* O `read()` bloqueado só voltava
  no timeout (30 s) e, enquanto isso, o pedido de cancelamento virava "Falha de rede". Agora `parar()`/
  `cancelar()` fecham as respostas abertas (`_Aberta`), qualquer exceção com sinal pendente vira pausa/
  cancelamento, e `executar_download` respeita `ctl.sinal` antes de classificar o erro.
- *Cancelar um torrent não apagava nada.* No libtorrent 2.x a flag é `lt.options_t.delete_files`
  (`lt.session.delete_files` era do 1.x); o `AttributeError` interrompia o `remove_torrent`. Ao apagar
  parciais, só arquivos de topo que não existiam antes do torrent começar entram na lista, e `rmdir` nunca
  sobe até a pasta de destino.
- *Retomar um magnet esperava os metadados de novo.* Os metadados são guardados em
  `VDGET_DATA/torrents/<infohash>.torrent` na primeira vez e reaproveitados.
- *"Retomar" clicado antes de a pausa terminar se perdia.* `retomar` com `ctl.sinal == "pausar"` marca
  `retomar_apos_pausa`; quando a pausa conclui, o item volta direto para a fila.
- *Teste de pausa/retomada instável.* Servidores públicos de teste (proof.ovh.net, thinkbroadband)
  respondem 429/403 ou param de aceitar conexões com 8 faixas paralelas. O teste de integração usa
  `RangeServer` local (Range + taxa limitada), determinístico.
- *`MSB4025` ao carregar o `.csproj`.* Comentário XML não pode conter `--` (era um exemplo de linha de
  comando com `--snapshot`).
- *Snapshot da aba de configurações cortado.* Janela com `SizeToContent` fica limitada à altura da tela;
  o snapshot mede e organiza o card fora de janela (`Measure`/`Arrange` com altura infinita).

- *Áudio "original" saía `.mkv` (contêiner de vídeo).* O Opus do YouTube vem em `.webm`, que não aceita capa
  embutida; o `EmbedThumbnail` falhava e a reserva "formato simples" (`b/bv*+ba`) fazia um merge, que o
  yt-dlp põe em `.mkv` quando há capa. Agora áudio original usa `--remux-video webm>opus` (só troca o
  contêiner) e, em modo áudio, as reservas nunca escolhem formato de vídeo; falha só na capa → repete sem capa.

**Extensão do Chrome (testes)**

- Playwright Python 1.61 procura o Chromium 1228, que não está instalado: os scripts usam o
  `ms-playwright\chromium-*\chrome-win64\chrome.exe` mais novo (aceita extensão em headless). `CACHALOT_CHROMIUM` sobrescreve.
- `wait_for_function` com expressão em texto falha em páginas da extensão ("unsafe-eval" pela CSP): use arrow functions.
- Badge ✓/! preso: o service worker MV3 pode parar dentro dos 2 s do aviso; as abas com aviso ficam em
  `storage.session` e são repintadas quando o worker volta.
- Sem a permissão "tabs", `tab.url` vem vazio para páginas da extensão/`chrome://`; o popup trata aba sem URL.
- Parar o service worker em teste: CDP `ServiceWorker.stopAllWorkers` não para; use o botão Stop de
  `chrome://serviceworker-internals`.
- A ponte do módulo pode estar ocupando 47821 (SwissTechKnife aberto ou teste de integração): o e2e tem
  `--wait-ports`, e a extensão procura 47821–47830.

**Como evitar no futuro**

- Ao mapear hooks do yt-dlp, use `pp_key()`, não o nome da classe.
- Todo motor novo precisa: registrar seus parciais em `ctl.tmp`, ter `parar()`/`cancelar()` que
  interrompem I/O bloqueante, e devolver `Cancelado` (nunca um erro) quando há sinal.
- Teste de rede com comportamento de servidor (Range, lentidão) → servidor local, não CDN pública.

---

## -3. Módulo do SwissTechKnife: armadilhas ao hospedar o `servidor.py` (stk/)

**Sintomas evitados / encontrados**

- `python` no PATH do Git Bash/CMD pode ser o *alias* da Microsoft Store
  (`...\WindowsApps\python.exe`), que abre a Store em vez de rodar o Python.
- Iniciar via `py.exe` deixa o `python.exe` real como neto: matar o `py.exe` não para os downloads.
- O `matar_instancias_terminal_vdget_windows()` do encerramento matava, por título de janela,
  o `iniciar.bat` de um VDGET avulso aberto ao mesmo tempo.
- Cache do sniffer, `__pycache__` e diretório de trabalho na pasta de instalação do módulo
  bloqueiam/sujam a pasta que o SwissTechKnife substitui ao atualizar.
- Build do módulo: `MC1000 Could not find assembly 'System.Web'` ao referenciar só
  `System.Web.Extensions` (JavaScriptSerializer) num projeto WPF.

**Solução aplicada**

- `PythonLocator` pergunta ao `py -3` o `sys.executable` e roda esse `python.exe` direto;
  no fallback pelo PATH ignora `\WindowsApps\`.
- O processo entra num *Job Object* com kill-on-close: backend, pip, ffmpeg e Chrome headless
  morrem junto com o host, mesmo em crash.
- `VDGET_HOSTED=1` pula o `taskkill`; porta livre via `VDGET_PORT`; `VDGET_DATA` para o cache
  do sniffer; `PYTHONDONTWRITEBYTECODE=1`; `WorkingDirectory` = pasta de dados do módulo.
- Referenciar também `System.Web` no `.csproj` (o compilador de XAML precisa dele).
- `state.json` ilegível é copiado para `state.damaged.json` antes de recomeçar, para o próximo
  save não apagar o histórico.

---

## -2. Remover/abrir item não fazia nada com o servidor desligado (falha silenciosa)

**Sintoma**

Com o servidor parado — o que acontece sozinho, porque o watchdog de inatividade encerra
o VDGET após 3 minutos ociosos — clicar em "Remover", "Limpar todos", "Abrir pasta" ou
"Abrir arquivo" não produzia efeito **nem mensagem**. A interface continuava a mostrar os
downloads (o histórico de concluídos vive no `localStorage`), mas os botões pareciam mortos.

**Causa raiz**

As quatro ações passavam por `enviar()`, que é um no-op silencioso quando o WebSocket não
está aberto:

```js
function enviar(dados) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(...); }
}
```

Remover um card dependia do **eco** do servidor (`{"tipo":"remover"}`) para chamar
`removerCard()`. Sem servidor, não havia eco e nada acontecia. Isso era desnecessário:
remover é uma operação puramente de interface, já que o histórico é local.

Havia um segundo problema, específico de abrir arquivo/pasta: o servidor resolvia o caminho
por `downloads[dl_id]`, e esse dicionário **volta vazio a cada boot**. Mesmo religando o
servidor, abrir um item antigo falharia, porque só o cliente ainda sabe o caminho.

**Solução aplicada**

- `removerItem()` e `limparConcluidos()` agem **localmente primeiro** (`removerCard()`, que
  já persiste no `localStorage`) e só depois avisam o servidor. `removerCard()` é
  idempotente, então o eco do servidor, quando existe, não duplica efeito.
- `limparConcluidos()` replica o critério do servidor — só `status === "concluido"`; itens
  com erro continuam na lista.
- Abrir arquivo/pasta não tem como funcionar sem um processo local (o navegador não acede
  ao sistema de ficheiros). Passou a enfileirar a ação, disparar `vdget://iniciar` para
  religar o servidor e executá-la ao reconectar, com aviso visível e prazo de validade.
- O cliente passou a enviar `arquivo`/`destino` junto com a ação, e o servidor usa esses
  campos como fallback quando não conhece o `dl_id`.

**Como evitar no futuro**

Qualquer ação nova que seja apenas de interface (mexe só no que está no `localStorage`) deve
agir localmente e tratar o servidor como sincronização opcional. Só o que exige o sistema
operativo (abrir ficheiro, revelar pasta, baixar) precisa mesmo do backend — e nesse caso o
cliente deve mandar os dados necessários, porque o estado do servidor não sobrevive ao boot.

**Nota de segurança**

Aceitar um caminho vindo do cliente permitiria pedir ao servidor que abrisse qualquer coisa
com o app padrão (ex.: um `.exe`). Por isso `caminho_midia_do_cliente()` valida que o ficheiro
existe **e** que a extensão está na lista de mídia que o VDGET produz. Revelar a pasta não
passa por essa trava, porque só seleciona o item no explorador e não executa nada.

---

## -1. Downloads resgatados pelo sniffer não tinham miniatura (página sem NENHUMA fonte no DOM)

**Sintoma**

Downloads que caem no fallback do sniffer (players MSE/`blob:`) concluíam normalmente,
mas apareciam sem miniatura na lista — ao contrário de fontes que o yt-dlp resolve
sozinho (YouTube, SoundCloud etc.), que sempre mostram thumb.

**Causa raiz**

`_titulo_e_thumb()` em `sniffer.py` lia **só** `meta[property="og:image"]`. Sondagem real
da página de teste (depois de dar play e esperar o player inicializar) mostrou que
**todas** as fontes de miniatura no DOM vinham vazias: `og:image`, `og:image:secure_url`,
`twitter:image`, `itemprop="thumbnailUrl"`, `link[rel="image_src"]`, JSON-LD
(`thumbnailUrl`/`thumbnail`) e até o atributo `poster` do `<video>` — o player é 100%
`blob:`/MSE e nunca expõe uma imagem de capa em lugar nenhum do HTML. Ou seja: não é (só)
falta de cobertura de meta tags — nem toda extração de DOM ampliada resolveria esse caso
específico, porque a página genuinamente não tem imagem nenhuma para extrair.

**Solução aplicada**

Duas camadas, nesta ordem:

1. **Extração de DOM ampliada** (`_JS_EXTRAIR_THUMB` em `sniffer.py`): cobre as seis
   fontes citadas acima, resolvendo relativo→absoluto com
   `new URL(u, document.baseURI).href` dentro do próprio navegador (mais correto que
   `urljoin` em Python puro — já respeita `<base href>`). Ajuda outros sites mesmo não
   ajudando este.
2. **Fallback gerando o frame com ffmpeg** (`gerar_thumbnail_ffmpeg()` em `sniffer.py`,
   chamada por `tentar_resgate_por_sniffer()` em `servidor.py` assim que o manifesto é
   encontrado, antes de iniciar o download): quando (1) não devolve nada, extrai um frame
   direto do manifesto com `ffmpeg -ss 3 -i <variante_de_menor_banda> -frames:v 1 -vf
   scale=320:-1 -q:v 5 -f image2 -vcodec mjpeg pipe:1`, passando os headers capturados
   (Referer/User-Agent/Cookie) via `-headers` (terminador `\r\n` obrigatório — sem isso o
   CDN rejeita a requisição). A variante de menor banda é resolvida por conta própria
   (parseando `BANDWIDTH=` do master HLS) em vez de confiar na seleção automática do
   ffmpeg, que é indocumentada/variável entre versões — assim nunca baixa a variante
   1080p só para gerar uma miniatura de 320px. Devolve **`data:image/jpeg;base64,...`**,
   nunca um caminho de arquivo: a interface roda tanto em `file://` quanto servida por
   `controlador.py` em `http://127.0.0.1:8764`, e um `<img src="file:///...">` é bloqueado
   nesse segundo contexto. Qualquer falha (ffmpeg ausente, timeout, CDN recusando,
   manifesto inválido) devolve `""` e o download segue normalmente — miniatura é
   cosmética, nunca pode derrubar o fluxo principal.

**Como evitar no futuro**

Miniaturas de fontes que o yt-dlp já resolve sozinho continuam vindo de
`melhor_thumbnail(info)` — o ffmpeg só é chamado quando a extração de DOM do sniffer não
achou nada, para não gerar frame à toa em sites que já têm miniatura própria.

---

## -0.5. `onerror` da miniatura deixava um quadrado vazio em vez do ícone de status

**Sintoma**

Quando a URL da miniatura falhava ao carregar (comum em CDNs com proteção de hotlink,
que devolvem 403 sem um `Referer` "correto"), a `<img>` era escondida
(`this.style.display = 'none'`) e sobrava um quadrado vazio no card — nem imagem, nem o
ícone de placeholder que aparece quando não há `dl.thumb` nenhum.

**Causa raiz**

O handler `onerror` só escondia o elemento (`display: none`), sem nunca restaurar o
ícone de fallback (`ICON_THUMB[status] || ICON_THUMB_FALLBACK`) nem limpar
`dataset.thumbSrc` — então uma nova tentativa com a mesma URL (ex.: reabrir a página)
também ficava travada, já que o dataset ainda registrava aquela URL como "já tentada".

**Solução aplicada**

Em ambos os caminhos de renderização (`atualizarCard()`, via `img.onerror` em JS, e
`buildCardHTML()`, via `onerror="onThumbError(this, status)"` inline — a nova função
global `onThumbError()`), o `onerror` agora: apaga `thumb.dataset.thumbSrc` e substitui o
conteúdo de `.dl-thumb` pelo ícone de status (`ICON_THUMB[status] || ICON_THUMB_FALLBACK`).
Também foi adicionado `referrerpolicy="no-referrer"` na `<img>` — várias proteções de
hotlink liberam a imagem quando não há `Referer` nenhum, então isso sozinho já recupera
miniaturas de alguns sites sem precisar do fallback do ícone.

**Como evitar no futuro**

Qualquer novo lugar que renderize `dl.thumb` como `<img>` precisa do mesmo par
`referrerpolicy="no-referrer"` + `onerror` que restaura o ícone (nunca só esconder o
elemento).

---

## 0. `KeyError` em `executar_download` se o usuário remove o item durante o resgate via sniffer

**Sintoma**

Se o usuário clica em remover um download enquanto ele está em `"analisando"` (sniffer
headless rodando) ou já de volta em `"baixando"` (após o manifesto ser encontrado), a task
`executar_download` pode levantar `KeyError: '<dl_id>'` ao tentar atualizar ou fazer
broadcast de `downloads[dl_id]` depois que o item já foi apagado do dicionário.

**Causa raiz**

O handler da ação `remover` faz `del downloads[dl_id]` **incondicionalmente**, mesmo para
downloads ativos — não existe trava para itens em transferência. Isso já era uma janela de
risco pré-existente (algumas linhas no fim de `executar_download` acessavam
`downloads[dl_id]` sem checar se a chave ainda existia), mas era uma janela de poucos
segundos. O resgate via sniffer **amplia essa janela para até dezenas de segundos**
(até `timeout_s` de sniff, mais o download do manifesto) com o status preso em
`"analisando"` — um estado que parece "travado" para quem está usando a interface e torna
a remoção no meio do processo muito mais provável de acontecer na prática.

Havia inclusive uma inconsistência interna: `tentar_resgate_por_sniffer()` já verificava
`if dl_id not in downloads` antes de tocar no dicionário, mas o código que a chama
(`executar_download`, no bloco `except` final e na linha do broadcast de fechamento) não
tinha a mesma guarda.

**Solução aplicada**

Seguido o mesmo padrão já usado após `_somente_meta()` no próprio arquivo
(`if dl_id not in downloads: return`), adicionado antes de cada acesso a
`downloads[dl_id]` que fecha a função `executar_download`:

- antes de gravar `"concluido"` (caminho de sucesso);
- no início do bloco `except` (antes de decidir se tenta o sniffer);
- antes de gravar `"erro"`, depois do `await tentar_resgate_por_sniffer(...)` — porque o
  item pode ter sido removido justamente **durante** esse `await`;
- antes do `broadcast` final e do `marcar_atividade_download_servidor()`.

**Como evitar no futuro**

Qualquer novo ponto em `executar_download` (ou em código chamado por ele) que leia ou
grave `downloads[dl_id]` **depois de um `await`** precisa reconfirmar
`dl_id in downloads` logo antes — o dicionário pode ter mudado enquanto a coroutine estava
suspensa. `hook()` (progresso do yt-dlp) roda em thread separada e também acessa
`downloads[dl_id]` sem essa guarda; hoje isso é inofensivo porque qualquer `KeyError`
lá dentro sobe como a exceção do próprio download e cai no `except` (já protegido), mas se
`hook()` for reaproveitado em um contexto que não tenha esse `except` ao redor, precisa
da mesma guarda.

---

## 1. `UnicodeEncodeError: 'charmap' codec can't encode characters` ao rodar `servidor.py` com stdout redirecionado

**Sintoma**

```
File "servidor.py", line ..., in main
    print(f"""...""")
File "...\encodings\cp1252.py", line 19, in encode
    return codecs.charmap_encode(input,self.errors,encoding_table)[0]
UnicodeEncodeError: 'charmap' codec can't encode characters in position 2-49: character maps to <undefined>
```

O processo morre antes de abrir o WebSocket — nem chega a imprimir o banner completo.

**Causa raiz**

Quando o `stdout` do `servidor.py` é um console real do Windows, o Python usa a codepage
do console (normalmente já preparada para UTF-8/OEM com os caracteres certos). Mas quando
o `stdout` **não** é um console — redirecionado para arquivo (`> log.txt`), para um pipe, ou
para `subprocess.DEVNULL`/`PIPE` (é exatamente o que `controlador.py` faz ao subir o
`servidor.py` em segundo plano) — o Python herda a codepage ANSI padrão do Windows
(ex.: `cp1252`), que não tem os caracteres de desenho de caixa (`╔`, `║`, `╚`...) usados no
banner de abertura. Qualquer `print()` com esses caracteres ou acentos derruba o processo
com `UnicodeEncodeError` antes de servir qualquer coisa.

Isso é **preexistente** (não foi introduzido pela feature de sniffer), mas foi descoberto
ao testar o servidor real redirecionando a saída para arquivo de log — e é o mesmo caminho
de execução que `controlador.py` usa em produção (`stdout=subprocess.DEVNULL`), então o
risco também existe fora do cenário de teste.

**Solução aplicada**

Logo no topo de `servidor.py`, antes de qualquer `print()`:

```python
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
```

Isso força UTF-8 (com substituição de caracteres não mapeáveis em vez de exceção) para
qualquer destino de stdout/stderr, independentemente de ser console, arquivo ou pipe.

**Como evitar no futuro**

Ao rodar `servidor.py` manualmente com saída redirecionada para depuração no Windows,
não é mais necessário setar `PYTHONIOENCODING=utf-8` manualmente — mas se o sintoma
voltar a aparecer em algum ambiente, isso confirma que o `reconfigure()` falhou
silenciosamente (por exemplo, Python < 3.7, que não tem `TextIOWrapper.reconfigure`) —
nesse caso, definir a variável de ambiente `PYTHONIOENCODING=utf-8` é o workaround direto.

---

## 2. Orçamento de tempo do sniffer podia estourar o `timeout_s` externo e gerar ruído `Future exception was never retrieved`

**Sintoma**

Ao testar `sniffer.descobrir_manifesto()` isoladamente com um `timeout_s` mais curto que a
soma dos tempos internos de espera (goto até 30s + espera de evento 8s + 10s + fallback 3s
= até 51s no pior caso), o `asyncio.wait_for` externo cancelava a corrotina no meio de uma
chamada do Playwright, e o processo imprimia no stderr:

```
Future exception was never retrieved
future: <Future finished exception=TargetClosedError('Target page, context or browser has been closed')>
```

Não quebrava o retorno (`None` continuava vindo certo), mas é ruído indesejado e sintoma de
que o cleanup (`context.close()`) podia ser interrompido no meio pelo cancelamento externo.

**Causa raiz**

Os tempos de espera internos (`goto`, as duas esperas pelo evento de manifesto e o sleep de
fallback) eram fixos e, somados, podiam ultrapassar o próprio `timeout_s` passado para
`descobrir_manifesto()` — inclusive com o valor padrão de produção (45s), já que
30+8+10+3 = 51s no pior caso. Isso fazia o `asyncio.wait_for` externo (que existe
justamente para isso) cortar a operação no meio de um `await` do Playwright, abandonando
uma promise interna do Playwright que só recebia sua exceção depois — e como ninguém mais
aguardava por ela, o asyncio reportava a exceção como "nunca recuperada".

**Solução aplicada**

`_descobrir_manifesto_impl` agora recebe o `timeout_s` e calcula um orçamento de tempo
restante (`_restante(reserva)`) antes de cada espera (goto, as duas esperas por evento, e o
sleep de fallback), sempre deixando uma folga para o `context.close()` acontecer **dentro**
do prazo, em vez de depender do cancelamento externo. Também foram removidos os listeners
de `request`/`response` e drenadas (com cancelamento) as tasks de resposta ainda em voo
antes de fechar o contexto, no `finally`.

**Como evitar no futuro**

Qualquer nova etapa de espera adicionada ao sniffer deve usar `_restante(reserva)` em vez
de um valor fixo, para que o orçamento total nunca dependa do `asyncio.wait_for` externo
para se autolimitar.

---

## 3. Primeira execução (Playwright não instalado) podia estourar o `timeout_s` do sniff sem motivo aparente

**Sintoma**

Numa máquina sem Playwright, o primeiro download que caísse no fallback do sniffer falhava
(`None`) sem nenhum erro concreto no log além do timeout — mas rodar de novo funcionava.

**Causa raiz**

`garantir_dependencias()` (que faz `pip install playwright` e, se nenhum navegador do
sistema funcionar, `playwright install chromium`, ~150 MB) era chamada **dentro** de
`_descobrir_manifesto_impl`, que por sua vez estava inteiramente envolvida pelo
`asyncio.wait_for(..., timeout=timeout_s)` de `descobrir_manifesto()` (45s por padrão). A
instalação do pacote (alguns segundos) já competia com esse orçamento; no pior caso, com o
download do Chromium embutido, estourava com folga. Como o `pip install` roda em thread via
executor e não morre com o cancelamento do `asyncio.wait_for`, a tentativa seguinte
encontrava tudo já instalado/cacheado e funcionava — mascarando a causa e parecendo um
problema aleatório de "primeira vez".

**Solução aplicada**

`garantir_dependencias()` foi movida para fora do `_descobrir_manifesto_impl` e passou a
ser chamada em `descobrir_manifesto()` **antes** do `asyncio.wait_for(timeout=timeout_s)` de
navegação, com um teto próprio e bem mais generoso (`TIMEOUT_PREPARO_DEPENDENCIAS_S = 300s`).
Assim, o custo de instalação (só ocorre na primeira execução da máquina, depois fica em
cache) nunca compete com o tempo de navegação/descoberta do manifesto.

**Como evitar no futuro**

Qualquer preparo de ambiente que envolva instalação de pacotes ou download de binários deve
ficar fora do orçamento de tempo da operação "de verdade" que ele habilita — dar-lhe um
`asyncio.wait_for` próprio, sequenciado antes, em vez de aninhado dentro do mesmo.

## 4. YouTube: "Sign in to confirm you're not a bot"

**Sintoma**

`DownloadError: ERROR: [youtube] <id>: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies…`
em qualquer vídeo do YouTube, inclusive com o yt-dlp mais recente (2026.08.19).

**Causa raiz**

O IP ficou marcado pelo YouTube (as requisições vêm junto de `HTTP Error 429`). Os clientes
web (`web_safari`, `mweb`, `web_embedded`) só entregam storyboard sem PO token; `tv*` e
`android_vr` também pedem login. Ler cookies do navegador não funciona nesta máquina: Edge
falha com "Failed to decrypt with DPAPI" (app-bound encryption do Chromium) e o Chrome trava
o banco ("Could not copy Chrome cookie database"); não há Firefox.

**Solução aplicada**

`executar_download()` detecta o erro (`erro_pede_login_youtube`) e tenta, em ordem
(`estrategias_anti_bot_youtube`): `cookies.txt` na pasta de dados (`VDGET_DATA`) ou ao lado
do `servidor.py` → cookies de cada navegador instalado → cliente `android` do YouTube (passa
sem PO token, mas só oferece o formato 18, 360p). Se tudo falhar, a mensagem de erro explica
onde salvar o `cookies.txt`. Além disso, o servidor atualiza o yt-dlp em segundo plano no
máximo 1x/dia (`atualizar_yt_dlp_em_segundo_plano`, desligável com `VDGET_AUTO_UPDATE=0`).

**Como evitar no futuro**

Para qualidade máxima com IP marcado, exporte cookies de uma sessão logada (formato
Netscape) para `cookies.txt`. Se o cliente `android` também parar, a saída é um provedor de
PO token (plugin `bgutil-ytdlp-pot-provider`).
