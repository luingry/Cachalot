// Session rule that gives the popup's preview requests the page's Referer, so
// sites with hotlink protection answer them as they answer the page. Scoped to
// requests this extension starts outside tabs (the popup), never the bridge.
// The service worker removes it when the popup closes.

export const PREVIEW_RULE_ID = 1;

/** null when the referer is not an http(s) URL. tabIds: [-1] plus the popup's own tab when opened as a page. */
export function previewHeaderRule({ referer, extensionId, tabIds = [-1] }) {
  if (!/^https?:\/\//i.test(String(referer || "")) || !extensionId) return null;
  return {
    id: PREVIEW_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "referer", operation: "set", value: referer }],
    },
    condition: {
      tabIds,
      initiatorDomains: [extensionId],
      excludedRequestDomains: ["127.0.0.1", "localhost"],
      resourceTypes: ["media", "xmlhttprequest", "image", "other"],
    },
  };
}
