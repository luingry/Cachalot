import test from "node:test";
import assert from "node:assert/strict";
import {
  cookieBelongsTo,
  cookiesForDomain,
  hostMatchesDomain,
  isIpAddress,
  registrableDomain,
  registrableDomainOfUrl,
  toBridgeCookie,
} from "../src/lib/domain.js";

test("registrableDomain strips subdomains", () => {
  assert.equal(registrableDomain("www.youtube.com"), "youtube.com");
  assert.equal(registrableDomain("music.youtube.com"), "youtube.com");
  assert.equal(registrableDomain("youtube.com"), "youtube.com");
  assert.equal(registrableDomain("a.b.c.example.org"), "example.org");
  assert.equal(registrableDomain("WWW.Example.COM."), "example.com");
});

test("registrableDomain keeps multi-label public suffixes", () => {
  assert.equal(registrableDomain("www.globo.com.br"), "globo.com.br");
  assert.equal(registrableDomain("g1.globo.com.br"), "globo.com.br");
  assert.equal(registrableDomain("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("m.example.co.jp"), "example.co.jp");
  assert.equal(registrableDomain("com.br"), "com.br");
});

test("registrableDomain leaves IPs and single labels alone", () => {
  assert.equal(registrableDomain("127.0.0.1"), "127.0.0.1");
  assert.equal(registrableDomain("localhost"), "localhost");
  assert.equal(registrableDomain("[::1]"), "::1");
  assert.ok(isIpAddress("10.0.0.5"));
  assert.ok(!isIpAddress("example.com"));
  assert.equal(registrableDomain(""), "");
  assert.equal(registrableDomain(undefined), "");
});

test("registrableDomainOfUrl only accepts http(s)", () => {
  assert.equal(registrableDomainOfUrl("https://www.tiktok.com/@a/video/1"), "tiktok.com");
  assert.equal(registrableDomainOfUrl("chrome://extensions"), "");
  assert.equal(registrableDomainOfUrl("not a url"), "");
});

test("hostMatchesDomain matches the domain and its subdomains only", () => {
  assert.ok(hostMatchesDomain("youtube.com", "youtube.com"));
  assert.ok(hostMatchesDomain("www.youtube.com", "youtube.com"));
  assert.ok(!hostMatchesDomain("notyoutube.com", "youtube.com"));
  assert.ok(!hostMatchesDomain("youtube.com.evil.net", "youtube.com"));
});

test("cookie filtering keeps the page domain and subdomains, never other sites", () => {
  const cookies = [
    { domain: ".youtube.com", name: "SID", value: "1", path: "/", secure: true, httpOnly: true, hostOnly: false, expirationDate: 2000000000, session: false, storeId: "0" },
    { domain: "www.youtube.com", name: "PREF", value: "2", path: "/", secure: false, httpOnly: false, hostOnly: true },
    { domain: ".google.com", name: "NID", value: "3", path: "/", secure: true, httpOnly: true, hostOnly: false },
    { domain: "evilyoutube.com", name: "X", value: "4", path: "/" },
  ];
  assert.ok(cookieBelongsTo(cookies[0], "youtube.com"));
  assert.ok(!cookieBelongsTo(cookies[2], "youtube.com"));
  const out = cookiesForDomain(cookies, "youtube.com");
  assert.deepEqual(out.map((c) => c.name), ["SID", "PREF"]);
  assert.deepEqual(Object.keys(out[0]).sort(), ["domain", "expirationDate", "hostOnly", "httpOnly", "name", "path", "secure", "value"]);
  assert.equal(out[1].expirationDate, undefined, "session cookies carry no expirationDate");
  assert.deepEqual(cookiesForDomain(cookies, ""), []);
  assert.deepEqual(cookiesForDomain(null, "youtube.com"), []);
});

test("toBridgeCookie drops chrome-only fields", () => {
  const c = toBridgeCookie({ domain: "a.com", name: "n", value: "v", path: "/x", secure: 1, httpOnly: 0, hostOnly: true, storeId: "0", sameSite: "lax", session: true });
  assert.deepEqual(c, { domain: "a.com", path: "/x", secure: true, httpOnly: false, hostOnly: true, name: "n", value: "v" });
});
