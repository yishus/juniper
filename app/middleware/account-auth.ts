import type { Middleware } from 'remix/router'
import { CurrentUser, authConfigured, browserSession, type AccountIdentity } from '../data/accounts.ts'
import type { AppEnv } from '../data/types.ts'
import { routes } from '../routes.ts'

export function browserAuth(env?: AppEnv): Middleware<{ key: typeof CurrentUser; value: AccountIdentity }> {
  return async (context, next) => {
    const path = context.url.pathname
    if (path === '/mcp' || path.startsWith('/assets/') || path === '/library.css' || path === '/favicon.svg' || path.startsWith('/licenses/')) return next()
    const protect = (response: Response) => {
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', 'private, no-store'); headers.set('Pragma', 'no-cache')
      headers.append('Vary', 'Cookie'); headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, { status: response.status, headers })
    }
    if (!authConfigured(env)) {
      if (['/login', '/signup'].includes(path)) return protect(await next())
      return protect(new Response('Sign-in is temporarily unavailable.', { status: 503 }))
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(context.request.method)
    if (unsafe && (context.request.headers.get('Origin') !== new URL(env.BETTER_AUTH_URL).origin || context.request.headers.get('Sec-Fetch-Site') === 'cross-site')) {
      return protect(Response.json({ error: 'Please submit this request from Juniper.' }, { status: 403 }))
    }
    try {
      if (path.startsWith('/api/auth/')) return protect(await next())
      const result = await browserSession(env, context.request)
      if (result.response) context.set(CurrentUser, result.response.user)
      if (!['/login', '/signup'].includes(path) && !result.response) {
        if (path.startsWith('/images/') || context.request.headers.get('Accept')?.includes('application/json')) {
          return protect(Response.json({ error: 'Sign in to continue.' }, { status: 401 }))
        }
        return protect(new Response(null, { status: unsafe ? 303 : 302,
          headers: { Location: routes.login.href(undefined, { searchParams: { returnTo: unsafe ? '/' : path + context.url.search } }) } }))
      }
      const response = protect(await next())
      result.headers.forEach((value, key) => { if (key.toLowerCase() === 'set-cookie') response.headers.append(key, value) })
      return response
    } catch (error) {
      console.error('Browser authentication failed:', error instanceof Error ? error.name : 'Unknown error')
      return protect(new Response('Sign-in is temporarily unavailable. Please try again.', { status: 503 }))
    }
  }
}
