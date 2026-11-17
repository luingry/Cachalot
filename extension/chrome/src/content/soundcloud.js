// SoundCloud: a "download" button in the bottom player bar, left of the like button. A click sends the track
// that is playing to Cachalot (audio). The button shows how that track stands in Cachalot: a green check when it
// is already downloaded, an orange progress ring while it downloads (spinning while queued). SoundCloud re-renders
// the bar, so an observer
// puts the button back whenever it goes missing and notices when the track changes.
(() => {
  if (window.__cachalotSoundcloud) return;
  window.__cachalotSoundcloud = true;

  const BUTTON_CLASS = "cachalot-sc-download";
  const IDLE_TITLE = "Baixar com o Cachalot";
  const RELOAD_TITLE = "Cachalot atualizado — recarregue a página";
  const ICONS = {
    idle: '<path d="M7.25 1.5h1.5v7.19l2.47-2.47 1.06 1.06L8 11.56 3.72 7.28l1.06-1.06 2.47 2.47V1.5z" fill="currentColor"/><path d="M2 12.5h12V14H2z" fill="currentColor"/>',
    done: '<path d="M6.25 11.19 13.22 4.22l1.06 1.06-8.03 8.03L1.72 8.78l1.06-1.06z" fill="currentColor"/>',
    error: '<path d="M7.25 2h1.5v7.5h-1.5zM7.25 11.5h1.5V13h-1.5z" fill="currentColor"/>',
  };
  ICONS.busy = ICONS.idle;
  // progress ring: a faint track and an arc that fills clockwise from the top (r 6, so 2πr ≈ 37.7)
  const RING = 2 * Math.PI * 6;
  ICONS.run =
    '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" opacity=".25"/>' +
    `<circle class="arc" cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="${RING}" stroke-dashoffset="${RING}" transform="rotate(-90 8 8)"/>`;
  const ERROR_RESET_MS = 5000;
  const POLL_MS = 1000;
  // same list and order as src/lib/payload.js AUDIO_FORMATS (content scripts cannot import modules)
  const FORMATS = [
    ["mp3", "MP3", "320 kbps"],
    ["flac", "FLAC", "Sem perdas, comprimido"],
    ["wav", "WAV", "Sem perdas, sem compressão"],
    ["original", "Original", "Como o SoundCloud entrega"],
  ];

  let button = null;
  let track = null; // { url, title } playing now, as the bar shows it
  let pollTimer = 0;
  let resetTimer = 0;

  /** progress: 0–100 for the ring of the "run" state; null spins it (queued, sending). */
  function setState(state, title = IDLE_TITLE, progress = null) {
    if (!button) return;
    const svg = button.querySelector("svg");
    // the ring stays the same element between polls, so its arc glides to the new value instead of jumping
    if (state !== "run" || button.dataset.state !== "run") svg.innerHTML = ICONS[state] || ICONS.idle;
    if (state === "run") {
      const known = Number.isFinite(progress);
      const fraction = known ? Math.max(0.04, Math.min(1, progress / 100)) : 0.25;
      svg.querySelector(".arc").setAttribute("stroke-dashoffset", String(RING * (1 - fraction)));
      button.classList.toggle("is-spinning", !known);
    } else {
      button.classList.remove("is-spinning");
    }
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.state = state;
  }

  /** An error shows for a moment, then the button goes back to what Cachalot says about the track. */
  function flashError(title) {
    setState("error", title);
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => refresh(), ERROR_RESET_MS);
  }

  function nowPlaying() {
    const badge = document.querySelector(".playControls .playbackSoundBadge");
    const link = badge?.querySelector("a.playbackSoundBadge__titleLink");
    if (!link?.href) return null;
    const title = link.getAttribute("title") || link.textContent.trim();
    const artist = badge.querySelector(".playbackSoundBadge__lightLink")?.getAttribute("title") || "";
    return { url: link.href.split(/[?#]/)[0], title: [artist, title].filter(Boolean).join(" - ") };
  }

  function alive() {
    return Boolean(chrome.runtime?.id); // false once the extension was reloaded after this page opened
  }

  /** Asks Cachalot about the playing track and shows it; polls only while it is queued or downloading. */
  async function refresh() {
    clearTimeout(pollTimer);
    clearTimeout(resetTimer);
    const asked = track?.url;
    if (!button || !asked || !alive()) return;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "playingStatus", url: asked });
    } catch {
      return;
    }
    if (track?.url !== asked || button?.dataset.state === "busy") return; // the track changed or a send started meanwhile
    const view = res?.ok ? res.view : null;
    switch (view?.state) {
      case "done":
        setState("done", `Já baixado no Cachalot: ${track.title} — clique para baixar de novo`);
        return;
      case "run":
        setState("run", `Baixando no Cachalot: ${Math.floor(view.progress || 0)}%${view.detail ? ` · ${view.detail}` : ""}`, Number(view.progress) || 0);
        break;
      case "wait":
      case "paused":
        // paused: the ring stands still where it stopped; queued: it spins
        if (view.state === "paused") setState("run", "Pausado no Cachalot", Number(view.progress) || 0);
        else setState("run", "Na fila do Cachalot");
        break;
      case "fail":
        setState("error", `Falhou no Cachalot${view.detail ? `: ${view.detail}` : ""} — clique para tentar de novo`);
        return;
      default:
        setState("idle");
        return;
    }
    pollTimer = setTimeout(refresh, POLL_MS);
  }

  /**
   * "Baixar como" above the button, unless Cachalot remembers a format for soundcloud.com. Resolves to {} (remembered,
   * or an older Cachalot that does not ask), { audioFormat, rememberFormat } or null when dismissed.
   */
  async function chooseFormat(url) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "playingFormat", url });
    } catch {
      return {};
    }
    if (!res?.ok) return {};
    if (res.format) return { audioFormat: res.format };
    const choice = await askFormat(res.site || "soundcloud.com");
    return choice ? { audioFormat: choice.format, rememberFormat: choice.remember } : null;
  }

  let picker = null; // { host, done }

  function askFormat(site) {
    picker?.done(null);
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;z-index:2147483647;left:0;top:0;";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        .box { display:flex; flex-direction:column; gap:8px; padding:10px; border-radius:10px; background:#1f1f22;
               box-shadow:0 8px 24px rgba(0,0,0,.45); font:12px/1.3 system-ui, "Segoe UI", sans-serif; color:#eee;
               animation:pop .14s ease-out; }
        @keyframes pop { from { opacity:0; transform:translateY(4px); } }
        .title { color:#b4b4b8; font-size:11px; font-weight:650; }
        .box { width:240px; }
        .options { display:flex; flex-direction:column; gap:2px; }
        button { display:flex; align-items:center; gap:8px; width:100%; height:30px; padding:0 10px; margin:0; border:0;
                 border-radius:7px; background:#2c2c31; color:#eee; font:inherit; font-weight:700; line-height:16px; text-align:left;
                 cursor:pointer; transition:background .12s, color .12s; }
        .name { min-width:52px; line-height:16px; }
        .hint { overflow:hidden; color:#b4b4b8; font-size:11px; font-weight:500; line-height:16px; white-space:nowrap; text-overflow:ellipsis; }
        button:hover { background:#38383e; color:#f5a26b; }
        button:active .hint { color:inherit; }
        button:focus-visible { outline:2px solid #E8743C; outline-offset:1px; }
        button:active { background:#E8743C; color:#1a0f08; }
        label { display:flex; align-items:center; gap:6px; color:#b4b4b8; font-size:11.5px; cursor:pointer; user-select:none; }
        input { margin:0; accent-color:#E8743C; }
        @media (prefers-reduced-motion: reduce) { .box { animation:none; } }
      </style>`;
      const box = document.createElement("div");
      box.className = "box";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-label", "Formato do áudio");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = "Baixar como";
      const options = document.createElement("div");
      options.className = "options";
      const label = document.createElement("label");
      label.title = "Não perguntar de novo (dá para mudar nas configurações do Cachalot)";
      const remember = document.createElement("input");
      remember.type = "checkbox";
      label.append(remember, document.createTextNode(`Lembrar para ${site}`));
      const buttons = FORMATS.map(([value, text, hint]) => {
        const b = document.createElement("button");
        b.type = "button";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = text;
        const note = document.createElement("span");
        note.className = "hint";
        note.textContent = hint;
        b.append(name, note);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          done({ format: value, remember: remember.checked });
        });
        options.append(b);
        return b;
      });
      box.append(title, options, label);
      root.append(box);

      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done(null);
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          const i = buttons.indexOf(root.activeElement);
          if (i < 0) return;
          e.preventDefault();
          e.stopPropagation();
          buttons[(i + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
        }
      };
      const onDown = (e) => {
        const path = e.composedPath();
        if (!path.includes(host) && !path.includes(button)) done(null); // the button's own click closes it
      };
      function done(choice) {
        if (picker?.host !== host) return;
        picker = null;
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("pointerdown", onDown, true);
        host.remove();
        resolve(choice);
      }
      picker = { host, done };
      document.documentElement.append(host);
      // above the button (the player bar sits at the bottom), right-aligned with it, inside the window
      const anchor = button.getBoundingClientRect();
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const left = Math.min(Math.max(8, anchor.right - w), Math.max(8, innerWidth - w - 8));
      const top = anchor.top - h - 8 >= 8 ? anchor.top - h - 8 : Math.min(anchor.bottom + 8, innerHeight - h - 8);
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      document.addEventListener("keydown", onKey, true);
      setTimeout(() => picker?.host === host && document.addEventListener("pointerdown", onDown, true), 0);
      buttons[0].focus();
    });
  }

  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.state === "busy") return;
    const playing = nowPlaying();
    if (!playing) {
      flashError("Nenhuma faixa tocando");
      return;
    }
    if (!alive()) {
      flashError(RELOAD_TITLE);
      return;
    }
    if (picker) {
      picker.done(null); // a second click on the button closes the question
      return;
    }
    clearTimeout(pollTimer);
    const format = await chooseFormat(playing.url);
    if (!format) {
      refresh(); // dismissed: back to what Cachalot says about the track
      return;
    }
    setState("busy", "Enviando ao Cachalot…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "sendPlaying", url: playing.url, title: playing.title, ...format });
      if (!res?.ok) {
        flashError(res?.message || "Não foi possível enviar ao Cachalot");
        return;
      }
      setState("run", "Na fila do Cachalot");
      pollTimer = setTimeout(refresh, POLL_MS);
    } catch {
      flashError(RELOAD_TITLE);
    }
  }

  function makeButton() {
    const el = document.createElement("button");
    el.type = "button";
    // SoundCloud's own classes: same size, color and hover as the like button next to it
    el.className = `${BUTTON_CLASS} sc-button sc-button-secondary sc-button-small sc-button-icon sc-button-responsive sc-mr-1x`;
    el.innerHTML = '<div><svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg></div>';
    el.addEventListener("click", onClick);
    return el;
  }

  /** Puts the button in the bar if it is missing, and asks Cachalot again when the track changed. */
  function sync() {
    const actions = document.querySelector(".playControls .playbackSoundBadge__actions");
    if (actions && !actions.querySelector(`.${BUTTON_CLASS}`)) {
      button = makeButton();
      setState("idle");
      actions.insertBefore(button, actions.querySelector(".playbackSoundBadge__like") || actions.firstChild);
      track = null; // a new button knows nothing yet
    }
    const playing = nowPlaying();
    if (playing?.url !== track?.url) {
      track = playing;
      if (button?.dataset.state !== "busy") setState("idle");
      refresh();
    }
  }

  const style = document.createElement("style");
  style.textContent = `.${BUTTON_CLASS}[data-state="busy"] { opacity: .5; cursor: progress; }
.${BUTTON_CLASS}[data-state="run"] { color: #E8743C !important; }
.${BUTTON_CLASS} .arc { transition: stroke-dashoffset .8s ease-out; }
.${BUTTON_CLASS}.is-spinning svg { animation: cachalot-sc-spin 1s linear infinite; }
.${BUTTON_CLASS}[data-state="done"] { color: #2EB872 !important; }
.${BUTTON_CLASS}[data-state="error"] { color: #E5484D !important; }
@keyframes cachalot-sc-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .${BUTTON_CLASS}.is-spinning svg { animation: none; } .${BUTTON_CLASS} .arc { transition: none; } }`;
  (document.head || document.documentElement).appendChild(style);

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });

  // Downloaded meanwhile from the popup or Cachalot itself: back on the tab, ask again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && button?.dataset.state !== "busy") refresh();
  });

  sync();
})();
