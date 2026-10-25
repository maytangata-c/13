#!/usr/bin/env node
// Publishes a folder as a one-commit branch through the GitHub API, so GitHub signs the commit
// (the org requires signed commits; a runner's own git commit is not). Needs GH_TOKEN, REPO.
// Usage: node scripts/push-claude-plugin.mjs <dir> <branch> <message>

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

async function call(method, path, body, tolerate = []) {
  const res = await fetch(`${API}/repos/${process.env.REPO}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok && !tolerate.includes(res.status)) {
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return { status: res.status, json: await res.json() };
}

/** @param {string} dir @param {string} branch @param {string} message */
export async function pushFolder(dir, branch, message) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
  // Text goes inline in the tree request; blobs, which GitHub rate-limits, are only for binaries.
  const blobs = new Map();
  const tree = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    const entry = {
      path: relative(dir, file),
      mode: statSync(file).mode & 0o111 ? "100755" : "100644",
      type: "blob",
    };
    const text = new TextDecoder("utf-8", { fatal: true });
    try {
      if (bytes.includes(0)) throw new Error("binary");
      tree.push({ ...entry, content: text.decode(bytes) });
    } catch {
      const key = createHash("sha1").update(bytes).digest("hex");
      if (!blobs.has(key)) {
        const { json } = await call("POST", "git/blobs", {
          content: bytes.toString("base64"),
          encoding: "base64",
        });
        blobs.set(key, json.sha);
      }
      tree.push({ ...entry, sha: blobs.get(key) });
    }
  }
  const { json: made } = await call("POST", "git/trees", { tree });
  const { json: commit } = await call("POST", "git/commits", {
    message,
    tree: made.sha,
    parents: [],
  });
  const ref = `heads/${branch}`;
  const updated = await call(
    "PATCH",
    `git/refs/${ref}`,
    { sha: commit.sha, force: true },
    [404, 422],
  );
  if (updated.status === 404 || updated.status === 422) {
    await call("POST", "git/refs", { ref: `refs/${ref}`, sha: commit.sha });
  }
  return commit.sha;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, branch, message] = process.argv.slice(2);
  if (!message) throw new Error("usage: push-claude-plugin.mjs <dir> <branch> <message>");
  console.log(await pushFolder(resolve(dir), branch, message));
}
