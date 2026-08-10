#!/usr/bin/env node
// Decides whether a PR is safe to auto-merge. Two independent categories qualify:
//
//   1. A pure "add a new pack": every changed file lives under a packs/<id>/ folder that
//      did not exist on the base branch, and index.json/data.json each gained exactly one
//      new entry, with every pre-existing entry unchanged (compared as canonicalised JSON,
//      not bytes — see canonicalEntry).
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

// Fields an entry may legitimately omit, with the value the readers assume when it's absent.
// Kept in sync with DataPackRemoteJsonParser.parseIndex's optString/optInt/optBoolean defaults.
const ENTRY_DEFAULTS = {
  description: "",
  version: 1,
  approved: false,
  likes: 0,
  downloads: 0,
};

// The app doesn't append to index.json — it re-serialises the whole file from its own model,
// so every entry comes back carrying every field the *current* app schema knows about, even
// ones the on-disk entry predates (`approved` is the first of these). Back-filling a field
// with its default is not a content edit, so drop defaults before comparing; a real change
// (approved: true, a bumped version) survives canonicalisation and is still caught. Key order
// isn't meaningful in JSON either, and org.json's ordering need not match the file's, so sort.
function canonicalEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const canonical = {};
  for (const key of Object.keys(entry).sort()) {
    if (key in ENTRY_DEFAULTS && deepEqual(entry[key], ENTRY_DEFAULTS[key])) continue;
    canonical[key] = entry[key];
  }
  return canonical;
}

function packEntries(file) {
  // index.json uses an array of {id, ...}; data.json uses an object keyed by pack id.
  if (file === null) return null;
  return Array.isArray(file.packs)
    ? new Map(file.packs.map((e) => [e.id, e]))
    : new Map(Object.entries(file.packs ?? {}));
}

// Fields a submission may never assert about itself. `approved` is the human curation gate;
// likes/downloads are counts the repo accumulates, not an opening balance a submitter picks.
const SUBMISSION_CANNOT_CLAIM = ["approved", "likes", "downloads"];

// isAdditiveOnly deliberately says nothing about the *contents* of the entry that was added —
// it only proves pre-existing entries are untouched and that exactly one entry appeared. That
// leaves a hole: a submission declaring its own pack `"approved": true` is a perfectly legal
// additive change, so it auto-merges, and open-approval-prs.mjs then skips it because it only
// ever looks at packs whose flag is not already true. The pack lands visible-by-default with
// no human ever seeing it — the exact outcome the approval PR exists to prevent.
//
// Absent or default-valued is fine (the app re-serialises every field it knows about, so a new
// entry legitimately arrives carrying `"approved": false`); any other value is a claim.
function privilegeClaim(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  for (const field of SUBMISSION_CANNOT_CLAIM) {
    if (field in entry && !deepEqual(entry[field], ENTRY_DEFAULTS[field])) {
      return `${field}=${JSON.stringify(entry[field])}`;
    }
  }
  return null;
}

// The one id present in headFile but not baseFile. Only meaningful once isAdditiveOnly has
// confirmed there is exactly one.
function addedEntry(baseFile, headFile) {
  if (baseFile === null || headFile === null) return null;
  const baseById = packEntries(baseFile);
  for (const [id, entry] of packEntries(headFile)) {
    if (!baseById.has(id)) return { id, entry };
  }
  return null;
}

// Confirms every pre-existing entry is unchanged in headFile, and exactly one new entry
// was added. Says nothing about that new entry's contents — see privilegeClaim.
function isAdditiveOnly(baseFile, headFile) {
  if (baseFile === null) return true; // nothing to compare against — shouldn't happen in practice
  if (headFile === null) return false; // file was deleted
  const baseById = packEntries(baseFile);
  const headById = packEntries(headFile);
  for (const [id, baseEntry] of baseById) {
    const headEntry = headById.get(id);
    if (headEntry === undefined) return false; // existing entry removed
    if (!deepEqual(canonicalEntry(baseEntry), canonicalEntry(headEntry))) return false; // existing entry modified
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
  for (const [file, added] of [
    ["index.json", addedEntry(baseIndex, headIndex)],
    ["data.json", addedEntry(baseData, headData)],
  ]) {
    const claim = added && privilegeClaim(added.entry);
    if (claim) {
      return {
        eligible: false,
        reason: `new ${file} entry for ${added.id} sets ${claim} — a submission can't grant itself that`,
      };
    }
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

  // A single like/unlike or download tap in the app changes exactly one pack's entry, by
  // exactly 1 in one field. Require that shape here too, not just "same id set" — otherwise
  // a PR disguised as a small stats bump could tamper with any *other* pack's numbers in the
  // same commit and still pass.
  let changedCount = 0;
  for (const id of headIds) {
    const entry = headData.packs[id];
    const baseEntry = baseData.packs[id];
    const keys = Object.keys(entry).sort();
    if (!deepEqual(keys, ["downloads", "likes"])) {
      return { eligible: false, reason: `data.json entry for ${id} has unexpected shape` };
    }
    if (
      !Number.isInteger(entry.likes) || !Number.isInteger(entry.downloads) ||
      entry.likes < 0 || entry.downloads < 0
    ) {
      return { eligible: false, reason: `data.json entry for ${id} has non-integer or negative likes/downloads` };
    }
    if (!deepEqual(entry, baseEntry)) {
      changedCount++;
      const likesDelta = Math.abs(entry.likes - baseEntry.likes);
      const downloadsDelta = Math.abs(entry.downloads - baseEntry.downloads);
      if (likesDelta > 1 || downloadsDelta > 1) {
        return {
          eligible: false,
          reason: `data.json entry for ${id} changed by more than 1 ` +
            `(likes ${baseEntry.likes}->${entry.likes}, downloads ${baseEntry.downloads}->${entry.downloads})`,
        };
      }
    }
  }
  if (changedCount !== 1) {
    return { eligible: false, reason: `expected exactly one pack's stats to change, found ${changedCount}` };
  }
  return { eligible: true, reason: "pure stats-only update (single pack, delta of 1)" };
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
