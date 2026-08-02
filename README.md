# Spanda datapacks (GitHub)

Public repo layout for community datapacks on branch `main`.

```
index.json
data.json
packs/{packId}/pack.json
packs/{packId}/audio/*
packs/{packId}/photos/*
```

## Export / edit packs

Datapacks are maintained in `datapacks-repo/packs/` (not bundled in the APK). Edit files there, then push:

```powershell
.\scripts\push-datapacks-repo.ps1 -Owner spandaapp -Repo sadhanatools-sadhana-datapacks
```

Legacy export from APK assets is no longer used.

Create a public repo (e.g. `spandaapp/sadhanatools-sadhana-datapacks`), then from the tool repo root:

```powershell
.\scripts\push-datapacks-repo.ps1 -Owner spandaapp -Repo sadhanatools-sadhana-datapacks
```

## App config

Add to `local.properties` (not committed):

```
GITHUB_COMMUNITY_TOKEN=ghp_...
GITHUB_DATAPACKS_OWNER=spandaapp
GITHUB_DATAPACKS_REPO=sadhanatools-sadhana-datapacks
```

Fine-grained PAT scoped to `sadhanatools-sadhana-datapacks` only — no admin/bypass rights:

- **Contents: write** — needed to create the branch and the commit(s) that back a PR.
  There's no way around this: opening a PR with new file content is, mechanically, "push a
  branch with commits" + "open a PR against it," and GitHub gates the first half under
  `Contents`, not `Pull requests`. A token without `Contents` can't create anything to open
  a PR *from* — it's not possible to reduce this token to "Pull requests only" and still
  have it be able to submit a pack.
- **Pull requests: write** — needed to open the PR itself.

What this token can **never** do, regardless of those two scopes, is land anything on
`main` directly — that's enforced by branch protection (below), not by what's omitted from
the token. Rebuild the app after changing `local.properties`.

## Publishing model: everything goes through a PR

The app never pushes to `main` directly (neither creating nor editing a pack) — every
submission opens a branch + pull request via `GITHUB_COMMUNITY_TOKEN`. This holds even
against someone who extracts that token from the APK and calls the GitHub API directly:
`main` is branch-protected so a direct push is rejected regardless of who (or what)
attempts it — confirmed live (see below).

**New-pack PRs and pure like/download stats PRs auto-merge; edit PRs to existing pack
content always wait for manual review.** The distinction isn't trusted from the PR's title
or body (either could be spoofed by whoever holds the token) —
`.github/workflows/auto-merge-new-packs.yml` runs
`.github/scripts/check-automerge-eligible.mjs` on every PR, which inspects the actual diff
against two independent, narrow categories:

1. **New pack**: every changed path lives under a `packs/<id>/` folder that didn't exist on
   `main` before, and `index.json`/`data.json` each gained exactly one new entry with every
   pre-existing entry byte-identical.
2. **Stats-only**: the *only* changed file is `data.json`, the set of pack ids is unchanged
   (no pack added or removed — this also blocks sneaking a phantom new pack id into
   `data.json` without a real `packs/<id>/` folder to back it), and every entry still has
   exactly the `{likes, downloads}` shape with numeric values.

Editing an existing pack's content necessarily touches a `packs/<id>/pack.json` that
already existed, which fails both categories, so it always falls through and the PR just
sits open for a maintainer to review and merge by hand. `DataPackStatsRepository` (like
taps, download counts) also goes through this same branch + PR flow now — see the
`stats-only` category above.

### One-time repo setup

In this repo's GitHub Settings → Branches, add a protection rule for `main`:

1. **Require a pull request before merging** — on, required approvals: 1.
2. **Do not allow bypassing the above settings** — leave **unchecked**. (Classic branch
   protection has no "allow specific actors to bypass" list — the only bypass mechanism is
   this checkbox, which, when unchecked, lets anyone with **Admin** role on the repo merge
   past the review requirement.) This is why the workflow merges with `gh pr merge --admin`
   instead of trying to get a review approval: the PR is opened by the community-token
   identity, and GitHub never lets a PR's author approve their own PR, so the
   review-approval route is a dead end here regardless of any bypass list.
3. **Restrict who can push to matching branches** — on, with an empty (or maintainer-only)
   allow-list, so no direct push to `main` is possible from anyone or anything.
4. Add a repo secret `AUTOMERGE_TOKEN`: a fine-grained PAT, created for this workflow
   specifically (don't reuse `GITHUB_COMMUNITY_TOKEN`), whose **account** has Admin role on
   this repo. Grant it **Contents: write** (to write the actual merge commit onto `main`)
   + **Pull requests: write** (to call merge at all). If `--admin` merges still get
   rejected after the above, the account's Admin role or the "do not allow bypassing"
   checkbox is the thing to re-check first — not the token's own scopes; fine-grained PATs
   can only ever be a subset of what the underlying account can already do, so no scope
   grants bypass power an account doesn't already have.

This makes `AUTOMERGE_TOKEN` an admin-level credential for this repo. That's a meaningfully
bigger blast radius than the community token if it ever leaked — but unlike the community
token, it never ships in the APK; it only exists as a GitHub Actions secret, server-side.
Keep it that way (never put it in `local.properties`, never log it in workflow output).
