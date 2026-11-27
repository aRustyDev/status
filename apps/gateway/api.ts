import worker, { scheduledFallback } from '../worker/src/index'
import { apiScope } from './scope'
import { issue14PreviewEnvironment } from './issue14-preview'

type WorkerEnv = Parameters<typeof worker.fetch>[1]
type ScopedEnv = WorkerEnv & { API_SCOPE: string }

export default {
  async scheduled(_controller: ScheduledController, env: ScopedEnv): Promise<void> {
    if (env.API_SCOPE === 'operations') await scheduledFallback(env)
  },
  fetch(request: Request, env: ScopedEnv): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path.startsWith('/api/') && apiScope(path) !== env.API_SCOPE) {
      return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
    }
    return worker.fetch(request, issue14PreviewEnvironment(env))
  },
}
