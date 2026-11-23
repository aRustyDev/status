import worker from '../worker/src/index'
import { apiScope } from './scope'

type WorkerEnv = Parameters<typeof worker.fetch>[1]
type ScopedEnv = WorkerEnv & { API_SCOPE: string }

export default {
  fetch(request: Request, env: ScopedEnv): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path.startsWith('/api/') && apiScope(path) !== env.API_SCOPE) {
      return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
    }
    return worker.fetch(request, env)
  },
}
