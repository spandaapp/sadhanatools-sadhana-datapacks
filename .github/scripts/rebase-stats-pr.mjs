#!/usr/bin/env node
// Rebases a stats-only PR onto the current base branch by *replaying its delta* rather
// than replaying its file content.
//
// The app builds a stats PR by reading data.json, adding 1 to one number, and committing
// the whole file back. If another stats PR merges in between, that whole-file replacement
// conflicts — and since nothing re-triggers a stuck PR, it stays open forever with a
// stale count baked into it.
//
// So instead of taking either side of the file, we take the *most updated* counts: work
// out what this PR intended (base -> head deltas, normally a single +/-1), then apply that
// delta on top of whatever the base branch says right now. The workflow then resets the PR
// branch to the base branch head with this content, which leaves nothing to conflict over.
//
// Bails out (rebased=false) on anything that isn't a plain numeric stats change, so
// new-pack PRs and human edits are untouched and still go through the normal path.

import { appendFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const baseRef = process.env.BASE_REF ?? "origin/main";
const outPath = process.env.REBASED_DATA_PATH ?? "rebased-data.json";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function setOutput(name, value) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    appendFileSync(outFile, `${name}=${value}\n`);
  }
}

function readJsonAt(ref, path) {
  try {
    return JSON.parse(sh(`git show ${ref}:${path}`));
  } catch {
    return null;
  }
}

function skip(reason) {
  console.log(`No stats rebase: ${reason}`);
  setOutput("rebased", "false");
  process.exit(0);
}

const mergeBase = sh(`git merge-base ${baseRef} HEAD`);
const baseHead = sh(`git rev-parse ${baseRef}`);
if (mergeBase === baseHead) {
  skip(`branch is already on top of ${baseRef}`);
}

const changedFiles = sh(`git diff --name-only ${mergeBase}...HEAD`)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
if (changedFiles.length !== 1 || changedFiles[0] !== "data.json") {
  skip("PR touches files other than just data.json");
}

const forkData = readJsonAt(mergeBase, "data.json");
const headData = readJsonAt("HEAD", "data.json");
const baseData = readJsonAt(baseRef, "data.json");
if (forkData === null || headData === null || baseData === null) {
  skip("data.json missing on one of merge-base / head / base");
}
if (forkData.schemaVersion !== headData.schemaVersion || forkData.schemaVersion !== baseData.schemaVersion) {
  skip("data.json schemaVersion differs across merge-base / head / base");
}

const forkPacks = forkData.packs ?? {};
const headPacks = headData.packs ?? {};

// Removing a pack from data.json is never something the app does — leave it for a human.
for (const id of Object.keys(forkPacks)) {
  if (!(id in headPacks)) {
    skip(`PR removes data.json entry for ${id}`);
  }
}

// What this PR meant to do, expressed as deltas. An id the PR added counts as a delta from
// zero, which is how the app's "initialise stats for a new pack" write shows up.
const deltas = new Map();
for (const [id, entry] of Object.entries(headPacks)) {
  const keys = Object.keys(entry).sort();
  if (keys.length !== 2 || keys[0] !== "downloads" || keys[1] !== "likes") {
    skip(`data.json entry for ${id} has unexpected shape`);
  }
  if (!Number.isInteger(entry.likes) || !Number.isInteger(entry.downloads)) {
    skip(`data.json entry for ${id} has non-integer likes/downloads`);
  }
  const before = forkPacks[id] ?? { likes: 0, downloads: 0 };
  const likes = entry.likes - before.likes;
  const downloads = entry.downloads - before.downloads;
  if (likes === 0 && downloads === 0) continue;
  if (Math.abs(likes) > 1 || Math.abs(downloads) > 1) {
    skip(`data.json entry for ${id} changed by more than 1 (likes ${likes}, downloads ${downloads})`);
  }
  deltas.set(id, { likes, downloads });
}
if (deltas.size === 0) {
  skip("PR makes no net change to any pack's stats");
}
if (deltas.size > 1) {
  skip(`expected exactly one pack's stats to change, found ${deltas.size}`);
}

// Replay onto the current base branch. Counts only ever move by this PR's own delta, so a
// like landing here can't wipe out a download that landed there.
const rebasedPacks = { ...(baseData.packs ?? {}) };
for (const [id, delta] of deltas) {
  const current = rebasedPacks[id] ?? { likes: 0, downloads: 0 };
  rebasedPacks[id] = {
    likes: Math.max(0, current.likes + delta.likes),
    downloads: Math.max(0, current.downloads + delta.downloads),
  };
  console.log(
    `${id}: likes ${current.likes} -> ${rebasedPacks[id].likes}, ` +
      `downloads ${current.downloads} -> ${rebasedPacks[id].downloads} (delta ${delta.likes}/${delta.downloads})`,
  );
}

// Matches the app's writer (org.json toString(2), no trailing newline) so a rebased file is
// byte-identical to one the app would have produced against an up-to-date base.
const rebased = { schemaVersion: baseData.schemaVersion, packs: rebasedPacks };
writeFileSync(outPath, JSON.stringify(rebased, null, 2), "utf8");

console.log(`Rebased stats onto ${baseRef} (${baseHead.slice(0, 7)})`);
setOutput("rebased", "true");
