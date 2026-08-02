param(
    [string]$Owner = "spandaapp",
    [string]$Repo = "sadhanatools-sadhana-datapacks",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$datapacksDir = $PSScriptRoot

Push-Location $datapacksDir
try {
    if (-not (Test-Path ".git")) {
        git init
        git checkout -b $Branch
    }

    $remoteUrl = "https://github.com/$Owner/$Repo.git"
    $existingRemote = git remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0) {
        git remote add origin $remoteUrl
    } elseif ($existingRemote -ne $remoteUrl) {
        git remote set-url origin $remoteUrl
    }

    git add -A
    $status = git status --porcelain
    if ($status) {
        git commit -m "Publish datapack catalog"
    }

    Write-Host "Pushing to $Owner/$Repo ($Branch)..."
    git push -u origin $Branch
    Write-Host "Done. App should use:"
    Write-Host "  GITHUB_DATAPACKS_OWNER=$Owner"
    Write-Host "  GITHUB_DATAPACKS_REPO=$Repo"
}
finally {
    Pop-Location
}
