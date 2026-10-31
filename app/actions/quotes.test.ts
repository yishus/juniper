import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { fixture, TEST_MCP_TOKEN } from '../../test/fixtures.ts'
import { authenticatedRouter } from '../../test/auth.ts'
import { ArticleStore } from '../data/articles.ts'
import type { Article, QuoteDraft } from '../data/types.ts'

const origin = 'https://juniper.test'
const fields = { url: 'https://x.com/ada/status/123', quoteText: 'Keep room for <ideas> & questions.', author: 'Ada Reader', note: 'A nebula of possibilities' }
function post(path: string, values: Record<string, string>, json = true) {
  return new Request(origin + path, { method: 'POST', headers: { Origin: origin, ...(json ? { Accept: 'application/json' } : {}) }, body: new URLSearchParams(values) })
}

describe('quote routes', () => {
  it('previews before saving, supports manual capture, and preserves invalid native drafts', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const app = authenticatedRouter(f.env, f.fetcher)
    const preview = await app.fetch(post('/articles', { url: fields.url }))
    assert.equal(preview.status, 200)
    const { draft } = await preview.json() as { draft: QuoteDraft }
    assert.match(draft.warning!, /Paste its text/)
    assert.equal((await new ArticleStore(f.env, f.userId).list()).length, 0)
    const count = f.requests.length
    const native = await app.fetch(post('/articles', { url: fields.url, capture: 'manual' }, false))
    const html = await native.text()
    assert.equal(native.status, 200)
    assert.match(html, /Review quote/)
    assert.match(html, /name="quoteText"/)
    assert.doesNotMatch(html, /id="add-article"[^>]*popover=/)
    assert.equal(f.requests.length, count)
    const invalid = await app.fetch(post('/articles', { ...fields, quoteText: '' }, false))
    assert.equal(invalid.status, 422)
    assert.match(await invalid.text(), /A nebula of possibilities/)
    assert.equal((await app.fetch(post('/articles', { url: 'https://articles.org/a', capture: 'manual' }))).status, 422)
  })
  it('renders quotes safely, saves and clears notes, and rejects cross-origin and nonquote mutations', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const app = authenticatedRouter(f.env, f.fetcher)
    const response = await app.fetch(post('/articles', fields))
    assert.equal(response.status, 201)
    const { article } = await response.json() as { article: Article }
    const path = `/articles/${article.id}`
    const detail = await (await app.fetch(origin + path)).text()
    assert.match(detail, /Keep room for &lt;ideas&gt; &amp; questions/)
    assert.match(detail, /Why I saved this/)
    assert.doesNotMatch(detail, /min read|type="range"/)
    const library = await (await app.fetch(origin)).text()
    assert.match(library, /Filter by type/)
    assert.match(library, /Quote · X/)
    assert.doesNotMatch(library, /Add to reading list/)
    const edited = await app.fetch(post(path + '/note', { note: 'A comet' }))
    assert.equal(edited.status, 200)
    assert.equal((await edited.json() as { article: Article }).article.quote?.note, 'A comet')
    const cleared = await app.fetch(post(path + '/note', { note: '' }, false))
    assert.equal(cleared.status, 303)
    assert.equal((await new ArticleStore(f.env, f.userId).get(article.id))?.quote?.note, '')
    assert.equal((await app.fetch(post(path + '/note', { note: 'a'.repeat(5001) }))).status, 422)
    assert.equal((await app.fetch(post(path + '/note', {}))).status, 422)
    const foreign = post(path + '/note', { note: 'bad' }); foreign.headers.set('Origin', 'https://evil.org')
    assert.equal((await app.fetch(foreign)).status, 403)
    const regular = (await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')).article
    assert.equal((await app.fetch(post(`/articles/${regular.id}/note`, { note: 'bad' }))).status, 404)
    const nativeSave = await app.fetch(post('/articles', { ...fields, url: 'https://x.com/ada/status/456' }, false))
    assert.equal(nativeSave.status, 303)
    const longQuote = await app.fetch(post('/articles', { ...fields, url: 'https://x.com/ada/status/789', quoteText: '文'.repeat(25_000), note: '記'.repeat(5000) }, false))
    assert.equal(longQuote.status, 303)
  })
  it('exposes quote type, saved text, attribution, and whole-quote notes through MCP', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const { article } = await new ArticleStore(f.env, f.userId).saveQuote({ url: fields.url, text: fields.quoteText, author: fields.author, note: fields.note })
    const app = authenticatedRouter(f.env)
    async function call(name: string, args: object) {
      const response = await app.fetch(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${TEST_MCP_TOKEN}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }))
      return (await response.json() as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent
    }
    const read = await call('get_saved_url', { id: article.id, format: 'text' })
    assert.equal(read.kind, 'quote'); assert.equal(read.note, fields.note); assert.equal(read.content, fields.quoteText); assert.equal(read.handle, 'ada'); assert.equal(read.author, fields.author)
    const search = await call('search_saved_urls', { query: 'nebula', kind: 'quote' })
    assert.equal((search.results as { id: string; kind: string }[])[0].kind, 'quote')
    assert.equal(f.requests.length, 0)
  })
})
