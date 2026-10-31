import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ArticleStore } from '../data/articles.ts'
import { HighlightStore } from '../data/highlights.ts'
import { createAppRouter } from '../router.ts'
import { handleMcp } from './mcp.ts'
import type { SearchResponse } from '../data/search.ts'
import { fixture, TEST_MCP_TOKEN } from '../../test/fixtures.ts'
import worker from '../../worker.ts'
import { signIn } from '../../test/auth.ts'

const origin = 'https://juniper.test'
const token = TEST_MCP_TOKEN
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
function rpc(method: string, params: unknown = {}, extra: Record<string, string> = {}) {
  return new Request(origin + '/mcp', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
}
type ReadResponse = { id: string; url: string; content: string; nextCursor: string | null; highlights: { note: string }[]; nextHighlightsCursor: string | null }

describe('MCP saved library', () => {
  it('requires a configured token, rejects invalid credentials/origins, and disables caching', async t => {
    const f = fixture(); t.after(() => f.db.close())
    assert.equal((await handleMcp(rpc('tools/list'), { ...f.env, BETTER_AUTH_SECRET: undefined })).status, 503)
    const missing = rpc('tools/list'); missing.headers.delete('Authorization')
    const denied = await handleMcp(missing, f.env)
    assert.equal(denied.status, 401)
    assert.match(denied.headers.get('WWW-Authenticate')!, /Bearer/)
    assert.equal(denied.headers.get('Cache-Control'), 'no-store')
    assert.equal((await handleMcp(rpc('tools/list', {}, { Authorization: 'Bearer wrong' }), f.env)).status, 401)
    assert.equal((await handleMcp(rpc('tools/list', {}, { Origin: 'https://evil.test' }), f.env)).status, 403)
    assert.equal((await handleMcp(new Request(origin + '/mcp', { headers }), f.env)).status, 405)
    const app = createAppRouter(f.env)
    const listed = await app.fetch(rpc('tools/list', {}, { Origin: origin }))
    assert.equal(listed.status, 200)
    const data = await listed.json() as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }
    assert.deepEqual(data.result.tools.map(tool => tool.name), ['search_saved_urls', 'get_saved_url'])
    assert.ok(data.result.tools.every(tool => tool.annotations.readOnlyHint))
    assert.doesNotMatch(JSON.stringify(data), new RegExp(token))
  })
  it('works with the official HTTP client across stateless requests, searches, reads, and paginates', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const article = (await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')).article
    const longText = 'A saved sentence about quiet reading. '.repeat(1300)
    f.db.prepare('UPDATE articles SET markdown=?, text=? WHERE id=?').run(longText, longText, article.id)
    const notes = new HighlightStore(f.env.DB, f.userId)
    for (let i = 0; i < 7; i++) await notes.create(article.id, { start: i, end: i + 1, quote: 'a', note: `Personal note ${i}` })
    const app = createAppRouter(f.env)
    const client = new Client({ name: 'juniper-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    })
    t.after(() => client.close())
    await client.connect(transport)
    assert.equal(transport.sessionId, undefined)
    assert.equal((await client.listTools()).tools.length, 2)
    const found = await client.callTool({ name: 'search_saved_urls', arguments: { query: 'quiet' } })
    assert.equal(found.isError, undefined)
    const search = found.structuredContent as unknown as SearchResponse
    assert.equal(search.results[0].id, article.id)
    assert.equal(search.mode, 'keyword')
    const read = await client.callTool({ name: 'get_saved_url', arguments: { id: article.id, includeHighlights: true } })
    const first = read.structuredContent as unknown as ReadResponse
    assert.equal(first.content.length, 16000)
    assert.equal(first.highlights.length, 5)
    assert.ok(first.nextCursor)
    assert.ok(first.nextHighlightsCursor)
    let complete = first.content
    let cursor: string | null = first.nextCursor
    while (cursor) {
      const response = await client.callTool({ name: 'get_saved_url', arguments: { id: article.id, cursor } })
      const page = response.structuredContent as unknown as ReadResponse
      complete += page.content; cursor = page.nextCursor
    }
    assert.equal(complete, longText)
    const moreNotes = await client.callTool({ name: 'get_saved_url', arguments: { id: article.id, includeHighlights: true, highlightsCursor: first.nextHighlightsCursor } })
    assert.equal((moreNotes.structuredContent as unknown as ReadResponse).highlights.length, 2)
    const badCursor = await client.callTool({ name: 'get_saved_url', arguments: { id: article.id, format: 'text', cursor: first.nextCursor } })
    assert.equal(badCursor.isError, true)
    const invalid = await client.callTool({ name: 'search_saved_urls', arguments: { limit: 999 } })
    assert.equal(invalid.isError, true)
    const unknown = await client.callTool({ name: 'delete_article', arguments: { id: article.id } })
    assert.equal(unknown.isError, true)
    const fetched = f.requests.length
    await new ArticleStore(f.env, f.userId).remove(article.id)
    const missing = await client.callTool({ name: 'get_saved_url', arguments: { id: article.id } })
    assert.equal(missing.isError, true)
    assert.equal(f.requests.length, fetched, 'MCP never fetches the original website')
  })
  it('bounds request bodies, rejects malformed JSON, and handles protocol initialization', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const oversized = new Request(origin + '/mcp', { method: 'POST', headers, body: JSON.stringify({ padding: 'x'.repeat(17000) }) })
    assert.equal((await handleMcp(oversized, f.env)).status, 413)
    const malformed = await handleMcp(new Request(origin + '/mcp', { method: 'POST', headers, body: '{invalid' }), f.env)
    assert.equal(malformed.status, 400)
    const initialized = await handleMcp(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }), f.env)
    assert.equal(initialized.status, 200)
    const data = await initialized.json() as { result: { serverInfo: { name: string }; capabilities: { tools: unknown } } }
    assert.equal(data.result.serverInfo.name, 'juniper')
    assert.ok(data.result.capabilities.tools)
  })
  it('dispatches durable jobs after successful writes and on scheduled recovery', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const deliveries: { articleId: string }[] = []
    f.env.AI = { async run() { return { data: [] } } }
    f.env.VECTORS = { async upsert() {}, async deleteByIds() {}, async query() { return { matches: [] } } }
    f.env.SEARCH_QUEUE = { async sendBatch(messages) { deliveries.push(...messages.map(message => message.body)) } }
    const article = (await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')).article
    await worker.scheduled({}, f.env)
    assert.deepEqual(deliveries, [{ articleId: article.id }])
    const background: Promise<unknown>[] = []
    const cookie = await signIn(request => worker.fetch(request, f.env), f.env)
    const response = await worker.fetch(new Request(`${origin}/articles/${article.id}/delete`, { method: 'POST', headers: { Origin: origin, Accept: 'application/json', Cookie: cookie } }), f.env, {
      waitUntil(promise) { background.push(promise) },
    })
    assert.equal(response.status, 200)
    await Promise.all(background)
    assert.equal(deliveries.length, 2)
  })
})
