// Shows, on the button that sent an item, how its download goes in Cachalot
// (GET /downloads), so a sent item never looks new again.

/** Same item for small URL differences (fragment, trailing slash). */
export function downloadKey(url) {
  return String(url || "")
    .split("#")[0]
    .replace(/\/+$/, "");
}

/** key -> the newest Cachalot item for that URL. */
export function latestByUrl(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = downloadKey(item?.url);
    if (!key) continue;
    const known = map.get(key);
    if (!known || (item.created || 0) > (known.created || 0)) map.set(key, item);
  }
  return map;
}

/**
 * What the button shows: null = the normal "Baixar".
 * { text, state: "wait" | "run" | "done" | "fail" | "paused", progress, title, locked }
 * A finished item also carries folderId: the id the folder button beside it asks
 * Cachalot to open (POST /open-folder); null when Cachalot gave no id.
 * sent: the extension sent this URL (Cachalot may not list it yet).
 */
export function downloadView(item, sent = false) {
  if (!item) return sent ? { text: "✓ Na fila", state: "wait", progress: 0, title: "Enviado ao Cachalot", locked: true } : null;
  const view = baseView(item);
  // Still on its way and Cachalot gave its id: the button cancels it (on hover it says so).
  if (view.state !== "done" && view.state !== "fail" && item.id) {
    view.cancelId = String(item.id);
    view.locked = false;
    view.title = `${view.title} — clique para cancelar`;
  }
  return view;
}

function baseView(item) {
  const progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
  const detail = [item.speed, item.eta && `faltam ${item.eta}`].filter(Boolean).join(" · ");
  switch (item.status) {
    case "baixando":
      return { text: `${Math.floor(progress)}%`, state: "run", progress, title: detail || "Baixando", locked: true };
    case "processando":
      return { text: "99%", state: "run", progress: 99, title: item.phase || "Finalizando", locked: true };
    case "concluido":
      // Not locked: on hover it offers "Baixar de novo".
      return { text: "✓ Baixado", state: "done", progress: 100, title: "Já está na pasta do Cachalot — clique para baixar de novo", locked: false, folderId: item.id ? String(item.id) : null };
    case "erro":
      return { text: "Falhou", state: "fail", progress: 0, title: `${item.error || "O download falhou"} — clique para tentar de novo`, locked: false };
    case "pausado":
      return { text: "Pausado", state: "paused", progress, title: "Pausado no Cachalot", locked: true };
    default:
      return { text: "Na fila…", state: "wait", progress: 0, title: item.phase || "Esperando a vez no Cachalot", locked: true };
  }
}

/**
 * The item to show for a URL. After "Baixar de novo" (resentAt, ms) the old finished item no longer
 * counts, so the button shows "Na fila" and keeps polling until Cachalot lists the new one.
 */
export function currentItem(item, resentAt = 0) {
  if (!item || !resentAt) return item;
  return (Number(item.created) || 0) * 1000 < resentAt - 1000 ? undefined : item;
}

/**
 * How long a sent URL that Cachalot does not list (yet) still shows "✓ Na fila". Past it the item was
 * removed or cleared in Cachalot (or never arrived), so the button offers "Baixar" again instead of
 * waiting forever.
 */
export const SENT_GRACE_MS = 60_000;

/** sentAt (ms) is recent enough that Cachalot may simply not list the item yet. */
export function awaitingListing(sentAt, now = Date.now()) {
  const at = Number(sentAt) || 0;
  return at > 0 && now - at < SENT_GRACE_MS;
}

/** Polling is worth it while something sent is still on its way. */
export function anyActive(views) {
  return views.some((v) => v && (v.state === "wait" || v.state === "run"));
}
