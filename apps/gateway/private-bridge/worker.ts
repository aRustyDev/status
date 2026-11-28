import { WorkerEntrypoint } from 'cloudflare:workers'
import type { GatewayMiddlewareContext, GatewayMiddlewareNext } from '@cloudflare/zt-types'
import { handleForward, type ForwardEnv } from './core'

export class GatewayMiddleware extends WorkerEntrypoint<ForwardEnv> {
  async handle(request: Request, context: GatewayMiddlewareContext, next: GatewayMiddlewareNext): Promise<Response> { return handleForward(request, context, next, this.env) }
}
