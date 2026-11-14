import test from "node:test";
import assert from "node:assert/strict";
import { formatPairingCode, isValidPairingCode, normalizePairingCode, parsePairingCode } from "../src/lib/pairing.js";

test("normalizePairingCode trims, upper-cases and strips spaces and dashes", () => {
  assert.equal(normalizePairingCode("  abcd-2345 "), "ABCD2345");
  assert.equal(normalizePairingCode("ab cd 23 45"), "ABCD2345");
  assert.equal(normalizePairingCode("AB–CD\t2345\n"), "ABCD2345");
  assert.equal(normalizePairingCode(null), "");
});

test("isValidPairingCode accepts 8 chars of A-Z and 2-9", () => {
  assert.ok(isValidPairingCode("ABCD2345"));
  assert.ok(isValidPairingCode("ZZZZ9999"));
  assert.ok(!isValidPairingCode("ABCD234"), "too short");
  assert.ok(!isValidPairingCode("ABCD23456"), "too long");
  assert.ok(!isValidPairingCode("ABCD2301"), "0 and 1 are not in the alphabet");
  assert.ok(!isValidPairingCode("abcd2345"), "must be normalized first");
});

test("parsePairingCode reports normalized code and validity", () => {
  assert.deepEqual(parsePairingCode("wxyz-6789"), { code: "WXYZ6789", valid: true });
  assert.deepEqual(parsePairingCode("abc"), { code: "ABC", valid: false });
});

test("formatPairingCode groups as XXXX-XXXX", () => {
  assert.equal(formatPairingCode("abcd2345"), "ABCD-2345");
  assert.equal(formatPairingCode("AB"), "AB");
});
