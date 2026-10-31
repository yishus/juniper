import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { videoFixture, videoUrl, subtitles } from '../../test/video-fixtures.ts'
import { authenticatedRouter } from '../../test/auth.ts'
import { TEST_MCP_TOKEN } from '../../test/fixtures.ts'
import { ArticleStore } from '../data/articles.ts'
import { HighlightStore } from '../data/highlights.ts'
import type { Article } from '../data/types.ts'
import type { Highlight } from './public/highlight-model.ts'

const origin = 'https://juniper.test'
function post(path: string, values: Record<string, string>, json = true) {
  return new Request(origin + path, { method: 'POST', headers: { Origin: origin, ...(json ? { Accept: 'application/json' } : {}) }, body: new URLSearchParams(values) })
}

describe('YouTube routes', () => {
  it('saves videos immediately and renders the player, transcript, highlights, and library filter', async t => {
    const f = videoFixture(); t.after(() => f.db.close())
    const app = authenticatedRouter(f.env, f.fetcher)
    const response = await app.fetch(post('/articles', { url: videoUrl }))
    assert.equal(response.status, 201)
    const { article } = await response.json() as { article: Article }
    const detail = await (await app.fetch(`${origin}/articles/${article.id}`)).text()
    assert.match(detail, /Room for &lt;ideas&gt;/); assert.match(detail, /youtube.com\/embed\/M7lc1UVf-VE/)
    assert.match(detail, /Start highlight/); assert.match(detail, /Highlight a segment/); assert.match(detail, /Keep a nebula/)
    assert.match(detail, /Why I saved this/); assert.doesNotMatch(detail, /min read/)
    const library = await (await app.fetch(origin)).text()
    assert.match(library, /Video · YouTube/); assert.match(library, />Videos</); assert.doesNotMatch(library, /Add to reading list/)
    assert.equal((await app.fetch(post('/articles', { url: videoUrl + '&t=50' }))).status, 200)
  })
  it('creates, adjusts, annotates, deduplicates, and removes timestamped highlights', async t => {
    const f = videoFixture(); t.after(() => f.db.close())
    const app = authenticatedRouter(f.env, f.fetcher)
    const article = (await new ArticleStore(f.env, f.userId, f.fetcher).save(videoUrl)).article
    const path = `/articles/${article.id}/highlights`
    const fields = { start: '0:01', end: '0:08.500', note: 'Keep this <moment>' }
    const response = await app.fetch(post(path, fields))
    assert.equal(response.status, 201)
    const { highlight } = await response.json() as { highlight: Highlight }
    assert.equal(highlight.start, 1000); assert.equal(highlight.end, 8500); assert.match(highlight.quote, /nebula/)
    assert.equal((await app.fetch(post(path, fields))).status, 200)
    assert.equal((await app.fetch(post(path, { ...fields, note: 'Different note' }))).status, 409)
    assert.equal((await app.fetch(post(path, { start: '2:00', end: '1:00' }))).status, 422)
    assert.equal((await app.fetch(post(path, { start: '0:00', end: '2:01' }))).status, 422)
    const json = new Request(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ start: 9000, end: 10000, note: 'Visual moment' }) })
    assert.equal((await app.fetch(json)).status, 201)
    const native = await app.fetch(post(`${path}/${highlight.id}/note`, { start: '0:02', end: '0:04', note: 'Updated' }, false))
    assert.equal(native.status, 303)
    const updated = await new HighlightStore(f.env.DB, f.userId).get(article.id, highlight.id)
    assert.equal(updated?.start, 2000); assert.equal(updated?.quote, 'Make room for ideas.'); assert.equal(updated?.note, 'Updated')
    const collision = await app.fetch(post(`${path}/${highlight.id}/note`, { start: '0:09', end: '0:10', note: '' }))
    assert.equal(collision.status, 409)
    const foreign = post(path, fields); foreign.headers.set('Origin', 'https://evil.org')
    assert.equal((await app.fetch(foreign)).status, 403)
    f.db.prepare('UPDATE articles SET user_id=? WHERE id=?').run('other-user', article.id)
    assert.equal((await app.fetch(post(path, fields))).status, 404)
    assert.equal((await app.fetch(post(`${path}/${highlight.id}/delete`, {}))).status, 404)
    f.db.prepare('UPDATE articles SET user_id=? WHERE id=?').run(f.userId, article.id)
    assert.equal((await app.fetch(post(`${path}/${highlight.id}/delete`, {}, false))).status, 303)
    assert.equal(await new HighlightStore(f.env.DB, f.userId).get(article.id, highlight.id), null)
  })
  it('imports subtitles and edits video notes through enhanced and native forms', async t => {
    const f = videoFixture(); t.after(() => f.db.close())
    const app = authenticatedRouter(f.env, f.fetcher)
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const article = (await store.save(videoUrl)).article
    const path = `/articles/${article.id}`
    assert.equal((await app.fetch(post(path + '/transcript', { transcript: 'Invalid' }))).status, 422)
    assert.equal((await app.fetch(post(path + '/transcript', { transcript: subtitles }, false))).status, 303)
    const foreign = post(path + '/transcript', { transcript: subtitles }); foreign.headers.set('Origin', 'https://evil.org')
    assert.equal((await app.fetch(foreign)).status, 403)
    assert.equal((await app.fetch(post(path + '/note', { note: 'A sunflower' }))).status, 200)
    assert.equal((await store.get(article.id))?.video?.note, 'A sunflower')
    assert.equal((await app.fetch(post(path + '/note', { note: '' }, false))).status, 303)
    assert.equal((await app.fetch(post(path + '/note', { note: 'n'.repeat(5001) }))).status, 422)
    assert.equal((await store.get(article.id))?.video?.note, '')
  })
  it('returns video transcripts, notes, and highlight position units through MCP', async t => {
    const f = videoFixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.save(videoUrl)
    await store.updateVideoNote(article.id, 'A comet')
    await new HighlightStore(f.env.DB, f.userId).create(article.id, { start: 1000, end: 4000, quote: 'Make room for ideas.', note: 'Keep' })
    const app = authenticatedRouter(f.env)
    const response = await app.fetch(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${TEST_MCP_TOKEN}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_saved_url', arguments: { id: article.id, includeHighlights: true } } }) }))
    const data = (await response.json() as { result: { structuredContent: { kind: string; content: string; highlightPositionUnit: string; note: string; highlights: Highlight[] } } }).result.structuredContent
    assert.equal(data.kind, 'video'); assert.equal(data.highlightPositionUnit, 'milliseconds'); assert.equal(data.note, 'A comet')
    assert.match(data.content, /nebula/); assert.equal(data.highlights[0].start, 1000)
  })
})
