#!/usr/bin/env node
// Decides whether a PR is safe to auto-merge: it must be a pure "add a new pack"
// change — every changed file lives under a packs/<id>/ folder that did not exist on
// the base branch, and index.json/data.json only gained one new entry each, with every
// pre-existing entry byte-identical. Anything else (in particular, any edit to an
// existing pack) is left for a human to review and merge by hand.
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

function notEligible(reason) {
  console.log(`Not eligible for auto-merge: ${reason}`);
  setOutput("automerge", "false");
  process.exit(0);
}

function eligible() {
  console.log("Eligible for auto-merge: pure new-pack addition.");
  setOutput("automerge", "true");
  process.exit(0);
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

// Confirms every pre-existing entry in `entries.<field>` is unchanged in `headFile`,
// and at most one new entry was added.
function checkAdditiveOnly(baseFile, headFile, idField) {
  if (baseFile === null) {
    return true; // nothing to compare against — treat as safe (shouldn't happen in practice)
  }
  if (headFile === null) {
    return false; // file was deleted
  }
  const baseEntries = Array.isArray(baseFile.packs) ? baseFile.packs : Object.entries(baseFile.packs ?? {});
  const headEntries = Array.isArray(headFile.packs) ? headFile.packs : Object.entries(headFile.packs ?? {});

  const baseById = new Map(
    Array.isArray(baseFile.packs)
      ? baseFile.packs.map((e) => [e[idField], e])
      : Object.entries(baseFile.packs ?? {}),
  );
  const headById = new Map(
    Array.isArray(headFile.packs)
      ? headFile.packs.map((e) => [e[idField], e])
      : Object.entries(headFile.packs ?? {}),
  );

  for (const [id, baseEntry] of baseById) {
    const headEntry = headById.get(id);
    if (headEntry === undefined) return false; // existing entry removed
    if (!deepEqual(baseEntry, headEntry)) return false; // existing entry modified
  }
  return headEntries.length === baseEntries.length + 1;
}

const changedFiles = sh(`git diff --name-only ${baseRef}...HEAD`)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (changedFiles.length === 0) {
  notEligible("no changed files");
}

const touchedPackIds = new Set();
for (const path of changedFiles) {
  const match = path.match(/^packs\/([^/]+)\//);
  if (match) {
    touchedPackIds.add(match[1]);
    continue;
  }
  if (path === "index.json" || path === "data.json") {
    continue;
  }
  notEligible(`touches a path outside packs/<id>/, index.json, data.json: ${path}`);
}

if (touchedPackIds.size !== 1) {
  notEligible(`expected exactly one pack folder touched, found ${touchedPackIds.size}`);
}

const [packId] = touchedPackIds;
const existedBefore = sh(`git ls-tree -d ${baseRef} -- packs/${packId}`).length > 0;
if (existedBefore) {
  notEligible(`packs/${packId}/ already existed on ${baseRef} — this is an edit, not a new pack`);
}

const baseIndex = readJsonAt(baseRef, "index.json");
const headIndex = JSON.parse(readFileSync("index.json", "utf8"));
if (!checkAdditiveOnly(baseIndex, headIndex, "id")) {
  notEligible("index.json changed more than adding one new entry");
}

const baseData = readJsonAt(baseRef, "data.json");
const headData = JSON.parse(readFileSync("data.json", "utf8"));
if (!checkAdditiveOnly(baseData, headData, "__key__")) {
  notEligible("data.json changed more than adding one new entry");
}

eligible();
