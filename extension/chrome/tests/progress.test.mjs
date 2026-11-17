import test from "node:test";
import assert from "node:assert/strict";
import { SENT_GRACE_MS, anyActive, awaitingListing, currentItem, downloadKey, downloadView, latestByUrl } from "../src/lib/progress.js";

test("downloadKey ignores fragments and trailing slashes", () => {
  assert.equal(downloadKey("https://soundcloud.com/a/b/#t=1"), "https://soundcloud.com/a/b");
  assert.equal(downloadKey(null), "");
});

test("latestByUrl keeps the newest item of each URL", () => {
  const map = latestByUrl([
    { url: "https://x.com/v/1", status: "erro", created: 1 },
    { url: "https://x.com/v/1/", status: "baixando", created: 5 },
    { url: "", status: "pendente" },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("https://x.com/v/1").status, "baixando");
});

test("downloadView: the clicked button follows the download", () => {
  assert.equal(downloadView(undefined, false), null, "never sent: the normal Baixar");
  assert.equal(downloadView(undefined, true).text, "✓ Na fila");
  assert.deepEqual(
    [["pendente"], ["analisando"]].map(([status]) => downloadView({ status }).text),
    ["Na fila…", "Na fila…"],
  );
  const run = downloadView({ status: "baixando", progress: 42.7, speed: "1MiB/s", eta: "00:10" });
  assert.deepEqual([run.text, run.state, run.progress, run.title, run.locked], ["42%", "run", 42.7, "1MiB/s · faltam 00:10", true]);
  assert.equal(downloadView({ status: "processando", phase: "Juntando vídeo e áudio" }).title, "Juntando vídeo e áudio");
  assert.deepEqual([downloadView({ status: "concluido" }).text, downloadView({ status: "concluido" }).locked], ["✓ Baixado", false], "done stays clickable: download again");
  assert.equal(downloadView({ status: "concluido", id: "a1" }).folderId, "a1", "a finished item offers its folder");
  assert.equal(downloadView({ status: "concluido" }).folderId, null, "no id, no folder button");
  assert.equal(run.folderId, undefined, "only finished items offer the folder");
  const cancellable = downloadView({ id: "r1", status: "baixando", progress: 10 });
  assert.deepEqual([cancellable.cancelId, cancellable.locked], ["r1", false], "on its way with an id: cancellable");
  assert.equal(downloadView({ id: "d1", status: "concluido" }).cancelId, undefined);
  assert.equal(downloadView({ id: "e1", status: "erro" }).cancelId, undefined);
  assert.equal(downloadView(undefined, true).cancelId, undefined, "not listed yet: nothing to cancel");
  const fail = downloadView({ status: "erro", error: "Conteúdo privado." });
  assert.deepEqual([fail.text, fail.locked], ["Falhou", false]);
  assert.ok(fail.title.startsWith("Conteúdo privado."));
  assert.ok(anyActive([null, run]));
  assert.ok(!anyActive([downloadView({ status: "concluido" }), fail, null]));
});

test("awaitingListing: a sent item Cachalot no longer lists stops showing Na fila", () => {
  const now = 10_000_000;
  assert.ok(awaitingListing(now - 2_000, now), "just sent: Cachalot may not list it yet");
  assert.ok(!awaitingListing(now - SENT_GRACE_MS, now), "removed or cleared in Cachalot: Baixar again");
  assert.ok(!awaitingListing(undefined, now), "never sent");
  assert.equal(downloadView(undefined, awaitingListing(now - 3_600_000, now)), null);
});

test("currentItem: after sending again, the old finished item no longer counts", () => {
  const old = { status: "concluido", created: 1000 };
  assert.equal(currentItem(old, 0), old);
  assert.equal(currentItem(old, 1000 * 1000 + 60_000), undefined, "resent a minute later: wait for the new item");
  const fresh = { status: "pendente", created: 2000 };
  assert.equal(currentItem(fresh, 2000 * 1000), fresh);
  assert.equal(downloadView(currentItem(old, 2_000_000), true).text, "✓ Na fila");
});

test("latestMatching picks the newest item whose URL matches", async () => {
  const { latestMatching } = await import("../src/lib/progress.js");
  const { soundcloudTrackUrl } = await import("../src/lib/platforms.js");
  const track = "https://soundcloud.com/forss/flickermood";
  const match = (url) => soundcloudTrackUrl(url) === track;
  const items = [
    { url: "https://soundcloud.com/forss/flickermood?in=x/sets/y", status: "erro", created: 1 },
    { url: "https://soundcloud.com/forss/voca-nomen-tuum", status: "concluido", created: 5 },
    { url: track, status: "concluido", created: 3 },
    null,
  ];
  assert.equal(latestMatching(items, match).created, 3);
  assert.equal(latestMatching(items, () => false), undefined);
  assert.equal(latestMatching(undefined, match), undefined);
});
