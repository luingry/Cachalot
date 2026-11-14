// Pairing-code helpers. Cachalot shows an 8-character code made of A-Z and
// 2-9; users paste it with spaces, dashes or in lower case.

export const PAIRING_CODE_LENGTH = 8;
const VALID_CODE = /^[A-Z2-9]{8}$/;

/** Trims, upper-cases and strips whitespace and dashes. */
export function normalizePairingCode(input) {
  if (typeof input !== "string") return "";
  return input.trim().toUpperCase().replace(/[\s\-‐-―]+/g, "");
}

export function isValidPairingCode(code) {
  return typeof code === "string" && VALID_CODE.test(code);
}

/** Normalizes user input and reports whether the result is a valid code. */
export function parsePairingCode(input) {
  const code = normalizePairingCode(input);
  return { code, valid: isValidPairingCode(code) };
}

/** Display form used in inputs: ABCD-2345. */
export function formatPairingCode(code) {
  const c = normalizePairingCode(code);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}
