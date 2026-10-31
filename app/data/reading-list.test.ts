import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { parseDocument } from 'htmlparser2'
import { findAll } from 'domutils'
import { fixture } from '../../test/fixtures.ts'
import { ArticleStore } from './articles.ts'
import { authenticatedRouter as createAppRouter } from '../../test/auth.ts'
import { routes } from '../routes.ts'

const origin = 'https://juniper.test'
function update(id: string, included: string, json = true) {
  return new Request(origin + routes.readingList.href({ id }), {
    method: 'POST', body: new URLSearchParams({ included }),
    headers: { Origin: origin, ...(json ? { Accept: 'application/json' } : {}) },
  })
}

describe('article reading list', () => {
  it('persists membership, updates both lists and menus, and preserves saved content when removed', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.save('https://articles.org/story')
    const { article: other } = await store.save('https://articles.org/other')
    // Existing summaries do not need rewriting to support the reading list.
    const { inReadingList, markdown, text, ...legacy } = article
    f.db.prepare('UPDATE articles SET summary = ? WHERE id = ?').run(JSON.stringify(legacy), article.id)
    assert.equal((await store.get(article.id))?.inReadingList, false)
    const app = createAppRouter(f.env, f.fetcher)
    const added = await app.fetch(update(article.id, 'true'))
    assert.equal(added.status, 200)
    assert.equal((await added.json() as { article: { inReadingList: boolean } }).article.inReadingList, true)
    const reopened = new ArticleStore(f.env, f.userId, f.fetcher)
    assert.equal((await reopened.get(article.id))?.inReadingList, true)
    assert.equal((await reopened.get(other.id))?.inReadingList, false)
    await app.fetch(update(article.id, 'true'))
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM reading_list').get()!.count, 1)
    const doc = parseDocument(await (await app.fetch(origin)).text())
    assert.equal(findAll(node => node.attribs.id === 'to-read-title', doc.children).length, 1)
    for (const scope of ['saved', 'reading']) {
      const menu = findAll(node => node.attribs.id === `${scope}-menu-${article.id}`, doc.children)[0]
      assert.ok(menu)
      assert.equal(menu.attribs.popover, 'auto')
      const forms = findAll(node => node.name === 'form', menu.children)
      assert.equal(forms.length, 2)
      assert.equal(forms[0].attribs.action, routes.readingList.href({ id: article.id }))
      assert.equal(findAll(node => node.name === 'input', forms[0].children)[0].attribs.value, 'false')
      assert.equal(forms[1].attribs.action, routes.deleteArticle.href({ id: article.id }))
    }
    const removed = await app.fetch(update(article.id, 'false', false))
    assert.equal(removed.status, 303)
    assert.equal(removed.headers.get('Location'), '/')
    const saved = await reopened.get(article.id)
    assert.equal(saved?.inReadingList, false)
    assert.equal(saved?.markdown, article.markdown)
    assert.equal(saved?.image, article.image)
    assert.equal((await reopened.list()).length, 2)
    const html = await (await app.fetch(origin)).text()
    assert.doesNotMatch(html, new RegExp(`id="reading-menu-${article.id}"`))
    assert.match(html, /Add to reading list/)
    await store.setReadingList(article.id, true)
    await store.remove(article.id)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM reading_list').get()!.count, 0)
    assert.equal((await store.save(article.url)).article.inReadingList, false)
  })

  it('rejects cross-origin, invalid, oversized, and missing-article changes', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.save('https://articles.org/story')
    const app = createAppRouter(f.env, f.fetcher)
    const crossOrigin = update(article.id, 'true'); crossOrigin.headers.set('Origin', 'https://other.test')
    assert.equal((await app.fetch(crossOrigin)).status, 403)
    const crossSite = update(article.id, 'true'); crossSite.headers.set('Sec-Fetch-Site', 'cross-site')
    assert.equal((await app.fetch(crossSite)).status, 403)
    for (const value of ['', 'yes', 'x'.repeat(2048)]) assert.equal((await app.fetch(update(article.id, value))).status, 422)
    assert.equal((await app.fetch(update('missing', 'true'))).status, 404)
    assert.equal((await store.get(article.id))?.inReadingList, false)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM reading_list').get()!.count, 0)
  })

  it('preserves membership when the database cannot save a change', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.save('https://articles.org/story')
    await store.setReadingList(article.id, true)
    f.db.exec("CREATE TRIGGER stop_reading_list_change BEFORE DELETE ON reading_list BEGIN SELECT RAISE(ABORT, 'temporary database failure'); END")
    const response = await createAppRouter(f.env, f.fetcher).fetch(update(article.id, 'false'))
    assert.equal(response.status, 503)
    assert.match((await response.json() as { error: string }).error, /Could not update/)
    assert.equal((await store.get(article.id))?.inReadingList, true)
  })
})
