targetScope = 'resourceGroup'

param appName string
param location string

@allowed([
  'Free'
  'Standard'
])
param skuName string

param tags object

resource app 'Microsoft.Web/staticSites@2024-11-01' = {
  name: appName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuName
  }
  properties: {}
}

output resourceId string = app.id
output defaultHostname string = app.properties.defaultHostname