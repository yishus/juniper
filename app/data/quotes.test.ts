import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { fixture } from '../../test/fixtures.ts'
import { ArticleStore } from './articles.ts'
import { captureQuote, xPost } from './quotes.ts'
import { SearchStore } from './search.ts'
import { articlePassages } from './search-index.ts'
import type { Fetcher } from './network.ts'

export const quoteEmbed = {
  author_name: 'Ada Reader', author_url: 'https://x.com/ada',
  html: '<blockquote class="twitter-tweet"><p lang="en">Keep a little space.<br>Let ideas &amp; questions grow. <a href="https://example.org">A link</a></p>— Ada (@ada) <a href="https://x.com/ada/status/123">June 1</a></blockquote><script>alert(1)</script>',
}

describe('saved X quotes', () => {
  it('recognizes single-post URLs and rejects lookalikes and other X pages', () => {
    assert.deepEqual(xPost('https://mobile.twitter.com/Ada/status/123/photo/1?s=20#hello'), { url: 'https://x.com/ada/status/123', handle: 'ada', postId: '123' })
    assert.equal(xPost('https://x.com/i/web/status/123')?.postId, '123')
    for (const url of ['https://x.com/ada', 'https://x.com/ada/status/nope', 'https://x.com.evil.org/ada/status/123', 'https://evil.org/ada/status/123', 'https://x.com@evil.org/ada/status/123', 'https://user@x.com/ada/status/123', 'javascript:alert(1)']) assert.equal(xPost(url), null)
  })
  it('captures only the target text, preserves line breaks, and offers manual capture on failure', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(input.toString())
      if (url.hostname === 'publish.x.com') {
        assert.equal(url.searchParams.get('hide_thread'), 'true')
        return Response.json(quoteEmbed)
      }
      return f.fetcher(input, init)
    }
    const draft = await captureQuote('https://twitter.com/ada/status/123?s=20', fetcher)
    assert.equal(draft.text, 'Keep a little space.\nLet ideas & questions grow. A link')
    assert.equal(draft.author, 'Ada Reader')
    assert.equal(draft.warning, undefined)
    assert.equal((await new ArticleStore(f.env, f.userId).list()).length, 0)
    for (const response of [new Response('Unavailable', { status: 403 }), Response.json({ html: '<p>Sign in</p>' }), Response.json({ html: '<blockquote class="twitter-tweet"><p></p></blockquote>' }), new Response('{', { headers: { 'Content-Type': 'application/json' } })]) {
      const failed = await captureQuote(draft.url, async (input, init) => new URL(input.toString()).hostname === 'publish.x.com' ? response : f.fetcher(input, init))
      assert.equal(failed.text, '')
      assert.match(failed.warning!, /Paste its text/)
    }
  })
  it('deduplicates post IDs, isolates accounts, and keeps quotes out of the reading list', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const input = { url: 'https://x.com/ada/status/123', text: 'Small ideas matter.', author: 'Ada', note: 'Remember this' }
    const { article } = await store.saveQuote(input)
    assert.equal(article.kind, 'quote')
    assert.equal(article.quote?.text, input.text)
    assert.equal(article.readingMinutes, 0)
    assert.equal(f.requests.length, 0)
    assert.equal(f.objects.size, 0)
    const again = await store.saveQuote({ ...input, url: 'https://twitter.com/renamed/status/123?s=20', text: 'Do not overwrite me' })
    assert.equal(again.duplicate, true)
    assert.equal(again.article.id, article.id)
    assert.equal(again.article.text, input.text)
    assert.equal((await store.setReadingList(article.id, true))?.inReadingList, false)
    const secondId = crypto.randomUUID()
    f.db.prepare('INSERT INTO ba_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run(secondId, 'Second', 'second@example.com', 0, Date.now(), Date.now())
    const second = new ArticleStore(f.env, secondId)
    assert.equal(await second.get(article.id), null)
    assert.equal(await second.updateQuoteNote(article.id, 'Wrong account'), null)
    assert.equal(await second.remove(article.id), null)
    assert.equal((await second.saveQuote(input)).duplicate, false)
    assert.equal((await store.get(article.id))?.quote?.note, 'Remember this')
    for (const bad of [{ ...input, text: '' }, { ...input, text: 'x'.repeat(25_001) }, { ...input, author: 'a'.repeat(201) }, { ...input, note: 'n'.repeat(5001) }, { ...input, url: 'https://evil.org/a' }]) await assert.rejects(store.saveQuote(bad))
  })
  it('searches the full quote, attribution, and notes, reindexes edits and removes deleted content', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.saveQuote({ url: 'https://x.com/ada/status/123', text: 'Opening '.repeat(50) + 'sunflower', author: 'Ada Reader', note: 'Nebula' })
    await store.save('https://articles.org/story')
    const search = new SearchStore(f.env, f.userId)
    for (const query of ['sunflower', 'ada', 'Nebula']) assert.equal((await search.search({ query, kind: 'quote' }, 'https://juniper.test')).results[0].id, article.id)
    assert.equal((await search.search({ kind: 'article' }, 'https://juniper.test')).results.length, 1)
    const before = f.db.prepare('SELECT revision FROM search_jobs WHERE article_id=?').get(article.id)!.revision
    const updated = await store.updateQuoteNote(article.id, 'Comet')
    assert.notEqual(f.db.prepare('SELECT revision FROM search_jobs WHERE article_id=?').get(article.id)!.revision, before)
    assert.equal((await search.search({ query: 'Nebula' }, 'https://juniper.test')).results.length, 0)
    assert.equal((await search.search({ query: 'Comet' }, 'https://juniper.test')).results.length, 1)
    assert.match((await articlePassages(updated!, [])).map(p => p.content).join('\n'), /Personal note:\nComet/)
    await store.updateQuoteNote(article.id, '')
    assert.equal((await search.search({ query: 'Comet' }, 'https://juniper.test')).results.length, 0)
    await store.remove(article.id)
    assert.equal((await search.search({ kind: 'quote' }, 'https://juniper.test')).results.length, 0)
  })
})
