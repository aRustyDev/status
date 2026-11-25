import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { backupService, beginExport, finishExport, type BackupEnv } from './core'

export class D1BackupWorkflow extends WorkflowEntrypoint<BackupEnv, { id: string }> {
  async run(event: Readonly<WorkflowEvent<{ id: string }>>, step: WorkflowStep): Promise<void> {
    const bookmark = await step.do('Start D1 export', { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' }, () => beginExport(this.env))
    await step.do('Store and verify D1 export', { retries: { limit: 20, delay: '15 seconds', backoff: 'constant' }, timeout: '10 minutes' }, () => finishExport(this.env, event.payload.id, bookmark))
  }
}

export default {
  async fetch(request: Request, env: BackupEnv): Promise<Response> {
    try { return await backupService(request, env) }
    catch { return Response.json({ error: 'Backup service unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
  },
}
