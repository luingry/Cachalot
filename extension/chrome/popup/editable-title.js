// A title the user can rename in place: a click turns the very same element into the field (same font, same
// place), Enter or leaving it keeps the new name, Esc gives up. Used by the page card and the transient view.

/**
 * opts: {
 *   label: what it is, for screen readers and the tooltip,
 *   read(): the name the field starts from,
 *   commit(text | null): the new name (null: emptied, back to the original); repaints the element itself,
 * }
 */
export function makeTitleEditable(node, { label, read, commit }) {
  node.classList.add("editable-title");
  node.tabIndex = 0;
  node.spellcheck = false;
  node.setAttribute("role", "textbox");
  node.setAttribute("aria-label", label);
  let before = "";
  let enabled = true;

  const editing = () => node.isContentEditable;

  function start() {
    if (!enabled || editing()) return;
    before = read();
    node.textContent = before;
    node.contentEditable = "plaintext-only";
    node.classList.add("is-editing");
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function finish(save) {
    if (!editing()) return;
    node.contentEditable = "false";
    node.classList.remove("is-editing");
    node.scrollLeft = 0;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    node.textContent = before;
    if (save && text !== before) commit(text || null);
  }

  node.addEventListener("click", start);
  node.addEventListener("keydown", (e) => {
    if (!editing()) {
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        start();
      }
      return;
    }
    e.stopPropagation(); // Space, Ctrl+Z and the like are typing here
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
      node.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
      node.blur();
    }
  });
  node.addEventListener("blur", () => finish(true));

  return {
    setEnabled(on) {
      enabled = on;
      node.classList.toggle("is-locked", !on);
      node.tabIndex = on ? 0 : -1;
      if (!on) finish(false);
    },
  };
}
