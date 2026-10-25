import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("text goes inline, binaries become one blob each, and a missing branch is created", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "push-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, bytes] of [
    ["a/SKILL.md", "text"],
    ["b/SKILL.md", "text"],
    ["a/x.mp3", Buffer.from([0, 1, 2])],
    ["b/x.mp3", Buffer.from([0, 1, 2])],
  ]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body && JSON.parse(body) });
      const missing = req.method === "PATCH";
      res.writeHead(missing ? 404 : 201, { "content-type": "application/json" });
      res.end(JSON.stringify({ sha: "sha" }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.REPO = "o/r";
  process.env.GH_TOKEN = "t";
  const { pushFolder } = await import("./push-claude-plugin.mjs");
  await pushFolder(dir, "claude-plugin", "chore: x");
  const urls = calls.map((c) => `${c.method} ${c.url}`);
  assert.equal(urls.filter((u) => u.endsWith("/git/blobs")).length, 1);
  const tree = calls.find((c) => c.url.endsWith("/git/trees")).body.tree;
  assert.equal(tree.filter((e) => e.content === "text").length, 2);
  assert.deepEqual(calls.find((c) => c.url.endsWith("/git/commits")).body.parents, []);
  assert.deepEqual(urls.slice(-2), [
    "PATCH /repos/o/r/git/refs/heads/claude-plugin",
    "POST /repos/o/r/git/refs",
  ]);
});
