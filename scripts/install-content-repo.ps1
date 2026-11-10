[CmdletBinding()]
param(
    [ValidateSet('Auto', 'GitHub', 'AzureRepos')]
    [string]$Provider = 'Auto',

    [Parameter(Mandatory)]
    [ValidatePattern('^https://')]
    [string]$AppUrl,

    [string]$TargetPath = (Get-Location).Path,

    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = [IO.Path]::GetFullPath($TargetPath)
if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
    throw "Target repository directory does not exist: $targetRoot"
}

if ($Provider -eq 'Auto') {
    $remote = & git -C $targetRoot remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0) { $remote = '' }
    if ($remote -match '(?i)(dev\.azure\.com|\.visualstudio\.com)') {
        $Provider = 'AzureRepos'
    }
    elseif ($remote -match '(?i)github\.com') {
        $Provider = 'GitHub'
    }
    else {
        throw 'Could not infer the Git provider from origin. Pass -Provider GitHub or -Provider AzureRepos.'
    }
}

function Write-Artifact {
    param(
        [Parameter(Mandatory)][string]$RelativePath,
        [Parameter(Mandatory)][string]$Content
    )

    $destination = Join-Path $targetRoot $RelativePath
    $parent = Split-Path -Parent $destination
    [IO.Directory]::CreateDirectory($parent) | Out-Null

    if (Test-Path -LiteralPath $destination) {
        $existing = [IO.File]::ReadAllText($destination)
        if ($existing -eq $Content) {
            Write-Host "Unchanged $RelativePath"
            return
        }
        if (-not $Force) {
            throw "$RelativePath already exists with different content. Re-run with -Force to replace it."
        }
    }

    [IO.File]::WriteAllText(
        $destination,
        $Content,
        [Text.UTF8Encoding]::new($false)
    )
    Write-Host "Installed $RelativePath"
}

$normalizedAppUrl = $AppUrl.TrimEnd('/') + '/'
$providerId = if ($Provider -eq 'GitHub') { 'github' } else { 'azure-repos' }
$config = [ordered]@{
    schemaVersion = 1
    provider = $providerId
    appUrl = $normalizedAppUrl
} | ConvertTo-Json
Write-Artifact -RelativePath '.docthread.json' -Content ($config + [Environment]::NewLine)

$analyzer = [IO.File]::ReadAllText(
    (Join-Path $sourceRoot '.github/scripts/docthread-review.mjs')
)

if ($Provider -eq 'GitHub') {
    Write-Artifact -RelativePath '.github/scripts/docthread-review.mjs' -Content $analyzer
    $workflow = [IO.File]::ReadAllText(
        (Join-Path $sourceRoot '.github/workflows/docthread-review.yml')
    )
    Write-Artifact -RelativePath '.github/workflows/docthread-review.yml' -Content $workflow
}
else {
    Write-Artifact -RelativePath '.azuredevops/docthread-review.mjs' -Content $analyzer
    $pipeline = [IO.File]::ReadAllText(
        (Join-Path $sourceRoot 'templates/azure-repos/azure-pipelines-docthread.yml')
    )
    Write-Artifact -RelativePath 'azure-pipelines-docthread.yml' -Content $pipeline
}

Write-Host "DocThread content integration installed for $Provider."
Write-Host "App: $normalizedAppUrl"