import { createRouter, type MiddlewareContext } from 'remix/router'
import { render } from 'remix/middleware/render'

import { createAppController } from './actions/controller.tsx'
import type { AppEnv } from './data/types.ts'
import type { Fetcher } from './data/network.ts'
import { assets } from './assets.ts'
import { routes } from './routes.ts'
import { browserAuth } from './middleware/account-auth.ts'

const renderMiddleware = render({ assets })
export type AppContext = MiddlewareContext<[typeof renderMiddleware, ReturnType<typeof browserAuth>]>

declare module 'remix' {
  interface RouterTypes {
    context: AppContext
  }
}

export function createAppRouter(env?: AppEnv, fetcher?: Fetcher) {
  const router = createRouter<AppContext>({ middleware: [renderMiddleware, browserAuth(env)] })
  router.map(routes, createAppController(env, fetcher))
  return router
}

export const router = createAppRouter()
