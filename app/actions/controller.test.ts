import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { authenticatedRouter as createAppRouter } from '../../test/auth.ts'
import { routes } from '../routes.ts'
import { fixture } from '../../test/fixtures.ts'
import type { Article } from '../data/types.ts'

const base = 'https://juniper.test'
function post(url: string, json = true) {
  const form = new FormData(); form.set('url', url)
  return new Request(base + routes.save.href(), { method: 'POST', body: form, headers: { Origin: base, ...(json ? { Accept: 'application/json' } : {}) } })
}

describe('root controller', () => {
  it('renders an empty library with a nav trigger and native popover save form', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const router = createAppRouter(f.env)
    const response = await router.fetch(base)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type') ?? '', /text\/html/)
    const html = await response.text()
    assert.match(html, /<html[\s>]/)
    assert.match(html, /Save your first item/)
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/articles"/)
    assert.match(html, /<button[^>]*id="add-article-trigger"[^>]*popovertarget="add-article"[^>]*aria-label="Add article or quote"[^>]*><svg/)
    assert.match(html, /<section[^>]*id="add-article"[^>]*popover="auto"[^>]*role="dialog"/)
    assert.match(html, /w-\[400px\]/)
    assert.doesNotMatch(html, /Welcome to|PromptButton/)
  })
  it('saves through the form, lists the article, and serves its saved text, Markdown, and images', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const app = createAppRouter(f.env, f.fetcher)
    const saved = await app.fetch(post('https://articles.org/story'))
    assert.equal(saved.status, 201)
    const result = await saved.json() as { article: Article; duplicate: boolean }
    assert.equal(result.duplicate, false)
    const html = await (await app.fetch(base)).text()
    assert.match(html, /The quiet web/)
    assert.match(html, new RegExp(`href="/articles/${result.article.id}"`))
    assert.doesNotMatch(html, /Download Markdown/)
    const detailResponse = await app.fetch(base + routes.article.href({ id: result.article.id }))
    assert.equal(detailResponse.status, 200)
    const reader = await detailResponse.text()
    assert.match(reader, /id="reader"/)
    assert.match(reader, /Reading slowly gives ideas room to grow/)
    assert.match(reader, /<h2>Keep a little space<\/h2>/)
    assert.match(reader, /<strong>reading without distractions<\/strong>/)
    assert.match(reader, /<ul>[\s\S]*?<li>Save a story<\/li>/)
    assert.match(reader, /<pre><code>const reading = true;/)
    assert.match(reader, /type="range" min="14" max="28"/)
    assert.match(reader, /Sans serif/)
    assert.match(reader, /<title>The quiet web — Juniper<\/title>/)
    assert.doesNotMatch(reader, /Download Markdown/)
    const legacy = await app.fetch(`${base}/?article=${result.article.id}`)
    assert.equal(legacy.status, 302)
    assert.equal(legacy.headers.get('Location'), routes.article.href({ id: result.article.id }))
    const markdown = await app.fetch(base + routes.markdown.href({ id: result.article.id }))
    assert.equal(markdown.status, 200)
    assert.match(markdown.headers.get('Content-Disposition') ?? '', /attachment; filename="The-quiet-web.md"/)
    assert.match(await markdown.text(), /## Keep a little space/)
    const image = await app.fetch(base + result.article.image!)
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('Content-Type'), 'image/png')
    assert.equal((await image.arrayBuffer()).byteLength, 4)
    const duplicate = await app.fetch(post('https://articles.org/story'))
    assert.equal(duplicate.status, 200)
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true)
  })
  it('redirects a native save and returns native validation failures on the library screen', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const app = createAppRouter(f.env, f.fetcher)
    const response = await app.fetch(post('https://articles.org/story', false))
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/')
    const rejected = await app.fetch(post('http://localhost/private', false))
    assert.equal(rejected.status, 422)
    const html = await rejected.text()
    assert.match(html, /Use a public/)
    assert.match(html, /The quiet web/)
  })
  it('rejects cross-origin saves and unsafe URLs without fetching them', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const app = createAppRouter(f.env, f.fetcher)
    const request = post('https://articles.org/story')
    request.headers.set('Origin', 'https://another.org')
    assert.equal((await app.fetch(request)).status, 403)
    assert.equal((await app.fetch(post('http://127.0.0.1/private'))).status, 422)
    assert.equal(f.requests.length, 0)
  })
  it('returns 404 for missing saved files and private server source assets', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const router = createAppRouter(f.env)
    for (const path of ['/articles/missing', '/articles/missing/markdown', '/images/missing/1.png', '/assets/app/data/articles.ts', '/assets/app/data/markdown.ts', '/assets/app/actions/controller.test.ts']) {
      assert.equal((await router.fetch(base + path)).status, 404)
    }
  })
})
