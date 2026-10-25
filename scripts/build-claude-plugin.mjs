#!/usr/bin/env node
// Builds the folders Claude Code installs from, which release CI pushes to the claude-plugin branch.
// Each folder is skills/ plus the manifest with no package.json, so Claude Code never tries to
// install the monorepo's dependencies. Usage: node scripts/build-claude-plugin.mjs <outDir>

import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The legacy core-skills plugin ships these skills only. */
export const LEGACY_CORE_SKILLS = [
  "hyperframes",
  "hyperframes-cli",
  "hyperframes-registry",
  "media-use",
];

/** Plugin folder -> the skills it carries; null means every skill. */
export const PLUGINS = { hyperframes: null, "core-skills": LEGACY_CORE_SKILLS };

/** @param {string} outDir @param {string} root */
export function buildClaudePlugin(outDir, root = ROOT) {
  const skills = join(root, "skills");
  const all = readdirSync(skills, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const [dir, only] of Object.entries(PLUGINS)) {
    const target = join(outDir, dir);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(join(target, ".claude-plugin"), { recursive: true });
    cpSync(join(root, ".claude-plugin/plugin.json"), join(target, ".claude-plugin/plugin.json"));
    for (const name of only ?? all) {
      cpSync(join(skills, name), join(target, "skills", name), { recursive: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]) throw new Error("usage: build-claude-plugin.mjs <outDir>");
  buildClaudePlugin(resolve(process.argv[2]));
}
