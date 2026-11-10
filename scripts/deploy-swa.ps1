[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Subscription,

    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9-]+$')]
    [string]$AppName,

    [string]$ResourceGroup = 'docthread-rg',

    [string]$Location = 'westus2',

    [ValidateSet('Free', 'Standard')]
    [string]$Sku = 'Free',

    [string]$GitHubClientId = '',

    [string]$AzureClientId = '3a9dd418-f26a-4e43-b3bb-30a5c89b251a',

    [string]$AzureTenantId = '72f988bf-86f1-41af-91ab-2d7cd011db47',

    [ValidateSet('Off', 'Msal')]
    [string]$GraphTransport = 'Msal'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root 'infra/main.bicep'
if ($GraphTransport -eq 'Msal') {
    if ([string]::IsNullOrWhiteSpace($AzureClientId)) {
        throw 'GraphTransport Msal requires -AzureClientId.'
    }
    $tenantGuid = [Guid]::Empty
    if (-not [Guid]::TryParse($AzureTenantId, [ref]$tenantGuid)) {
        throw 'GraphTransport Msal requires -AzureTenantId as an explicit tenant GUID.'
    }
}
$existingUploadArchives = [Collections.Generic.HashSet[string]]::new(
    [string[]]@(Get-ChildItem -LiteralPath $root -File | Where-Object {
        $_.Name -match '^[0-9a-f-]+-(app|api)\.zip$'
    } | ForEach-Object FullName),
    [StringComparer]::OrdinalIgnoreCase
)

& az account set --subscription $Subscription
if ($LASTEXITCODE -ne 0) {
    throw "Could not select Azure subscription '$Subscription'. Run az login or verify access, then retry."
}

$selectedSubscription = & az account show --query id --output tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($selectedSubscription)) {
    throw 'Could not verify the selected Azure subscription.'
}

& az deployment sub create `
    --name "docthread-$AppName" `
    --location $Location `
    --template-file $template `
    --parameters `
        "resourceGroupName=$ResourceGroup" `
        "appName=$AppName" `
        "location=$Location" `
        "skuName=$Sku" `
    --output none
if ($LASTEXITCODE -ne 0) { throw 'Could not provision Azure Static Web Apps.' }

$buildAzureClientId = if ($GraphTransport -eq 'Msal') { $AzureClientId } else { '' }
$buildAzureTenantId = if ($GraphTransport -eq 'Msal') { $AzureTenantId } else { '' }
$environment = [ordered]@{
    VITE_BASE = '/'
    VITE_GH_CLIENT_ID = $GitHubClientId
    VITE_OAUTH_PROXY = '/api'
    VITE_AZURE_CLIENT_ID = $buildAzureClientId
    VITE_AZURE_TENANT_ID = $buildAzureTenantId
    VITE_GRAPH_TRANSPORT = $GraphTransport.ToLowerInvariant()
    VITE_ADO_TRANSPORT = 'off'
}
Write-Host "DocThread capabilities: GitHub=$([bool]$GitHubClientId) Graph=$($environment.VITE_GRAPH_TRANSPORT) ADO=off"
$previous = @{}

try {
    foreach ($entry in $environment.GetEnumerator()) {
        $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }

    Push-Location $root
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        & npm test
        if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

        $deploymentToken = & az staticwebapp secrets list `
            --name $AppName `
            --resource-group $ResourceGroup `
            --query properties.apiKey `
            --output tsv
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($deploymentToken)) {
            throw 'Could not acquire the Static Web Apps deployment token.'
        }

        & npx --yes '@azure/static-web-apps-cli@2.0.10' deploy ./dist `
            --api-location ./api `
            --api-language node `
            --api-version 20 `
            --deployment-token $deploymentToken `
            --env production
        if ($LASTEXITCODE -ne 0) { throw 'Static Web Apps deployment failed.' }
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($entry in $previous.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    Get-ChildItem -LiteralPath $root -File | Where-Object {
        $_.Name -match '^[0-9a-f-]+-(app|api)\.zip$' -and
        -not $existingUploadArchives.Contains($_.FullName)
    } | Remove-Item -Force
}

$hostname = & az staticwebapp show `
    --name $AppName `
    --resource-group $ResourceGroup `
    --query defaultHostname `
    --output tsv
if ($LASTEXITCODE -eq 0 -and $hostname) {
    Write-Host "DocThread deployed to https://$hostname/"
}