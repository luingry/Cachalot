// SoundCloud: a "download" button in the bottom player bar, left of the like button. A click sends the track
// that is playing to Cachalot (audio). SoundCloud re-renders the bar on every track change, so an observer puts
// the button back whenever it goes missing.
(() => {
  if (window.__cachalotSoundcloud) return;
  window.__cachalotSoundcloud = true;

  const BUTTON_CLASS = "cachalot-sc-download";
  const IDLE_TITLE = "Baixar com o Cachalot";
  const ICONS = {
    idle: '<path d="M7.25 1.5h1.5v7.19l2.47-2.47 1.06 1.06L8 11.56 3.72 7.28l1.06-1.06 2.47 2.47V1.5z" fill="currentColor"/><path d="M2 12.5h12V14H2z" fill="currentColor"/>',
    ok: '<path d="M6.25 11.19 13.22 4.22l1.06 1.06-8.03 8.03L1.72 8.78l1.06-1.06z" fill="currentColor"/>',
    error: '<path d="M7.25 2h1.5v7.5h-1.5zM7.25 11.5h1.5V13h-1.5z" fill="currentColor"/>',
  };
  const RESET_MS = { ok: 2000, error: 5000 };

  function setState(button, state, title = IDLE_TITLE) {
    button.querySelector("svg").innerHTML = ICONS[state] || ICONS.idle;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.state = state;
    clearTimeout(button._cachalotReset);
    if (RESET_MS[state]) button._cachalotReset = setTimeout(() => setState(button, "idle"), RESET_MS[state]);
  }

  function nowPlaying() {
    const badge = document.querySelector(".playControls .playbackSoundBadge");
    const link = badge?.querySelector("a.playbackSoundBadge__titleLink");
    if (!link?.href) return null;
    const title = link.getAttribute("title") || link.textContent.trim();
    const artist = badge.querySelector(".playbackSoundBadge__lightLink")?.getAttribute("title") || "";
    return { url: link.href, title: [artist, title].filter(Boolean).join(" - ") };
  }

  async function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    if (button.dataset.state === "busy") return;
    const track = nowPlaying();
    if (!track) {
      setState(button, "error", "Nenhuma faixa tocando");
      return;
    }
    if (!chrome.runtime?.id) {
      // the extension was reloaded after this page opened: this script can no longer reach it
      setState(button, "error", "Cachalot atualizado — recarregue a página");
      return;
    }
    setState(button, "busy", "Enviando ao Cachalot…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "sendPlaying", url: track.url, title: track.title });
      if (res?.ok) setState(button, "ok", `Enviado ao Cachalot: ${track.title}`);
      else setState(button, "error", res?.message || "Não foi possível enviar ao Cachalot");
    } catch {
      setState(button, "error", "Cachalot atualizado — recarregue a página");
    }
  }

  function makeButton() {
    const button = document.createElement("button");
    button.type = "button";
    // SoundCloud's own classes: same size, color and hover as the like button next to it
    button.className = `${BUTTON_CLASS} sc-button sc-button-secondary sc-button-small sc-button-icon sc-button-responsive sc-mr-1x`;
    button.innerHTML = '<div><svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg></div>';
    setState(button, "idle");
    button.addEventListener("click", onClick);
    return button;
  }

  function ensureButton() {
    const actions = document.querySelector(".playControls .playbackSoundBadge__actions");
    if (!actions || actions.querySelector(`.${BUTTON_CLASS}`)) return;
    const like = actions.querySelector(".playbackSoundBadge__like");
    actions.insertBefore(makeButton(), like || actions.firstChild);
  }

  const style = document.createElement("style");
  style.textContent = `.${BUTTON_CLASS}[data-state="busy"] { opacity: .5; cursor: progress; }
.${BUTTON_CLASS}[data-state="ok"] { color: #E8743C !important; }
.${BUTTON_CLASS}[data-state="error"] { color: #d33 !important; }`;
  (document.head || document.documentElement).appendChild(style);

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ensureButton();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
})();
