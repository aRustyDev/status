export function assertDatabaseIsolation(config) {
  const ids = [config.inventoryDatabaseId, ...['dev','stage','prod'].map(env => config.databases?.[env]?.id)]
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('Inventory, Dev, Stage and Prod must have distinct database identities')
  }
}
