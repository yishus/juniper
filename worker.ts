import './app/validation.ts'
import { createAppRouter } from './app/router.ts'
import type { AppEnv } from './app/data/types.ts'
import { consumeSearchQueue, dispatchSearchJobs, type SearchQueueBatch } from './app/data/search-index.ts'

export default {
  async fetch(request: Request, env?: AppEnv, context?: { waitUntil(promise: Promise<unknown>): void }) {
    const response = await createAppRouter(env).fetch(request)
    const redirect = response.headers.get('Location')
    const requiresLogin = redirect && new URL(redirect, request.url).pathname === '/login'
    if (request.method === 'POST' && new URL(request.url).pathname.startsWith('/articles') && response.status < 400 && !requiresLogin) {
      const dispatch = dispatchSearchJobs(env).catch(error => console.error('Search queue dispatch failed:', error instanceof Error ? error.name : 'Unknown error'))
      if (context) context.waitUntil(dispatch)
      else await dispatch
    }
    return response
  },
  async scheduled(_event: unknown, env: AppEnv) {
    // D1 is the durable outbox. This also recovers queue outages/expired messages
    // by republishing due indexing jobs.
    await dispatchSearchJobs(env)
  },
  async queue(batch: SearchQueueBatch, env: AppEnv) {
    await consumeSearchQueue(batch, env)
  },
}
