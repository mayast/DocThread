Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Write-TestJson([string]$Root, [string]$RelativePath, [object]$Value) {
    $destination = Join-Path $Root $RelativePath
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    [IO.File]::WriteAllText(
        $destination,
        ($Value | ConvertTo-Json -Depth 10 -Compress),
        [Text.UTF8Encoding]::new($false)
    )
}

function Assert-InstalledAnalyzerReadsV2AndV1(
    [string]$RepositoryRoot,
    [string]$AnalyzerRelativePath,
    [string]$Provider
) {
    $updatedAt = '2026-08-24T00:00:00Z'
    $v2Thread = [ordered]@{
        id = 'v2-thread'
        anchor = [ordered]@{ quote = 'review'; prefix = ''; suffix = ''; start = 0 }
        comments = @()
        resolved = $false
        createdAt = $updatedAt
        intent = 'blocking'
    }
    $legacyThread = [ordered]@{
        id = 'legacy-thread'
        anchor = [ordered]@{ quote = 'legacy'; prefix = ''; suffix = ''; start = 0 }
        comments = @()
        resolved = $false
        createdAt = $updatedAt
    }
    Write-TestJson -Root $RepositoryRoot -RelativePath '.docthread/v2/docs/v2.md.json' -Value ([ordered]@{
        schemaVersion = 2
        source = [ordered]@{ provider = $Provider; path = 'docs/v2.md' }
        docPath = 'docs/v2.md'
        updatedAt = $updatedAt
        threads = @($v2Thread)
    })
    Write-TestJson -Root $RepositoryRoot -RelativePath '.docthread/docs__legacy.md.json' -Value ([ordered]@{
        schemaVersion = 1
        docPath = 'docs/legacy.md'
        updatedAt = $updatedAt
        threads = @($legacyThread)
    })

    $analyzerPath = (Resolve-Path (Join-Path $RepositoryRoot $AnalyzerRelativePath)).Path
        $analyzerPathJson = $analyzerPath | ConvertTo-Json -Compress
    $providerJson = $Provider | ConvertTo-Json -Compress
    $probePath = Join-Path $RepositoryRoot 'docthread-analyzer-probe.mjs'
    $probe = @"
import { pathToFileURL } from 'node:url';
const { collectReviewStatus } = await import(pathToFileURL($analyzerPathJson).href);
const status = collectReviewStatus(process.cwd(), ['docs/v2.md', 'docs/legacy.md'], {
  provider: $providerJson,
});
process.stdout.write(JSON.stringify(status));
"@
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))

    Push-Location $RepositoryRoot
    try {
        $probeOutput = & node $probePath 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Installed $Provider analyzer probe failed: $($probeOutput -join [Environment]::NewLine)"
        }
    }
    finally {
        Pop-Location
    }

    $status = ($probeOutput -join [Environment]::NewLine) | ConvertFrom-Json
    Assert-True ($status.documents.Count -eq 2) "$Provider analyzer did not load both review documents."
    Assert-True ($status.open -eq 2) "$Provider analyzer returned the wrong open-thread count."
    Assert-True ($status.blocking -eq 1) "$Provider analyzer returned the wrong blocking count."
    $v2Document = $status.documents | Where-Object docPath -eq 'docs/v2.md'
    $legacyDocument = $status.documents | Where-Object docPath -eq 'docs/legacy.md'
    Assert-True ($v2Document.sidecar -eq '.docthread/v2/docs/v2.md.json') "$Provider analyzer did not select v2."
    Assert-True ($legacyDocument.sidecar -eq '.docthread/docs__legacy.md.json') "$Provider analyzer did not read exact v1 fallback."
}

$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root 'scripts/install-content-repo.ps1'
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("docthread-install-" + [Guid]::NewGuid())

try {
    $githubRepo = Join-Path $temporaryRoot 'github'
    $azureRepo = Join-Path $temporaryRoot 'azure'
    [IO.Directory]::CreateDirectory($githubRepo) | Out-Null
    [IO.Directory]::CreateDirectory($azureRepo) | Out-Null

    & $installer -Provider GitHub -AppUrl 'https://docthread.example' -TargetPath $githubRepo
    & $installer -Provider GitHub -AppUrl 'https://docthread.example' -TargetPath $githubRepo
    Assert-True (Test-Path (Join-Path $githubRepo '.github/scripts/docthread-review.mjs')) 'GitHub analyzer was not installed.'
    Assert-True (Test-Path (Join-Path $githubRepo '.github/workflows/docthread-review.yml')) 'GitHub workflow was not installed.'
    $githubConfig = Get-Content (Join-Path $githubRepo '.docthread.json') -Raw | ConvertFrom-Json
    Assert-True ($githubConfig.provider -eq 'github') 'GitHub provider config is incorrect.'
    Assert-True ($githubConfig.appUrl -eq 'https://docthread.example/') 'App URL was not normalized.'
    Assert-InstalledAnalyzerReadsV2AndV1 `
        -RepositoryRoot $githubRepo `
        -AnalyzerRelativePath '.github/scripts/docthread-review.mjs' `
        -Provider 'github'

    & $installer -Provider AzureRepos -AppUrl 'https://docthread.example/' -TargetPath $azureRepo
    Assert-True (Test-Path (Join-Path $azureRepo '.azuredevops/docthread-review.mjs')) 'Azure analyzer was not installed.'
    Assert-True (Test-Path (Join-Path $azureRepo 'azure-pipelines-docthread.yml')) 'Azure Pipeline was not installed.'
    $pipeline = Get-Content (Join-Path $azureRepo 'azure-pipelines-docthread.yml') -Raw
    Assert-True ($pipeline -match '\.azuredevops/docthread-review\.mjs') 'Azure Pipeline uses the wrong analyzer path.'
    $azureConfig = Get-Content (Join-Path $azureRepo '.docthread.json') -Raw | ConvertFrom-Json
    Assert-True ($azureConfig.provider -eq 'azure-repos') 'Azure Repos provider config is incorrect.'
    Assert-InstalledAnalyzerReadsV2AndV1 `
        -RepositoryRoot $azureRepo `
        -AnalyzerRelativePath '.azuredevops/docthread-review.mjs' `
        -Provider 'azure-repos'

    $sourceAnalyzer = [IO.File]::ReadAllText((Join-Path $root '.github/scripts/docthread-review.mjs'))
    $githubAnalyzer = [IO.File]::ReadAllText((Join-Path $githubRepo '.github/scripts/docthread-review.mjs'))
    $azureAnalyzer = [IO.File]::ReadAllText((Join-Path $azureRepo '.azuredevops/docthread-review.mjs'))
    Assert-True ($githubAnalyzer -ceq $sourceAnalyzer) 'GitHub analyzer copy differs from the source analyzer.'
    Assert-True ($azureAnalyzer -ceq $sourceAnalyzer) 'Azure Repos analyzer copy differs from the source analyzer.'

    Write-Host 'Content repository installer tests passed.'
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}