import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { createAppRouter } from '../router.ts'
import { ArticleStore } from '../data/articles.ts'
import { HighlightStore } from '../data/highlights.ts'
import { SearchStore } from '../data/search.ts'
import { allowedEmails, issueMcpToken, mcpIdentity, safeReturnTo, SESSION_SECONDS } from '../data/accounts.ts'
import { fixture, challengeToken, TEST_EMAIL, TEST_PASSWORD } from '../../test/fixtures.ts'
import { signIn } from '../../test/auth.ts'
import worker from '../../worker.ts'

const origin = 'https://juniper.test'
function form(path: string, values: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(origin + path, { method: 'POST', headers: { Origin: origin, ...headers }, body: new URLSearchParams(values) })
}
function login(token = challengeToken(), values: Record<string, string> = {}) {
  return form('/login', { email: TEST_EMAIL, password: TEST_PASSWORD, 'cf-turnstile-response': token, ...values })
}
function cookie(response: Response) { return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
async function register(f: ReturnType<typeof fixture>, email = 'second@example.com') {
  const app = createAppRouter(f.env)
  const response = await app.fetch(form('/signup', { email, password: TEST_PASSWORD, name: 'Second user', 'cf-turnstile-response': challengeToken() }))
  assert.equal(response.status, 303, await response.clone().text())
  const user = f.db.prepare('SELECT id FROM ba_user WHERE email=?').get(email) as { id: string }
  return { app, id: user.id, cookie: cookie(response) }
}

describe('Better Auth accounts and Turnstile', () => {
  it('throttles repeated signin attempts in D1', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const app = createAppRouter(f.env)
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await app.fetch(form('/login', { email: TEST_EMAIL, password: 'wrong-password', 'cf-turnstile-response': challengeToken() }, { 'CF-Connecting-IP': '192.0.2.10' }))
      assert.equal(response.status, 401)
    }
    const response = await app.fetch(form('/login', { email: TEST_EMAIL, password: TEST_PASSWORD, 'cf-turnstile-response': challengeToken() }, { 'CF-Connecting-IP': '192.0.2.10' }))
    assert.equal(response.status, 429)
    assert.ok(Number(response.headers.get('Retry-After')) > 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ba_session').get()!.n, 0)
  })
  it('supports signup and signin for normalized allowlisted emails with hashed passwords', async t => {
    const f = fixture(); t.after(() => f.db.close())
    f.env.AUTH_ALLOWED_EMAILS = ' OWNER@EXAMPLE.COM, second@example.com, ,second@example.com '
    assert.equal(allowedEmails(f.env).size, 2)
    const second = await register(f)
    const account = f.db.prepare('SELECT password FROM ba_account WHERE userId=?').get(second.id) as { password: string }
    assert.notEqual(account.password, TEST_PASSWORD)
    assert.ok(account.password.length > 100)
    const page = await second.app.fetch(new Request(origin, { headers: { Cookie: second.cookie } }))
    assert.equal(page.status, 200)
    const signin = await second.app.fetch(login(challengeToken(), { email: ' SECOND@EXAMPLE.COM ' }))
    assert.equal(signin.status, 303)
    assert.match(signin.headers.get('Set-Cookie')!, /HttpOnly/)
    assert.match(signin.headers.get('Set-Cookie')!, /Secure/)
    assert.match(signin.headers.get('Set-Cookie')!, /SameSite=Lax/)
  })
  it('reads existing ISO-text sessions after reopening the app and rejects expired sessions', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const app = createAppRouter(f.env)
    const signed = await signIn(request => app.fetch(request), f.env)
    const now = Date.now()
    // Preserve the physical date format used by the previous auth adapter.
    // Reading these records must not require rewriting them as epoch numbers.
    const createdAt = new Date(now - 60000).toISOString()
    const expiresAt = new Date(now + SESSION_SECONDS * 1000).toISOString()
    f.db.prepare('UPDATE ba_session SET createdAt=?, updatedAt=?, expiresAt=? WHERE userId=?')
      .run(createdAt, createdAt, expiresAt, f.userId)
    const reopened = createAppRouter({ ...f.env })
    assert.equal((await reopened.fetch(new Request(origin, { headers: { Cookie: signed } }))).status, 200)
    assert.equal(f.db.prepare('SELECT expiresAt FROM ba_session WHERE userId=?').get(f.userId)!.expiresAt, expiresAt)
    f.db.prepare('UPDATE ba_session SET expiresAt=? WHERE userId=?').run(new Date(now - 1000).toISOString(), f.userId)
    assert.equal((await reopened.fetch(new Request(origin, { headers: { Cookie: signed } }))).status, 302)
  })
  it('blocks non-allowlisted signup/signin and immediately revokes removed users', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const app = createAppRouter(f.env)
    for (const path of ['/signup', '/login']) {
      const response = await app.fetch(form(path, { email: 'stranger@example.com', password: TEST_PASSWORD, name: 'Stranger', 'cf-turnstile-response': challengeToken() }))
      assert.equal(response.status, 403)
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ba_user').get()!.n, 1)
    const signed = await signIn(request => app.fetch(request), f.env)
    const token = await issueMcpToken(f.env, f.userId)
    f.env.AUTH_ALLOWED_EMAILS = 'second@example.com'
    assert.equal((await app.fetch(new Request(origin, { headers: { Cookie: signed } }))).status, 302)
    assert.equal(await mcpIdentity(f.env, token), null)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ba_session').get()!.n, 0)
    assert.equal((await app.fetch(login())).status, 403)
  })
  it('requires a valid, single-use Turnstile token with the right action and hostname', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const app = createAppRouter(f.env)
    assert.equal((await app.fetch(form('/login', { email: TEST_EMAIL, password: TEST_PASSWORD }))).status, 400)
    for (const token of ['forged', challengeToken('evil.test'), challengeToken('juniper.test', 'other-action')]) {
      assert.equal((await app.fetch(login(token))).status, 403)
    }
    const token = challengeToken()
    assert.equal((await app.fetch(login(token))).status, 303)
    assert.equal((await app.fetch(login(token))).status, 403)
    const raw = await app.fetch(new Request(origin + '/api/auth/sign-up/email', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'second@example.com', password: TEST_PASSWORD, name: 'Second' }) }))
    assert.equal(raw.status, 400, 'Direct Better Auth requests cannot bypass Turnstile')
  })
  it('fails closed on missing configuration and unsafe origins, and rejects open redirects', async t => {
    const f = fixture(); t.after(() => f.db.close())
    for (const partial of [{ AUTH_ALLOWED_EMAILS: '' }, { AUTH_ALLOWED_EMAILS: 'invalid' }, { BETTER_AUTH_SECRET: '' }, { TURNSTILE_SECRET_KEY: '' }, { TURNSTILE_SITE_KEY: '' }, { BETTER_AUTH_URL: '' }]) {
      const app = createAppRouter({ ...f.env, ...partial })
      assert.equal((await app.fetch(origin)).status, 503)
      assert.equal((await app.fetch(origin + '/signup')).status, 503)
    }
    const app = createAppRouter(f.env)
    assert.equal((await app.fetch(form('/login', {}, { Origin: 'https://evil.test' }))).status, 403)
    for (const target of ['https://evil.test', '//evil.test', '/\\evil.test', '/signup', '/api/auth/get-session']) assert.equal(safeReturnTo(target, origin), '/')
    const response = await app.fetch(login(challengeToken(), { returnTo: '//evil.test' }))
    assert.equal(response.headers.get('Location'), '/')
    const signed = cookie(response)
    const logout = await app.fetch(form('/logout', {}, { Cookie: signed }))
    assert.equal(logout.status, 303)
    assert.equal((await app.fetch(new Request(origin, { headers: { Cookie: signed } }))).status, 302)
  })
  it('keeps each account’s articles, images, reading list, highlights, and keyword search isolated', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const first = new ArticleStore(f.env, f.userId, f.fetcher)
    const article = (await first.save('https://articles.org/story')).article
    const second = await register(f)
    const other = new ArticleStore(f.env, second.id, f.fetcher)
    assert.equal((await other.list()).length, 0)
    assert.equal(await other.get(article.id), null)
    assert.equal(await other.remove(article.id), null)
    assert.equal(await other.setReadingList(article.id, true), null)
    for (const path of [`/articles/${article.id}`, `/articles/${article.id}/markdown`, article.image!]) {
      assert.equal((await second.app.fetch(new Request(origin + path, { headers: { Cookie: second.cookie } }))).status, 404)
    }
    const highlights = new HighlightStore(f.env.DB, f.userId)
    const { highlight } = await highlights.create(article.id, { start: 0, end: 4, quote: 'text', note: 'A private quasar' })
    const denied = new HighlightStore(f.env.DB, second.id)
    assert.deepEqual(await denied.list(article.id), [])
    assert.equal(await denied.updateNote(article.id, highlight.id, 'changed'), null)
    assert.equal(await denied.remove(article.id, highlight.id), false)
    await assert.rejects(denied.create(article.id, { start: 0, end: 4, quote: 'text', note: '' }), /not found/)
    assert.equal((await new SearchStore(f.env, second.id).search({ query: 'quasar' }, origin)).results.length, 0)
    const own = (await other.save(article.url)).article
    assert.notEqual(own.id, article.id, 'The same URL may be saved independently')
    assert.equal((await first.list()).length, 1)
    assert.equal((await other.list()).length, 1)
  })
  it('scopes MCP tokens to users, supports rotation/revocation, and rejects the old global token', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const article = (await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')).article
    const second = await register(f)
    const token = await issueMcpToken(f.env, second.id)
    const rpc = (method: string, args: Record<string, unknown>) => new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: method, arguments: args } }) })
    const result = await (await second.app.fetch(rpc('search_saved_urls', {}))).json() as { result: { structuredContent: { results: unknown[] } } }
    assert.deepEqual(result.result.structuredContent.results, [])
    const denied = await (await second.app.fetch(rpc('get_saved_url', { id: article.id }))).json() as { result: { isError: boolean } }
    assert.equal(denied.result.isError, true)
    await issueMcpToken(f.env, second.id)
    assert.equal(await mcpIdentity(f.env, token), null)
    const issued = await second.app.fetch(form('/account/mcp-token', { intent: 'create' }, { Cookie: second.cookie }))
    const html = await issued.text()
    assert.match(html, /juniper_[\da-f]{64}/)
    const active = html.match(/juniper_[\da-f]{64}/)![0]
    assert.equal((await mcpIdentity(f.env, active))!.id, second.id)
    assert.doesNotMatch(await (await second.app.fetch(new Request(origin + '/account', { headers: { Cookie: second.cookie } }))).text(), new RegExp(active))
    await second.app.fetch(form('/account/mcp-token', { intent: 'revoke' }, { Cookie: second.cookie }))
    assert.equal(await mcpIdentity(f.env, active), null)
    assert.equal(await mcpIdentity(f.env, 'old-global-secret-at-least-32-characters'), null)
  })
  it('does not dispatch indexing jobs after an unauthenticated native form redirect', async t => {
    const f = fixture(); t.after(() => f.db.close())
    let sent = false
    f.env.SEARCH_QUEUE = { async sendBatch() { sent = true } }
    f.env.AI = { async run() { return { data: [] } } }
    f.env.VECTORS = { async upsert() {}, async deleteByIds() {}, async query() { return { matches: [] } } }
    assert.equal((await worker.fetch(form('/articles', {}), f.env)).status, 303)
    assert.equal(sent, false)
  })
})
