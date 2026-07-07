# Sadhana datapacks (GitHub)

Public repo layout for `sadhanatools/sadhana-datapacks` on branch `main`.

```
index.json
data.json
packs/{packId}/pack.json
packs/{packId}/audio/*
packs/{packId}/photos/*
```

## Export bundled packs from the app repo

From the tool repo root:

```powershell
.\scripts\export-datapacks-to-github.ps1
```

This copies `app/src/main/assets/bootstrap/*` into `datapacks-repo/packs/` and rewrites `assetPath` fields to repo-relative paths.

Push `datapacks-repo/` contents to the GitHub repo root.

## App token

Add to `local.properties` (not committed):

```
GITHUB_COMMUNITY_TOKEN=ghp_...
```

Fine-grained PAT: **Contents read/write** on `sadhana-datapacks` only.
