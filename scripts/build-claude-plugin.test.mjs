import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LEGACY_CORE_SKILLS, buildClaudePlugin } from "./build-claude-plugin.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "claude-plugin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write(".claude-plugin/plugin.json", '{"name":"hyperframes","version":"1.0.0"}');
  for (const name of [...LEGACY_CORE_SKILLS, "slideshow"]) write(`skills/${name}/SKILL.md`, name);
  write("skills/slideshow/assets/a.txt", "asset");
  write("skills/stray.test.mjs", "not a skill");
  return { root, out: join(root, "out") };
}

test("the full plugin carries every skill and the legacy one only the core skills", (t) => {
  const { root, out } = fixture(t);
  buildClaudePlugin(out, root);
  assert.ok(existsSync(join(out, "hyperframes/skills/slideshow/assets/a.txt")));
  assert.ok(!existsSync(join(out, "hyperframes/skills/stray.test.mjs")));
  assert.deepEqual(
    readdirSync(join(out, "core-skills/skills")).sort(),
    [...LEGACY_CORE_SKILLS].sort(),
  );
  for (const dir of ["hyperframes", "core-skills"]) {
    assert.ok(existsSync(join(out, dir, ".claude-plugin/plugin.json")));
    assert.ok(!existsSync(join(out, dir, "package.json")));
  }
});

test("the real repo builds the same core skills the marketplace lists", (t) => {
  const out = mkdtempSync(join(tmpdir(), "claude-plugin-real-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  buildClaudePlugin(out);
  const marketplace = JSON.parse(
    readFileSync(join(REPO, ".claude-plugin/marketplace.json"), "utf8"),
  );
  const legacy = marketplace.plugins.find((p) => p.name === "core-skills");
  assert.deepEqual(
    legacy.skills.map((p) => p.replace("./skills/", "")).sort(),
    readdirSync(join(out, "core-skills/skills")).sort(),
  );
});
