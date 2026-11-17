// "Baixar como": the audio format question asked before an audio download, unless Cachalot remembers one for the
// site. Same look as the transient mode's "Salvar como"; "Lembrar para este site" makes Cachalot store the choice
// (Configurações › Formato do áudio por site).

import { AUDIO_FORMATS, AUDIO_FORMAT_HINTS, AUDIO_FORMAT_LABELS } from "../src/lib/payload.js";

const LAST_KEY = "lastAudioFormat";
let open = null; // { box, anchor, done }

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function lastFormat() {
  try {
    return (await chrome.storage.local.get(LAST_KEY))[LAST_KEY] || "mp3";
  } catch {
    return "mp3";
  }
}

/**
 * Asks next to `button` (the one that was clicked). Resolves to { format, remember } or null when dismissed
 * (Esc, a click outside, or the same button again).
 */
export async function pickAudioFormat(button, site = "") {
  if (open?.anchor === button) {
    open.done(null);
    return null;
  }
  open?.done(null);
  const anchor = button.getBoundingClientRect();
  const focused = await lastFormat();
  return new Promise((resolve) => {
    const box = el("div", "tr-format format-pop");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Formato do áudio");
    const options = el("div", "tr-format-options");
    const remember = el("input");
    remember.type = "checkbox";
    const rememberLabel = el("label", "tr-format-remember");
    rememberLabel.title = "Não perguntar de novo neste site (dá para mudar nas configurações do Cachalot)";
    rememberLabel.append(remember, el("span", "", site ? `Lembrar para ${site}` : "Lembrar para este site"));
    const buttons = AUDIO_FORMATS.map((f) => {
      const b = el("button", "tr-format-btn format-pop-btn");
      b.type = "button";
      b.dataset.format = f;
      b.append(el("span", "format-pop-name", AUDIO_FORMAT_LABELS[f]), el("span", "format-pop-hint", AUDIO_FORMAT_HINTS[f]));
      b.addEventListener("click", () => done({ format: f, remember: remember.checked }));
      options.append(b);
      return b;
    });
    box.append(el("div", "tr-format-title", "Baixar como"), options, rememberLabel);

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const i = buttons.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        buttons[(i + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
      }
    };
    const onDown = (e) => {
      if (!box.contains(e.target) && !button.contains(e.target)) done(null);
    };
    function done(choice) {
      if (open?.box !== box) return;
      open = null;
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      box.remove();
      if (choice) chrome.storage.local.set({ [LAST_KEY]: choice.format }).catch(() => {});
      resolve(choice);
    }
    open = { box, anchor: button, done };
    document.body.append(box);
    // under the button, right-aligned with it, kept inside the popup
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const left = Math.min(Math.max(8, anchor.right - w), Math.max(8, vw - w - 8));
    let top = anchor.bottom + 6;
    if (top + h > vh - 8 && anchor.top - h - 6 >= 8) top = anchor.top - h - 6;
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(8, top)}px`;
    document.addEventListener("keydown", onKey, true);
    // the click that opened it is over; the next one outside closes it
    setTimeout(() => open?.box === box && document.addEventListener("pointerdown", onDown, true), 0);
    (buttons.find((b) => b.dataset.format === focused) || buttons[0]).focus();
  });
}
