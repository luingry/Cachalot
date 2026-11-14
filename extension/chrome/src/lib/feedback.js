// Short toolbar-badge feedback (✓ / !) after a send that has no popup to show
// the result in (context menu, keyboard shortcut). Timers are injectable.

export const FEEDBACK_MS = 2000;
export const SUCCESS_TEXT = "✓";
export const ERROR_TEXT = "!";
export const SUCCESS_COLOR = "#63C28F";
export const ERROR_COLOR = "#E5675B";

/**
 * setBadge(tabId, text, color) paints the badge; restore(tabId) puts the
 * regular badge (media count) back once the feedback expires.
 */
export function createBadgeFeedback({
  setBadge,
  restore,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  durationMs = FEEDBACK_MS,
}) {
  const timers = new Map();

  function isActive(tabId) {
    return timers.has(tabId);
  }

  async function show(tabId, ok) {
    if (tabId === undefined || tabId === null || tabId < 0) return;
    const pending = timers.get(tabId);
    if (pending !== undefined) clearTimeoutFn(pending);
    const handle = setTimeoutFn(() => {
      timers.delete(tabId);
      Promise.resolve(restore(tabId)).catch(() => {});
    }, durationMs);
    timers.set(tabId, handle);
    await setBadge(tabId, ok ? SUCCESS_TEXT : ERROR_TEXT, ok ? SUCCESS_COLOR : ERROR_COLOR);
  }

  return { show, isActive };
}
