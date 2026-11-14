// Options page: pairing code, port override, cookie default.

import { DEFAULT_PORT, STORAGE_KEYS, describeBridgeError, isValidPort } from "../src/lib/bridge.js";
import { formatPairingCode, parsePairingCode } from "../src/lib/pairing.js";
import { clearCookieOverrides, getCookieOverrides, getCookiesDefault, setCookiesDefault } from "../src/lib/settings.js";

const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;

async function message(type, extra = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, ...extra })) || { ok: false, error: "internal" };
  } catch (err) {
    return { ok: false, error: "internal", message: String(err?.message || err) };
  }
}

function showResult(kind, text) {
  const p = $("result");
  p.className = `msg msg-${kind}`;
  p.textContent = text;
  p.hidden = false;
  p.style.animation = "none";
  void p.offsetWidth;
  p.style.animation = "";
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
}

async function renderPortInfo() {
  const data = await store.get([STORAGE_KEYS.port, STORAGE_KEYS.portOverride]);
  const override = data[STORAGE_KEYS.portOverride];
  const auto = !isValidPort(override);
  $("portAuto").checked = auto;
  $("portRow").hidden = auto;
  if (!auto && document.activeElement !== $("port")) $("port").value = String(override);
  const last = data[STORAGE_KEYS.port];
  $("portInfo").textContent = auto && isValidPort(last) ? `Última porta encontrada: ${last}` : "";
}

async function renderOverrides() {
  const overrides = await getCookieOverrides(store);
  const n = Object.keys(overrides).length;
  $("overridesRow").hidden = n === 0;
  $("overridesText").textContent = n === 1 ? "1 site com escolha própria" : `${n} sites com escolha própria`;
}

async function onSaveCode(event) {
  event.preventDefault();
  const { code, valid } = parsePairingCode($("code").value);
  if (!valid) {
    showResult("error", describeBridgeError({ error: "invalid_code" }));
    $("code").focus();
    return;
  }
  $("code").value = formatPairingCode(code);
  setBusy($("save"), true);
  showResult("info", "Verificando com o Cachalot…");
  const res = await message("pair", { code });
  setBusy($("save"), false);
  if (res.ok) {
    showResult("ok", `Pareado ✓ — Cachalot ${res.version ? `v${res.version} ` : ""}na porta ${res.port}`);
  } else if (res.error === "closed") {
    await store.set({ [STORAGE_KEYS.code]: code });
    showResult("info", "Código salvo. O Cachalot está fechado: a conexão será confirmada quando ele abrir.");
  } else {
    showResult("error", describeBridgeError(res));
  }
}

async function onTest() {
  setBusy($("test"), true);
  showResult("info", "Procurando o Cachalot…");
  const res = await message("status");
  setBusy($("test"), false);
  if (res.state === "paired") {
    showResult("ok", `Conectado ao Cachalot ${res.version ? `v${res.version} ` : ""}na porta ${res.port} ✓`);
  } else if (res.state === "unpaired") {
    showResult(
      res.hasCode ? "error" : "info",
      res.hasCode
        ? `O Cachalot respondeu na porta ${res.port}, mas não aceitou o código salvo.`
        : `O Cachalot respondeu na porta ${res.port}. Cole o código para parear.`,
    );
  } else if (res.state === "closed") {
    showResult("error", describeBridgeError({ error: "closed" }));
  } else {
    showResult("error", describeBridgeError(res));
  }
  renderPortInfo();
}

async function onPortAuto() {
  if ($("portAuto").checked) {
    await store.set({ [STORAGE_KEYS.portOverride]: null });
  } else {
    // Start the fixed port from what is typed, else the last port that worked,
    // else the default, so the stored state always matches the switch.
    const typed = Number($("port").value);
    const { [STORAGE_KEYS.port]: last } = await store.get(STORAGE_KEYS.port);
    const value = isValidPort(typed) && $("port").value ? typed : isValidPort(last) ? Number(last) : DEFAULT_PORT;
    $("port").value = String(value);
    await store.set({ [STORAGE_KEYS.portOverride]: value });
    $("port").focus();
    $("port").select();
  }
  renderPortInfo();
}

async function onPortChange() {
  const value = Number($("port").value);
  if (!isValidPort(value)) {
    showResult("error", "Porta inválida: use um número entre 1 e 65535.");
    return;
  }
  await store.set({ [STORAGE_KEYS.portOverride]: value });
  showResult("info", `Usando a porta ${value}.`);
}

async function renderShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === "send-page");
    $("shortcutKeys").textContent = cmd?.shortcut || "sem atalho";
  } catch {
    // keep the default text
  }
}

async function init() {
  $("version").textContent = chrome.runtime.getManifest().version;
  const data = await store.get(STORAGE_KEYS.code);
  if (data[STORAGE_KEYS.code]) $("code").value = formatPairingCode(data[STORAGE_KEYS.code]);
  $("cookiesDefault").checked = await getCookiesDefault(store);

  $("pairForm").addEventListener("submit", onSaveCode);
  $("test").addEventListener("click", onTest);
  $("portAuto").addEventListener("change", onPortAuto);
  $("port").addEventListener("change", onPortChange);
  $("cookiesDefault").addEventListener("change", async () => {
    await setCookiesDefault(store, $("cookiesDefault").checked);
    renderOverrides();
  });
  $("clearOverrides").addEventListener("click", async () => {
    await clearCookieOverrides(store);
    renderOverrides();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (STORAGE_KEYS.port in changes || STORAGE_KEYS.portOverride in changes) renderPortInfo();
    if ("cookieSiteOverrides" in changes) renderOverrides();
  });

  await Promise.all([renderPortInfo(), renderOverrides(), renderShortcut()]);
  document.body.dataset.ready = "1";
}

init();
