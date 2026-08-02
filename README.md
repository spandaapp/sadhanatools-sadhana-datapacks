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

Fine-grained PAT: **Contents: write** + **Pull requests: write** on `sadhanatools-sadhana-datapacks` only — no admin/bypass rights. Rebuild the app after changing `local.properties`.

## Publishing model: everything goes through a PR

The app never pushes to `main` directly (neither creating nor editing a pack) — every
submission opens a branch + pull request via `GITHUB_COMMUNITY_TOKEN`. This holds even
against someone who extracts that token from the APK and calls the GitHub API directly:
`main` should be branch-protected so a direct push is rejected regardless of who (or what)
attempts it.

**New-pack PRs auto-merge**; **edit PRs to existing packs always wait for manual review**.
The distinction isn't trusted from the PR's title or body (either could be spoofed by
whoever holds the token) — `.github/workflows/auto-merge-new-packs.yml` runs
`.github/scripts/check-new-pack-only.mjs` on every PR, which inspects the actual diff: it
only approves auto-merge if every changed path lives under a `packs/<id>/` folder that
didn't exist on `main` before, and `index.json`/`data.json` each gained exactly one new
entry with every pre-existing entry byte-identical. Editing an existing pack necessarily
touches a `packs/<id>/pack.json` that already existed, so it always fails this check and
the PR just sits open for a maintainer to review and merge by hand.

### One-time repo setup

In this repo's GitHub Settings → Branches, add a protection rule for `main`:

1. **Require a pull request before merging** — on, required approvals: 1.
2. **Allow specified actors to bypass required pull requests** — add only the identity
   behind the `AUTOMERGE_TOKEN` secret below (e.g. the GitHub Actions bot). The community
   app token must **not** be on this list — it can only open PRs, never merge them itself.
3. **Restrict who can push to matching branches** — on, with an empty (or maintainer-only)
   allow-list, so no direct push to `main` is possible from anyone or anything.
4. Add a repo secret `AUTOMERGE_TOKEN`: a fine-grained PAT scoped to just this repo with
   `Contents: write` + `Pull requests: write`, created for this workflow specifically —
   don't reuse `GITHUB_COMMUNITY_TOKEN`.
