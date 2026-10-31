import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { captcha } from 'better-auth/plugins/captcha'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { eq } from 'drizzle-orm'
import { createContextKey } from 'remix/router'
import type { AppEnv } from './types.ts'
import { database } from './database.ts'
import { authAccounts, authRateLimits, authSessions, authUsers, authVerifications, mcpTokens } from './schema.ts'

export const SESSION_SECONDS = 7 * 24 * 60 * 60
export interface AccountIdentity { id: string; email: string; name: string }
export const CurrentUser = createContextKey<AccountIdentity>()

export function allowedEmails(env?: AppEnv): Set<string> {
  const values = (env?.AUTH_ALLOWED_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  if (!values.length || values.some(value => value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return new Set()
  return new Set(values)
}
export function emailAllowed(env: AppEnv, email: string): boolean { return allowedEmails(env).has(email.trim().toLowerCase()) }
export function authConfigured(env?: AppEnv): env is AppEnv & {
  BETTER_AUTH_URL: string; BETTER_AUTH_SECRET: string; TURNSTILE_SITE_KEY: string; TURNSTILE_SECRET_KEY: string
} {
  try {
    const url = new URL(env?.BETTER_AUTH_URL ?? '')
    return Boolean(env && allowedEmails(env).size && env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length >= 32
      && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && url.origin === env.BETTER_AUTH_URL
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
  } catch { return false }
}

function makeAuth(env: AppEnv & { BETTER_AUTH_URL: string; BETTER_AUTH_SECRET: string; TURNSTILE_SECRET_KEY: string }) {
  const origin = new URL(env.BETTER_AUTH_URL)
  const db = database(env.DB)
  return betterAuth({
    appName: 'Juniper', baseURL: origin.origin, basePath: '/api/auth', secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin.origin],
    database: drizzleAdapter(db, { provider: 'sqlite', transaction: false, schema: {
      ba_user: authUsers, ba_session: authSessions, ba_account: authAccounts, ba_verification: authVerifications, ba_rate_limit: authRateLimits,
    } }),
    user: { modelName: 'ba_user', changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    session: { modelName: 'ba_session', expiresIn: SESSION_SECONDS, updateAge: 24 * 60 * 60, cookieCache: { enabled: false } },
    account: { modelName: 'ba_account', accountLinking: { enabled: false } },
    verification: { modelName: 'ba_verification' },
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128, requireEmailVerification: false },
    rateLimit: { enabled: true, storage: 'database', modelName: 'ba_rate_limit', window: 60, max: 60,
      customRules: { '/sign-in/email': { window: 900, max: 10 }, '/sign-up/email': { window: 900, max: 5 } } },
    advanced: { useSecureCookies: origin.protocol === 'https:', ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      database: { generateId: () => crypto.randomUUID() } },
    plugins: [captcha({ provider: 'cloudflare-turnstile', secretKey: env.TURNSTILE_SECRET_KEY,
      endpoints: ['/sign-up/email', '/sign-in/email'], expectedAction: 'auth', allowedHostnames: [origin.hostname] })],
    hooks: { before: createAuthMiddleware(async context => {
      if (['/sign-up/email', '/sign-in/email'].includes(context.path)) {
        const email = typeof context.body?.email === 'string' ? context.body.email.trim().toLowerCase() : ''
        if (!emailAllowed(env, email)) throw new APIError('FORBIDDEN', { message: 'This email is not allowed to access Juniper.' })
        context.body.email = email
      }
    }) },
    databaseHooks: {
      user: { create: { before: async user => {
        if (!emailAllowed(env, user.email)) throw new APIError('FORBIDDEN', { message: 'Access is not allowed.' })
        return { data: { ...user, email: user.email.trim().toLowerCase() } }
      } } },
      session: { create: { before: async session => {
        const user = await db.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, session.userId)).get()
        if (!user || !emailAllowed(env, user.email)) throw new APIError('FORBIDDEN', { message: 'Access is not allowed.' })
      } } },
    },
  })
}
const instances = new WeakMap<AppEnv, { key: string; auth: ReturnType<typeof makeAuth> }>()
export async function getAuth(env: AppEnv) {
  if (!authConfigured(env)) throw new Error('Authentication is not configured')
  const key = JSON.stringify([env.BETTER_AUTH_URL, env.BETTER_AUTH_SECRET, env.AUTH_ALLOWED_EMAILS, env.TURNSTILE_SECRET_KEY])
  let value = instances.get(env)
  if (!value || value.key !== key) { value = { key, auth: makeAuth(env) }; instances.set(env, value) }
  return value.auth
}

export async function browserSession(env: AppEnv, request: Request) {
  const result = await (await getAuth(env)).api.getSession({ headers: request.headers, returnHeaders: true, query: { disableCookieCache: true } })
  if (result.response && !emailAllowed(env, result.response.user.email)) {
    const db = database(env.DB)
    await db.batch([
      db.delete(authSessions).where(eq(authSessions.userId, result.response.user.id)),
      db.delete(mcpTokens).where(eq(mcpTokens.userId, result.response.user.id)),
    ])
    return { headers: new Headers(), response: null }
  }
  return result
}

export function safeReturnTo(input: string | null | undefined, origin: string): string {
  if (!input || !input.startsWith('/') || input.startsWith('//') || input.includes('\\') || /[\u0000-\u001f\u007f]/.test(input)) return '/'
  try {
    const target = new URL(input, origin)
    if (target.origin !== origin || ['/login', '/signup', '/logout', '/mcp'].includes(target.pathname) || target.pathname.startsWith('/api/auth')) return '/'
    return target.pathname + target.search
  } catch { return '/' }
}

export async function tokenHash(token: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function issueMcpToken(env: AppEnv, userId: string): Promise<string> {
  const token = 'juniper_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  const values = { userId, tokenHash: await tokenHash(token), createdAt: new Date().toISOString() }
  await database(env.DB).insert(mcpTokens).values(values).onConflictDoUpdate({ target: mcpTokens.userId, set: values }).run()
  return token
}
export async function mcpIdentity(env: AppEnv, token: string): Promise<AccountIdentity | null> {
  if (!authConfigured(env) || !/^juniper_[\da-f]{64}$/.test(token)) return null
  const user = await database(env.DB).select({ id: authUsers.id, email: authUsers.email, name: authUsers.name }).from(mcpTokens)
    .innerJoin(authUsers, eq(authUsers.id, mcpTokens.userId)).where(eq(mcpTokens.tokenHash, await tokenHash(token))).get()
  return user && emailAllowed(env, user.email) ? user : null
}
