import { authConfigured, browserSession, getAuth, safeReturnTo } from '../data/accounts.ts'
import { readLimited } from '../data/network.ts'
import type { AppEnv } from '../data/types.ts'

export async function handleAuthRequest(request: Request, env?: AppEnv): Promise<Response> {
  if (!authConfigured(env)) return Response.json({ message: 'Authentication is unavailable.' }, { status: 503 })
  const path = new URL(request.url).pathname.slice('/api/auth'.length)
  if (request.method === 'GET' && path === '/get-session') {
    const session = await browserSession(env, request)
    return Response.json(session.response, { headers: session.headers })
  }
  if (request.method !== 'POST' || !['/sign-in/email', '/sign-up/email', '/sign-out'].includes(path)) {
    return Response.json({ message: 'Not found.' }, { status: 404 })
  }
  if (request.headers.get('Origin') !== env.BETTER_AUTH_URL) return Response.json({ message: 'Origin is not allowed.' }, { status: 403 })
  if (path !== '/sign-out') {
    const token = request.headers.get('x-captcha-response') ?? ''
    if (!token || token.length > 2048) return Response.json({ message: 'Complete the security check and try again.' }, { status: 400 })
  }
  try {
    const body = await readLimited(new Response(request.body), 16384)
    const response = await (await getAuth(env)).handler(new Request(request.url, { method: request.method, headers: request.headers, body }))
    // Better Auth exposes X-Retry-After; also provide the standard HTTP header.
    const retryAfter = response.headers.get('X-Retry-After')
    if (response.status === 429 && retryAfter) response.headers.set('Retry-After', retryAfter)
    return response
  } catch (error) {
    console.error('Authentication request failed:', error instanceof Error ? error.name : 'Unknown error')
    return Response.json({ message: 'Authentication is temporarily unavailable.' }, { status: 503 })
  }
}

export async function submitAuthForm(request: Request, env: AppEnv, signup: boolean) {
  let email = '', returnTo = '/', password = '', name = '', token = ''
  try {
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new Error('Invalid form')
    const form = new URLSearchParams(new TextDecoder().decode(await readLimited(new Response(request.body), 16384)))
    if (form.getAll('email').length !== 1 || form.getAll('password').length !== 1 || form.getAll('cf-turnstile-response').length !== 1) throw new Error('Invalid form')
    email = form.get('email')!.trim().toLowerCase(); password = form.get('password')!
    name = form.get('name')?.trim() ?? ''
    token = form.get('cf-turnstile-response')!
    returnTo = safeReturnTo(form.get('returnTo')?.slice(0, 2048), new URL(request.url).origin)
    if (email.length > 254 || password.length > 128 || name.length > 100 || !token || token.length > 2048) throw new Error('Invalid form')
  } catch { return { email, returnTo, error: 'Complete the form and security check, then try again.', status: 400 } }
  const headers = new Headers(request.headers)
  headers.delete('Content-Length'); headers.set('Content-Type', 'application/json'); headers.set('x-captcha-response', token)
  const response = await handleAuthRequest(new Request(`${env.BETTER_AUTH_URL}/api/auth/${signup ? 'sign-up' : 'sign-in'}/email`, {
    method: 'POST', headers, body: JSON.stringify({ email, password, ...(signup ? { name } : {}), callbackURL: returnTo }),
  }), env)
  if (response.ok) {
    const result = new Headers(response.headers); result.delete('Content-Type'); result.delete('Content-Length'); result.set('Location', returnTo)
    return { response: new Response(null, { status: 303, headers: result }), email, returnTo, status: 303 }
  }
  const data = await response.json() as { message?: string; code?: string }
  const message = response.status === 429 ? 'Too many attempts. Please try again later.'
    : response.status === 401 ? 'Invalid email or password.'
    : response.status >= 500 ? 'Authentication is temporarily unavailable. Please try again.'
    : data.message ?? 'Could not continue. Please try again.'
  return { email, returnTo, error: message, status: response.status, retryAfter: response.headers.get('Retry-After') }
}
