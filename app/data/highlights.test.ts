import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { fixture } from '../../test/fixtures.ts'
import { ArticleStore } from './articles.ts'
import { HighlightStore } from './highlights.ts'
import { articleMarkdown } from './markdown.ts'
import { markdownText, textSegments, validateHighlight, validateNote } from '../actions/public/highlight-model.ts'
import type { Highlight } from '../actions/public/highlight-model.ts'
import { authenticatedRouter as createAppRouter } from '../../test/auth.ts'
import { routes } from '../routes.ts'
import { parseDocument } from 'htmlparser2'
import { getElementById, textContent, findAll } from 'domutils'
import { isTag } from 'domhandler'

const origin = 'https://juniper.test'
function request(path: string, data: unknown) {
  return new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: origin }, body: JSON.stringify(data) })
}

describe('saved highlights', () => {
  it('creates article-scoped highlights, renders marks and notes, and supports edits and removal', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const articles = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await articles.save('https://articles.org/story')
    const { article: other } = await articles.save('https://articles.org/another')
    const app = createAppRouter(f.env, f.fetcher)
    const text = markdownText(articleMarkdown(article))
    // This selection crosses a strong element and continues into plain text.
    const quote = 'reading without distractions and follow'
    const start = text.indexOf(quote)
    assert.ok(start >= 0)
    const input = { start, end: start + quote.length, quote, note: 'Try this tomorrow.' }
    const created = await app.fetch(request(routes.createHighlight.href({ id: article.id }), input))
    assert.equal(created.status, 201)
    const { highlight } = await created.json() as { highlight: Highlight }
    const reopened = new HighlightStore(f.env.DB, f.userId)
    assert.equal((await reopened.list(article.id))[0].note, input.note)
    assert.equal((await reopened.list(other.id)).length, 0)
    const details = await app.fetch(origin + routes.article.href({ id: article.id }))
    const doc = parseDocument(await details.text())
    const reader = getElementById('reader', doc.children)!
    const prose = findAll(node => node.attribs.class === 'reader-prose', reader.children)[0]
    assert.equal(textContent(prose), text, 'Highlight markup must preserve the canonical article text')
    const marks = findAll(node => node.name === 'mark', prose.children)
    assert.ok(marks.length >= 2, 'Selection spanning bold markup should span multiple text segments')
    assert.equal(marks.map(textContent).join(''), quote)
    assert.ok(getElementById(`highlight-text-${highlight.id}`, doc.children))
    assert.match(textContent(getElementById(`highlight-${highlight.id}`, doc.children)!), /Try this tomorrow/)
    const duplicate = await app.fetch(request(routes.createHighlight.href({ id: article.id }), { ...input, note: '' }))
    assert.equal(duplicate.status, 200)
    assert.equal((await reopened.list(article.id)).length, 1)
    assert.equal((await reopened.list(article.id))[0].note, input.note)
    const wrongArticle = await app.fetch(request(routes.updateHighlight.href({ id: other.id, highlightId: highlight.id }), { note: 'Wrong' }))
    assert.equal(wrongArticle.status, 404)
    const updated = await app.fetch(request(routes.updateHighlight.href({ id: article.id, highlightId: highlight.id }), { note: 'A revised note.' }))
    assert.equal(updated.status, 200)
    assert.equal((await reopened.get(article.id, highlight.id))?.note, 'A revised note.')
    assert.equal((await app.fetch(request(routes.deleteHighlight.href({ id: other.id, highlightId: highlight.id }), {}))).status, 404)
    const removed = await app.fetch(request(routes.deleteHighlight.href({ id: article.id, highlightId: highlight.id }), {}))
    assert.equal(removed.status, 200)
    assert.equal((await reopened.list(article.id)).length, 0)
  })
  it('validates selection anchors and notes before writing, and rejects cross-origin changes', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const { article } = await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')
    const app = createAppRouter(f.env, f.fetcher)
    const path = routes.createHighlight.href({ id: article.id })
    for (const data of [{ start: -1, end: 3, quote: 'bad' }, { start: 0, end: 3, quote: 'bad' }, { start: 0, end: 999999, quote: 'bad' }, null]) {
      assert.equal((await app.fetch(request(path, data))).status, 422)
    }
    const text = markdownText(articleMarkdown(article))
    const start = text.indexOf('Reading slowly')
    const valid = { start, end: start + 14, quote: 'Reading slowly', note: 'x'.repeat(5001) }
    assert.equal((await app.fetch(request(path, valid))).status, 422)
    const cross = request(path, { ...valid, note: '' }); cross.headers.set('Origin', 'https://other.org')
    assert.equal((await app.fetch(cross)).status, 403)
    assert.equal((await new HighlightStore(f.env.DB, f.userId).list(article.id)).length, 0)
    assert.equal((await app.fetch(request(routes.createHighlight.href({ id: 'missing' }), valid))).status, 404)
  })
  it('supports notes being added after highlighting, cleared, and safely rendered as text', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const { article } = await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')
    const app = createAppRouter(f.env, f.fetcher)
    const text = markdownText(articleMarkdown(article))
    const start = text.indexOf('Reading slowly')
    const response = await app.fetch(request(routes.createHighlight.href({ id: article.id }), { start, end: start + 14, quote: 'Reading slowly' }))
    const { highlight } = await response.json() as { highlight: Highlight }
    assert.equal(highlight.note, '')
    const href = routes.updateHighlight.href({ id: article.id, highlightId: highlight.id })
    await app.fetch(request(href, { note: '<script>alert(1)</script>' }))
    const html = await (await app.fetch(origin + routes.article.href({ id: article.id }))).text()
    const doc = parseDocument(html)
    const card = getElementById(`highlight-${highlight.id}`, doc.children)!
    assert.ok(!findAll(isTag, card.children).some(node => node.name === 'script'))
    assert.match(textContent(card), /<script>alert\(1\)<\/script>/)
    await app.fetch(request(href, { note: '  ' }))
    assert.equal((await new HighlightStore(f.env.DB, f.userId).get(article.id, highlight.id))?.note, '')
  })
})

describe('highlight text anchoring', () => {
  const highlight = (id: string, start: number, end: number): Highlight => ({ id, articleId: 'article', start, end, quote: '', note: '', createdAt: '' })
  it('splits overlapping highlights without duplicating or losing text', () => {
    const parts = textSegments('abcdefgh', 0, [highlight('a', 1, 5), highlight('b', 3, 7)])
    assert.equal(parts.map(part => part.text).join(''), 'abcdefgh')
    assert.deepEqual(parts.map(part => [part.text, part.ids]), [['a', []], ['bc', ['a']], ['de', ['a', 'b']], ['fg', ['b']], ['h', []]])
  })
  it('uses offsets to distinguish repeated text and clips spans at text-node boundaries', () => {
    const text = 'repeat repeat'
    const input = validateHighlight({ start: 7, end: 13, quote: 'repeat' }, text)
    assert.equal(input.start, 7)
    assert.deepEqual(textSegments('peat', 9, [highlight('a', 7, 13)]).map(part => part.ids), [['a']])
    assert.throws(() => validateHighlight({ start: 6, end: 12, quote: 'repeat' }, text))
    assert.throws(() => validateHighlight({ start: 0.5, end: 6, quote: 'repeat' }, text))
    assert.throws(() => validateNote('x'.repeat(5001)))
    assert.equal(validateNote('  a note  '), 'a note')
  })
})
