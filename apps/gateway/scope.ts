export function apiScope(path: string): 'status' | 'monitoring' | 'operations' {
  const route = path.replace(/^\/api\/v1\/bsp\//, '/api/v1/')
  if (route.startsWith('/api/v1/public/')) return 'status'
  if (/^\/api\/v1\/admin\/(checks|endpoints)(\/|$)/.test(route) ||
      route === '/api/v1/admin/monitors/test' ||
      /^\/api\/v1\/admin\/monitors\/[^/]+\/history$/.test(route)) return 'monitoring'
  return 'operations'
}
