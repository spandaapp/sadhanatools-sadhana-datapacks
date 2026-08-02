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
.\datapacks-repo\push-datapacks-repo.ps1 -Owner spandaapp -Repo sadhanatools-sadhana-datapacks
```

Legacy export from APK assets is no longer used.

Create a public repo (e.g. `spandaapp/sadhanatools-sadhana-datapacks`), then from the tool repo root:

```powershell
.\datapacks-repo\push-datapacks-repo.ps1 -Owner spandaapp -Repo sadhanatools-sadhana-datapacks
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

This repo uses a **Ruleset** (Settings → Rules → Rulesets), not classic branch protection.
Rulesets have their own bypass model — a `bypass_actors` list on the ruleset itself — which
works differently from classic protection's "administrators can override" checkbox. That
distinction matters for the choice below.

**Why the bypass actor is a GitHub App, not a role or a second PAT:** the obvious-looking
option is "add a `Repository admin` role to the bypass list" and give the automerge token's
account Admin. That's unsafe here specifically because `GITHUB_COMMUNITY_TOKEN` is minted
from the repo owner's own account, which already *has* Admin — a role-based bypass would
therefore also let the community token bypass required review, silently defeating the
entire separation, unless the community token were moved to a second, deliberately
low-privilege account. A GitHub App's identity is independent of any personal account's
role, so it can be the sole bypass actor without that risk, and without needing a second
account at all.

1. **Require a pull request before merging** — on, required approvals: 1.
2. **Restrict who can push to matching branches** — on, empty (or maintainer-only)
   allow-list, so no direct push to `main` is possible from anyone or anything. (Confirmed
   live: direct push and force-push with the community token both get rejected with
   `Repository rule violations found`.)
3. Create a GitHub App for automerge (Settings → Developer settings → GitHub Apps → New
   GitHub App): repository permissions **Contents: Read and write** + **Pull requests: Read
   and write**, nothing else; no webhook; installable only on your own account. Install it
   on this repo only, and generate a private key for it.
4. Add two repo secrets (Settings → Secrets and variables → Actions):
   - `AUTOMERGE_APP_ID` — the App's numeric ID (not sensitive).
   - `AUTOMERGE_APP_PRIVATE_KEY` — the full contents of the generated private key file.
5. In the ruleset's bypass list, add the App as a bypass actor with mode **"Pull requests
   only"** (not "Always" — that would also let it push directly, which it should never do).
   Remove any other bypass actors that aren't intentional (a stray `DeployKey` bypass with
   mode "Always" has shown up here before from unrelated troubleshooting — if present,
   remove it; it would let *any* deploy key ever added to the repo push straight to `main`
   for anything, whether or not it's related to this workflow).

The workflow (`.github/workflows/auto-merge-new-packs.yml`) mints a short-lived
installation token from the App on every run via `actions/create-github-app-token`, rather
than reading a long-lived PAT from secrets — the App's credentials (ID + private key) never
leave GitHub Actions, and the merge step never touches `GITHUB_COMMUNITY_TOKEN` at all.

**The merge step still needs `gh pr merge --admin`.** Being in `bypass_actors` only makes an
actor *eligible* to bypass — `--admin` is the client-side signal that actually invokes that
eligibility on a given merge call. Confirmed live: even with the App correctly configured as
the sole bypass actor (matching `AUTOMERGE_APP_ID`, installed on the repo), a plain
`gh pr merge --merge` (no `--admin`) still gets rejected with "the base branch policy
prohibits the merge" — same message GitHub prints for a merge attempt that isn't eligible to
bypass at all. `--admin` isn't specific to classic branch protection's admin-role override as
we first assumed; it's required to use bypass rights however they were granted, Rulesets
included.
