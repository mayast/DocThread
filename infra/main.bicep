targetScope = 'subscription'

@description('Resource group that contains the standalone DocThread deployment.')
@minLength(1)
param resourceGroupName string

@description('Globally unique Azure Static Web App name.')
@minLength(1)
param appName string

@description('Azure region that hosts the Static Web App resource metadata.')
param location string = 'westus2'

@description('Free for pilots; Standard when an SLA or advanced network/auth controls are required.')
@allowed([
  'Free'
  'Standard'
])
param skuName string = 'Free'

@description('Optional resource tags.')
param tags object = {}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module app './static-web-app.bicep' = {
  name: 'docthread-static-web-app'
  scope: resourceGroup
  params: {
    appName: appName
    location: location
    skuName: skuName
    tags: tags
  }
}

output resourceGroupId string = resourceGroup.id
output resourceId string = app.outputs.resourceId
output defaultHostname string = app.outputs.defaultHostname