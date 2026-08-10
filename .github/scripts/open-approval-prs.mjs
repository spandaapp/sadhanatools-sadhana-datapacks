#!/usr/bin/env node
// Opens one "approve this pack" PR per unapproved pack in index.json, for a human to merge.
//
// A pack lands in the catalog via auto-merge with `"approved": false`, which keeps it behind
// the app's "Approved only" filter on the Load Data screen. Flipping that flag to true is the
// curation decision, and it is deliberately left to a person — this sweep only *prepares* the
// change so approving costs a review click and a merge click instead of a hand-edit.
//
// The PR it opens is intentionally not auto-merge-eligible: it modifies an existing index.json
// entry, which check-automerge-eligible.mjs rejects by design. Nothing here bypasses that.
//
// Closing an approval PR without merging it means "rejected" — this sweep never re-opens one
// for the same pack. That signal is only unambiguous if the sweep itself never closes and
// recreates a PR, so a PR that goes stale is force-pushed in place rather than replaced.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const repo = process.env.REPO;
const baseBranch = process.env.BASE_BRANCH ?? "main";
const dryRun = process.env.DRY_RUN === "true";

const INDEX_PATH = "index.json";
const BRANCH_PREFIX = "approve-";
const BOT_NAME = "spanda-automerge[bot]";
const BOT_EMAIL = "spanda-automerge[bot]@users.noreply.github.com";

if (!repo) throw new Error("REPO is required");

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function gh(args) {
  return sh(`gh ${args} --repo ${repo}`);
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

// Locates each pack entry by position rather than by searching for its id. A pack's
// displayName and description are attacker-supplied — they come from whatever a submitter
// typed into the app — so a description containing `"id": "other-pack"` or a stray brace would
// mislead any text search. Scanning string-aware for the objects one level inside the root
// (the entries in `packs`, and nothing else in this schema) can't be spoofed by string content.
function packEntrySpans(text) {
  const spans = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      depth++;
      if (depth === 2) start = i;
    } else if (char === "}") {
      if (depth === 2) spans.push([start, i + 1]);
      depth--;
    }
  }
  if (depth !== 0) throw new Error("unbalanced braces in index.json");
  return spans;
}

// Rewrites exactly the one `approved` flag as text, leaving the rest of the file — key order,
// indentation, slash escaping, trailing-newline state — byte-identical. Re-serialising the
// whole document instead would churn every line and collide with any new-pack PR in flight,
// which is the failure mode that stalled PR #49; see README.
function flipApproved(text, packId) {
  const packs = JSON.parse(text).packs ?? [];
  const position = packs.findIndex((pack) => pack.id === packId);
  if (position === -1) throw new Error(`index.json has no entry with id ${packId}`);
  const spans = packEntrySpans(text);
  if (spans.length !== packs.length) {
    throw new Error(
      `index.json layout not understood: ${spans.length} nested objects for ${packs.length} packs`,
    );
  }
  const [start, end] = spans[position];
  const entry = text.slice(start, end);

  const approvedFlag = /("approved"\s*:\s*)false/;
  let updatedEntry;
  if (approvedFlag.test(entry)) {
    updatedEntry = entry.replace(approvedFlag, "$1true");
  } else {
    // Entry predates the field. Append it as the last property, indented like its siblings.
    const closeIndex = entry.lastIndexOf("}");
    const body = entry.slice(0, closeIndex);
    const beforeClose = /\s*$/.exec(body)[0];
    const properties = body.slice(0, body.length - beforeClose.length);
    const indents = [...properties.matchAll(/\n([ \t]*)"[^"]*"\s*:/g)];
    const indent = indents.length > 0 ? indents[indents.length - 1][1] : "  ";
    updatedEntry = `${properties},\n${indent}"approved": true${beforeClose}}`;
  }

  const updated = text.slice(0, start) + updatedEntry + text.slice(end);
  assertOnlyApprovalChanged(text, updated, packId);
  return updated;
}

// Text surgery that silently mangled a neighbouring entry would produce exactly the kind of
// diff this whole pipeline exists to prevent, so prove the parsed documents differ in nothing
// but this pack's flag before handing the result to git.
function assertOnlyApprovalChanged(beforeText, afterText, packId) {
  const blank = (doc) =>
    JSON.stringify({
      ...doc,
      packs: doc.packs.map((pack) =>
        pack.id === packId ? { ...pack, approved: "<ignored>" } : pack,
      ),
    });
  const after = JSON.parse(afterText);
  if (blank(JSON.parse(beforeText)) !== blank(after)) {
    throw new Error(`approval edit for ${packId} changed something other than its approved flag`);
  }
  if (after.packs.find((pack) => pack.id === packId)?.approved !== true) {
    throw new Error(`approval edit for ${packId} did not set approved to true`);
  }
}

// Builds the branch content from scratch against current main every time, so a force-push of a
// stale PR and a first push of a new one are the same operation.
function buildBranch(packId) {
  sh(`git checkout -B approval-build origin/${baseBranch}`);
  const text = readFileSync(INDEX_PATH, "utf8");
  writeFileSync(INDEX_PATH, flipApproved(text, packId));
  if (sh(`git status --porcelain -- ${INDEX_PATH}`) === "") return false;
  sh(`git config user.name "${BOT_NAME}"`);
  sh(`git config user.email "${BOT_EMAIL}"`);
  sh(`git commit -m "Approve datapack ${packId}" -- ${INDEX_PATH}`);
  return true;
}

function pushBranch(branch, { force }) {
  if (dryRun) {
    console.log(`  [dry run] would push ${force ? "--force " : ""}to ${branch}`);
    return;
  }
  sh(`git push ${force ? "--force " : ""}origin approval-build:refs/heads/${branch}`);
}

function prBody(packId) {
  return [
    `\`${packId}\` is in the catalog but not approved, so the app hides it behind the`,
    `"Approved only" filter on the Load Data screen.`,
    ``,
    `Merging this sets \`"approved": true\` on its \`index.json\` entry and makes it visible by`,
    `default. **Merging is the approval** — review the pack's contents in the PR that added it`,
    `first. The one-line diff below is generated, not hand-written, and is checked against the`,
    `parsed document before it is committed.`,
    ``,
    `If the pack should not be approved, close this PR without merging: that is recorded as a`,
    `rejection and no further approval PR will be opened for \`${packId}\`. Removing the pack`,
    `from the catalog entirely is a separate PR.`,
    ``,
    `Opened by \`.github/workflows/open-approval-prs.yml\`.`,
  ].join("\n");
}

const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
const packs = index.packs ?? [];
const unapproved = new Set(
  packs.filter((pack) => pack.approved !== true).map((pack) => pack.id),
);
const knownIds = new Set(packs.map((pack) => pack.id));

const approvalPrs = ghJson(
  `pr list --state all --limit 200 --json number,headRefName,state,url,createdAt`,
)
  .filter((pr) => pr.headRefName.startsWith(BRANCH_PREFIX))
  .map((pr) => ({
    ...pr,
    packId: pr.headRefName.slice(BRANCH_PREFIX.length).replace(/-\d+$/, ""),
  }));

sh(`git fetch origin ${baseBranch}`);

// When did this pack's *current* incarnation land on the base branch? Newest add wins:
// `git log -1 --diff-filter=A` walks newest-first, so for a pack that was removed from the
// catalog and later re-submitted this is the re-add, not the original.
//
// Deliberately pack.json and not the packs/<id>/ folder: every "Edit datapack" that ships a
// new audio file or photo is an *addition* under that folder, so a folder-level query dates
// the pack to its last content addition rather than to its creation. Measured against real
// history that made isha-default (created 2026-07-15, given more audio 2026-08-09) look newer
// than its own approval PR — which would have re-raised approval PRs for packs that had
// already been decided, i.e. the nagging this script is built to avoid. pack.json is written
// once per incarnation and only ever modified afterwards.
function packAddedAt(packId) {
  const added = sh(
    `git log -1 --diff-filter=A --format=%cI origin/${baseBranch} -- packs/${packId}/pack.json`,
  );
  return added === "" ? null : Date.parse(added);
}

// An approval decision is about the pack that was in front of the maintainer at the time, not
// about the id forever. Deleting a pack and re-submitting it produces a genuinely new pack that
// happens to reuse an id, and the old decision says nothing about it — but "already has an
// approval PR" is keyed on id alone, so the stale record silently suppressed the new PR. That
// is exactly what happened after the catalog was emptied: `test` (approved back then) and
// `test2` (rejected back then) were re-added and never got approval PRs, because PRs #68 and
// #58 still matched by id.
//
// A decision only binds if it was made after the incarnation it is about appeared. If we can't
// date the pack, keep the old conservative behaviour and treat the decision as binding.
function decisionIsStale(pr) {
  const addedAt = packAddedAt(pr.packId);
  if (addedAt === null) return false;
  return addedAt > Date.parse(pr.createdAt);
}

// Pass 1: keep the open ones usable. A new pack merging rewrites every line of index.json,
// which can leave an older approval PR conflicting against a base it no longer shares a useful
// merge base with — re-parenting the branch onto current main is the only thing that clears
// that, and it has to happen in place to preserve "closed means rejected".
for (const pr of approvalPrs.filter((candidate) => candidate.state === "OPEN")) {
  if (!knownIds.has(pr.packId) || !unapproved.has(pr.packId)) {
    console.log(`Closing #${pr.number}: ${pr.packId} no longer needs approval`);
    if (!dryRun) gh(`pr close ${pr.number} --delete-branch`);
    continue;
  }
  const { mergeable } = ghJson(`pr view ${pr.number} --json mergeable`);
  if (mergeable !== "CONFLICTING") {
    console.log(`Leaving #${pr.number} alone (${pr.packId}, mergeable=${mergeable})`);
    continue;
  }
  console.log(`Rebuilding #${pr.number} onto ${baseBranch}: ${pr.packId} conflicts`);
  if (buildBranch(pr.packId)) {
    pushBranch(pr.headRefName, { force: true });
  } else {
    console.log(`  ${pr.packId} is already approved on ${baseBranch} — nothing to push`);
  }
}

// Pass 2: open what's missing. "Any state" is the guard, not "open": a closed-unmerged approval
// PR is a rejection, and re-opening one would nag the maintainer forever.
const decided = new Set(approvalPrs.map((pr) => pr.packId));
for (const packId of unapproved) {
  // Explicitly the newest decision, not `find`'s first match: once a stale decision has been
  // superseded by a freshly opened PR, the pack has two, and picking the older one again would
  // reopen a duplicate on every run. Don't rely on `gh pr list` ordering for that.
  const existing = [...approvalPrs]
    .filter((pr) => pr.packId === packId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (existing && decisionIsStale(existing)) {
    console.log(
      `Re-opening approval for ${packId}: #${existing.number} (${existing.state}) decided ` +
        `${existing.createdAt}, but the pack was re-added to the catalog after that`,
    );
  } else if (existing) {
    console.log(`Skipping ${packId}: already has an approval PR (#${existing.number}, ${existing.state})`);
    continue;
  }
  const branch = `${BRANCH_PREFIX}${packId}-${Date.now()}`;
  console.log(`Opening approval PR for ${packId} on ${branch}`);
  if (!buildBranch(packId)) {
    console.log(`  ${packId} is already approved on ${baseBranch} — skipping`);
    continue;
  }
  pushBranch(branch, { force: false });
  if (dryRun) {
    console.log(`  [dry run] would open PR for ${packId}`);
    continue;
  }
  const url = gh(
    `pr create --base ${baseBranch} --head ${branch} ` +
      `--title ${JSON.stringify(`Approve datapack: ${packId}`)} ` +
      `--body ${JSON.stringify(prBody(packId))}`,
  );
  console.log(`  ${url}`);
}

if (unapproved.size === 0) {
  console.log("No unapproved packs in index.json");
}
if (decided.size > 0) {
  console.log(`Packs with an existing approval decision: ${[...decided].join(", ")}`);
}
