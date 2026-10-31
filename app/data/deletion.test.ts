import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { parseDocument } from 'htmlparser2'
import { findAll } from 'domutils'
import { isTag } from 'domhandler'
import { fixture } from '../../test/fixtures.ts'
import { ArticleStore } from './articles.ts'
import { HighlightStore } from './highlights.ts'
import { authenticatedRouter as createAppRouter } from '../../test/auth.ts'
import { routes } from '../routes.ts'

const origin = 'https://juniper.test'
function deletion(id: string, json = true) {
  return new Request(origin + routes.deleteArticle.href({ id }), { method: 'POST', headers: { Origin: origin, ...(json ? { Accept: 'application/json' } : {}) } })
}

describe('saved article deletion', () => {
  it('renders deletion inside the article popover and removes only the selected article and its saved data', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.save('https://articles.org/story')
    const { article: other } = await store.save('https://articles.org/other')
    const highlights = new HighlightStore(f.env.DB, f.userId)
    await highlights.create(article.id, { start: 0, end: 4, quote: 'text', note: 'A saved note' })
    await highlights.create(other.id, { start: 0, end: 4, quote: 'text', note: 'Keep this note' })
    const app = createAppRouter(f.env, f.fetcher)
    const html = await (await app.fetch(origin)).text()
    const doc = parseDocument(html)
    const form = findAll(node => node.name === 'form' && node.attribs.action === routes.deleteArticle.href({ id: article.id }), doc.children)[0]
    assert.ok(form)
    assert.ok(form.parent && isTag(form.parent) && form.parent.attribs.popover === 'auto', 'Delete form should be inside the actions popover, separate from the navigation link')
    const button = findAll(node => node.name === 'button', form.children)[0]
    assert.equal(button.attribs['aria-label'], `Delete ${article.title}`)
    const response = await app.fetch(deletion(article.id))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deleted: true, cleanupPending: false })
    assert.equal(await store.get(article.id), null)
    assert.equal((await store.list()).length, 1)
    assert.equal((await highlights.list(article.id)).length, 0)
    assert.equal((await highlights.list(other.id))[0].note, 'Keep this note')
    assert.equal(f.objects.size, 1)
    assert.ok([...f.objects.keys()].every(key => key.startsWith(other.id + '/')))
    for (const path of [routes.article.href({ id: article.id }), routes.markdown.href({ id: article.id }), article.image!]) {
      assert.equal((await app.fetch(origin + path)).status, 404)
    }
    const resaved = await store.save(article.url)
    assert.equal(resaved.duplicate, false)
    assert.notEqual(resaved.article.id, article.id)
  })
  it('redirects native form submissions and rejects cross-origin or missing-article deletion', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.save('https://articles.org/story')
    const app = createAppRouter(f.env, f.fetcher)
    const cross = deletion(article.id); cross.headers.set('Origin', 'https://other.org')
    assert.equal((await app.fetch(cross)).status, 403)
    assert.ok(await store.get(article.id))
    assert.equal(f.objects.size, 1)
    const native = await app.fetch(deletion(article.id, false))
    assert.equal(native.status, 303)
    assert.equal(native.headers.get('Location'), '/')
    assert.equal((await store.list()).length, 0)
    assert.equal(f.objects.size, 0)
    assert.equal((await app.fetch(deletion(article.id))).status, 404)
  })
  it('retries saved image cleanup after a temporary storage failure', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.save('https://articles.org/story')
    const remove = f.env.IMAGES.delete
    f.env.IMAGES.delete = async () => { throw new Error('Temporary R2 outage') }
    const app = createAppRouter(f.env, f.fetcher)
    const response = await app.fetch(deletion(article.id))
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { deleted: true, cleanupPending: true })
    assert.equal(await store.get(article.id), null)
    assert.equal((await store.list()).length, 0)
    assert.equal(f.objects.size, 1)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM article_deletions').get()!.count, 1)
    f.env.IMAGES.delete = remove
    await app.fetch(origin)
    assert.equal(f.objects.size, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM article_deletions').get()!.count, 0)
  })
  it('rolls back deletion work if the database write fails, preserving article data and files', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.save('https://articles.org/story')
    const highlights = new HighlightStore(f.env.DB, f.userId)
    await highlights.create(article.id, { start: 0, end: 4, quote: 'text', note: 'Keep this note' })
    f.db.exec("CREATE TRIGGER stop_deletion BEFORE DELETE ON articles BEGIN SELECT RAISE(ABORT, 'temporary database failure'); END")
    await assert.rejects(store.remove(article.id), /temporary database failure/)
    assert.ok(await store.get(article.id))
    assert.equal((await highlights.list(article.id))[0].note, 'Keep this note')
    assert.equal(f.objects.size, 1)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM article_deletions').get()!.count, 0)
    f.db.exec('DROP TRIGGER stop_deletion')
    assert.equal((await store.remove(article.id))?.deleted, true)
    assert.equal(f.objects.size, 0)
  })
})
