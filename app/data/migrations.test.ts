import * as assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { describe, it } from 'remix/test'
import { initialMigration } from '../../test/migrations.ts'
import { fixture, TEST_MCP_TOKEN } from '../../test/fixtures.ts'
import { searchFixture } from '../../test/search-fixtures.ts'
import { signIn } from '../../test/auth.ts'
import { createAppRouter } from '../router.ts'
import { ArticleStore } from './articles.ts'
import { HighlightStore } from './highlights.ts'
import { dispatchSearchJobs, indexArticle } from './search-index.ts'

describe('explicit D1 migrations', () => {
  it('upgrades existing saves without changing article content, highlights, or reading-list membership', t => {
    const db = new DatabaseSync(':memory:')
    t.after(() => db.close())
    db.exec('PRAGMA foreign_keys=ON')
    db.exec(readFileSync(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8'))
    db.prepare('INSERT INTO ba_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run('user', 'Reader', 'reader@example.com', 0, Date.now(), Date.now())
    const summary = { id: 'existing', title: 'A quiet article', author: 'Ada', url: 'https://articles.org/story' }
    db.prepare('INSERT INTO articles(id,user_id,url,summary,markdown,text,saved_at) VALUES (?,?,?,?,?,?,?)')
      .run('existing', 'user', summary.url, JSON.stringify(summary), '# A quiet article\n\nContent', 'Content', '2026-01-01T00:00:00Z')
    db.prepare('INSERT INTO reading_list(article_id) VALUES (?)').run('existing')
    db.prepare('INSERT INTO highlights(id,article_id,start_offset,end_offset,quote,note,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('highlight', 'existing', 0, 7, 'Content', 'Keep this', '2026-01-01T00:00:00Z')
    db.exec(readFileSync(new URL('../../migrations/0002_quotes.sql', import.meta.url), 'utf8'))
    db.exec(readFileSync(new URL('../../migrations/0003_videos.sql', import.meta.url), 'utf8'))
    const upgraded = db.prepare('SELECT * FROM articles WHERE id=?').get('existing')!
    assert.deepEqual(JSON.parse(upgraded.summary as string), { ...summary, kind: 'article' })
    assert.equal(upgraded.markdown, '# A quiet article\n\nContent')
    assert.equal(upgraded.text, 'Content')
    assert.equal(db.prepare('SELECT article_id FROM reading_list').get()!.article_id, 'existing')
    assert.equal(db.prepare('SELECT note FROM highlights').get()!.note, 'Keep this')
    assert.equal(db.prepare("SELECT count(*) AS n FROM saved_search WHERE saved_search MATCH 'quiet'").get()!.n, 2)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
  it('creates the full schema on an empty database and refuses to overwrite an existing schema', t => {
    const db = new DatabaseSync(':memory:')
    t.after(() => db.close())
    db.exec('PRAGMA foreign_keys=ON')
    db.exec(initialMigration)
    db.prepare('INSERT INTO ba_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run('user', 'Reader', 'reader@example.com', 0, Date.now(), Date.now())
    assert.throws(() => db.exec(initialMigration), /already exists/)
    assert.equal(db.prepare('SELECT count(*) AS n FROM ba_user').get()!.n, 1)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  })
  it('does not create missing tables during application queries', async t => {
    const f = fixture(); t.after(() => f.db.close())
    f.db.exec('DROP TABLE highlights; DROP TABLE reading_list; DROP TABLE articles')
    await assert.rejects(new ArticleStore(f.env, f.userId).list(), error => {
      assert.ok(error instanceof Error && error.cause instanceof Error)
      assert.match(error.cause.message, /no such table: articles/)
      return true
    })
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='articles'").get()!.n, 0)
  })
  it('serves browser and MCP requests and runs indexing without schema setup queries', async t => {
    const f = searchFixture(); t.after(() => f.db.close())
    const schema = () => f.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()
    const before = schema()
    const prepare = f.env.DB.prepare.bind(f.env.DB)
    f.env.DB.prepare = sql => {
      assert.doesNotMatch(sql, /^\s*(?:CREATE|ALTER|DROP|PRAGMA)\b/i)
      return prepare(sql)
    }
    const origin = f.env.BETTER_AUTH_URL!
    const app = createAppRouter(f.env)
    const cookie = await signIn(request => app.fetch(request), f.env)
    const articles = new ArticleStore(f.env, f.userId, f.fetcher)
    const article = (await articles.save('https://articles.org/story')).article
    await new HighlightStore(f.env.DB, f.userId).create(article.id, { start: 0, end: 4, quote: 'text', note: 'Migration test note' })
    await articles.setReadingList(article.id, true)
    await dispatchSearchJobs(f.env)
    assert.deepEqual(f.deliveries, [{ articleId: article.id }])
    let indexed = false
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!(await indexArticle(f.env, article.id)).retryAfter) { indexed = true; break }
    }
    assert.ok(indexed)
    for (const path of ['/', '/account', `/articles/${article.id}`]) {
      assert.equal((await app.fetch(new Request(origin + path, { headers: { Cookie: cookie } }))).status, 200)
    }
    const response = await app.fetch(new Request(origin + '/mcp', {
      method: 'POST', headers: { Authorization: `Bearer ${TEST_MCP_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_saved_urls', arguments: { query: 'quiet' } } }),
    }))
    assert.equal(response.status, 200)
    const data = await response.json() as { result: { structuredContent: { results: { id: string }[] } } }
    assert.equal(data.result.structuredContent.results[0].id, article.id)
    await articles.remove(article.id)
    assert.deepEqual(schema(), before)
  })
})
