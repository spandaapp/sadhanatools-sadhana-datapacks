#!/usr/bin/env node
// Decides whether a PR is safe to auto-merge. Two independent categories qualify:
//
//   1. A pure "add a new pack": every changed file lives under a packs/<id>/ folder that
//      did not exist on the base branch, and index.json/data.json each gained exactly one
//      new entry, with every pre-existing entry byte-identical.
//   2. A pure "stats-only update" (likes/downloads from the app): the only changed file is
//      data.json, the set of pack ids is unchanged (no packs added or removed), and every
//      entry still has exactly the {likes, downloads} shape — only the numbers may differ.
//
// Anything else (in particular, any edit to an existing pack's content, or a stats change
// bundled with anything else) is left for a human to review and merge by hand.
//
// This inspects the actual git diff, not the PR title/body, so it can't be fooled by a
// misleading PR description.

import { appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const baseRef = process.env.BASE_REF ?? "origin/main";

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

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function packEntries(file) {
  // index.json uses an array of {id, ...}; data.json uses an object keyed by pack id.
  if (file === null) return null;
  return Array.isArray(file.packs)
    ? new Map(file.packs.map((e) => [e.id, e]))
    : new Map(Object.entries(file.packs ?? {}));
}

// Confirms every pre-existing entry is unchanged in headFile, and exactly one new entry
// was added.
function isAdditiveOnly(baseFile, headFile) {
  if (baseFile === null) return true; // nothing to compare against — shouldn't happen in practice
  if (headFile === null) return false; // file was deleted
  const baseById = packEntries(baseFile);
  const headById = packEntries(headFile);
  for (const [id, baseEntry] of baseById) {
    const headEntry = headById.get(id);
    if (headEntry === undefined) return false; // existing entry removed
    if (!deepEqual(baseEntry, headEntry)) return false; // existing entry modified
  }
  return headById.size === baseById.size + 1;
}

const changedFiles = sh(`git diff --name-only ${baseRef}...HEAD`)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

function checkNewPackOnly() {
  const touchedPackIds = new Set();
  for (const path of changedFiles) {
    const match = path.match(/^packs\/([^/]+)\//);
    if (match) {
      touchedPackIds.add(match[1]);
      continue;
    }
    if (path !== "index.json" && path !== "data.json") {
      return { eligible: false, reason: `touches a path outside packs/<id>/, index.json, data.json: ${path}` };
    }
  }
  if (touchedPackIds.size !== 1) {
    return { eligible: false, reason: `expected exactly one pack folder touched, found ${touchedPackIds.size}` };
  }
  const [packId] = touchedPackIds;
  const existedBefore = sh(`git ls-tree -d ${baseRef} -- packs/${packId}`).length > 0;
  if (existedBefore) {
    return { eligible: false, reason: `packs/${packId}/ already existed on ${baseRef} — this is an edit, not a new pack` };
  }
  const baseIndex = readJsonAt(baseRef, "index.json");
  const headIndex = JSON.parse(readFileSync("index.json", "utf8"));
  if (!isAdditiveOnly(baseIndex, headIndex)) {
    return { eligible: false, reason: "index.json changed more than adding one new entry" };
  }
  const baseData = readJsonAt(baseRef, "data.json");
  const headData = JSON.parse(readFileSync("data.json", "utf8"));
  if (!isAdditiveOnly(baseData, headData)) {
    return { eligible: false, reason: "data.json changed more than adding one new entry" };
  }
  return { eligible: true, reason: "pure new-pack addition" };
}

function checkStatsOnly() {
  if (changedFiles.length !== 1 || changedFiles[0] !== "data.json") {
    return { eligible: false, reason: "touches files other than just data.json" };
  }
  const baseData = readJsonAt(baseRef, "data.json");
  const headData = JSON.parse(readFileSync("data.json", "utf8"));
  if (baseData === null || headData === null) {
    return { eligible: false, reason: "data.json missing on one side" };
  }
  if (baseData.schemaVersion !== headData.schemaVersion) {
    return { eligible: false, reason: "data.json schemaVersion changed" };
  }
  const baseIds = Object.keys(baseData.packs ?? {}).sort();
  const headIds = Object.keys(headData.packs ?? {}).sort();
  if (!deepEqual(baseIds, headIds)) {
    return { eligible: false, reason: "data.json pack id set changed — not a pure stats update" };
  }
  for (const id of headIds) {
    const entry = headData.packs[id];
    const keys = Object.keys(entry).sort();
    if (deepEqual(keys, ["downloads", "likes"]) === false) {
      return { eligible: false, reason: `data.json entry for ${id} has unexpected shape` };
    }
    if (typeof entry.likes !== "number" || typeof entry.downloads !== "number") {
      return { eligible: false, reason: `data.json entry for ${id} has non-numeric likes/downloads` };
    }
  }
  return { eligible: true, reason: "pure stats-only update (likes/downloads)" };
}

if (changedFiles.length === 0) {
  console.log("Not eligible for auto-merge: no changed files");
  setOutput("automerge", "false");
  process.exit(0);
}

const newPackResult = checkNewPackOnly();
const statsResult = newPackResult.eligible ? null : checkStatsOnly();
const result = newPackResult.eligible ? newPackResult : statsResult;

if (result.eligible) {
  console.log(`Eligible for auto-merge: ${result.reason}`);
  setOutput("automerge", "true");
} else {
  console.log(`Not eligible for auto-merge: new-pack check (${newPackResult.reason}); stats check (${statsResult.reason})`);
  setOutput("automerge", "false");
}
