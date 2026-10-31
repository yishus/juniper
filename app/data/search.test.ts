import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { ArticleStore } from './articles.ts'
import { HighlightStore } from './highlights.ts'
import { SearchStore, SearchInputError } from './search.ts'
import { articlePassages, indexArticle, dispatchSearchJobs, consumeSearchQueue, splitPassages, EMBEDDING_MODEL } from './search-index.ts'
import { fixture } from '../../test/fixtures.ts'
import { searchFixture } from '../../test/search-fixtures.ts'

const origin = 'https://juniper.test'
async function finishIndex(f: ReturnType<typeof searchFixture>, id: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await indexArticle(f.env, id)).retryAfter) return
  }
  assert.fail('Index did not finish')
}

describe('saved library search', () => {
  it('isolates semantic namespaces and rejects another account’s vectors even if returned by the index', async t => {
    const f = searchFixture(); t.after(() => f.db.close())
    const first = new ArticleStore(f.env, f.userId, f.fetcher)
    const article = (await first.save('https://articles.org/story')).article
    await first.save('https://articles.org/another')
    await finishIndex(f, article.id)
    const secondId = crypto.randomUUID()
    const second = new SearchStore(f.env, secondId)
    assert.equal((await second.search({ query: 'complexity' }, origin)).results.length, 0)
    assert.equal(f.queries.at(-1)!.namespace, secondId)
    assert.ok([...f.vectors.values()].every(vector => vector.namespace === f.userId))
    f.env.VECTORS!.query = async () => ({ matches: [...f.vectors.keys()].map(id => ({ id, score: 1 })) })
    assert.equal((await second.search({ query: 'complexity' }, origin)).results.length, 0)
    const cursor = (await new SearchStore(f.env, f.userId).search({ limit: 1 }, origin)).nextCursor!
    await assert.rejects(second.search({ limit: 1, cursor }, origin), /cursor/)
  })
  it('finds body text and personal notes immediately without AI, applies filters, and paginates browsing', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const first = (await store.save('https://articles.org/story')).article
    const second = (await store.save('https://elsewhere.org/other')).article
    await store.setReadingList(first.id, true)
    const notes = new HighlightStore(f.env.DB, f.userId)
    const { highlight } = await notes.create(first.id, { start: 0, end: 4, quote: 'text', note: 'A nebula in my personal notes' })
    const search = new SearchStore(f.env, f.userId)
    assert.equal((await search.search({ query: 'distractions', domain: 'articles.org', inReadingList: true }, origin)).results[0].id, first.id)
    const foundNote = await search.search({ query: 'nebula' }, origin)
    assert.equal(foundNote.mode, 'keyword')
    assert.equal(foundNote.semanticUnavailable, true)
    assert.equal(foundNote.results[0].excerpts[0].source, 'highlight')
    assert.match(foundNote.results[0].excerpts[0].text, /nebula/)
    assert.equal((await search.search({ query: 'nebula', domain: 'elsewhere.org' }, origin)).results.length, 0)
    assert.equal((await search.search({ url: first.url + '#section' }, origin)).results[0].id, first.id)
    assert.equal((await search.search({ savedAfter: '2099-01-01T00:00:00Z' }, origin)).results.length, 0)
    const page = await search.search({ limit: 1 }, origin)
    assert.ok(page.nextCursor)
    const next = await search.search({ limit: 1, cursor: page.nextCursor }, origin)
    assert.equal(next.nextCursor, null)
    assert.notEqual(page.results[0].id, next.results[0].id)
    assert.deepEqual(new Set([page.results[0].id, next.results[0].id]), new Set([first.id, second.id]))
    await notes.updateNote(first.id, highlight.id, 'A comet instead')
    assert.equal((await search.search({ query: 'nebula' }, origin)).results.length, 0)
    assert.equal((await search.search({ query: 'comet' }, origin)).results.length, 1)
    await store.remove(first.id)
    assert.equal((await search.search({ query: 'comet' }, origin)).results.length, 0)
    await assert.rejects(search.search({ cursor: 'invalid' }, origin), SearchInputError)
    await assert.rejects(search.search({ domain: 'elsewhere.org', cursor: page.nextCursor }, origin), /cursor/)
    await assert.rejects(search.search({ savedAfter: '2026-01-01T00:00:00Z', savedBefore: '2025-01-01T00:00:00Z' }, origin), /before/)
    // Query syntax is treated as words, never raw FTS operators or SQL.
    await search.search({ query: '" OR NOT * : ( \' --' }, origin)
  })
  it('rolls back search changes with a failed source deletion', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const article = (await store.save('https://articles.org/story')).article
    // Use a new binding identity, as on a fresh Worker isolate.
    const env = { ...f.env, DB: { ...f.env.DB } }
    const search = new SearchStore(env, f.userId)
    assert.equal((await search.search({ query: 'quiet' }, origin)).results.length, 1)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM search_jobs').get()!.n, 1)
    f.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON articles BEGIN SELECT RAISE(ABORT, 'failed'); END")
    await assert.rejects(store.remove(article.id), /failed/)
    assert.equal((await search.search({ query: 'quiet' }, origin)).results.length, 1)
  })
  it('adds semantic matches, groups passages by article, and falls back when AI is unavailable', async t => {
    const f = searchFixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const article = (await store.save('https://articles.org/story')).article
    f.db.prepare('UPDATE articles SET markdown=?, text=? WHERE id=?')
      .run('## Deploy less\n\nReduce operational overhead with fewer moving parts.', 'Reduce operational overhead with fewer moving parts.', article.id)
    await finishIndex(f, article.id)
    const result = await new SearchStore(f.env, f.userId).search({ query: 'complexity', domain: 'articles.org', savedAfter: '2020-01-01T00:00:00Z' }, origin)
    assert.equal(result.mode, 'hybrid')
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].id, article.id)
    assert.match(result.results[0].excerpts[0].text, /operational/)
    assert.match(result.results[0].readerUrl, /https:\/\/juniper.test\/articles\//)
    assert.deepEqual(f.queries[0].filter, { domain: { $eq: 'articles.org' }, savedAt: { $gte: Date.parse('2020-01-01T00:00:00Z') } })
    assert.equal(f.embeddings.at(-1)![0], 'complexity')
    f.env.AI!.run = async () => { throw new Error('Quota exceeded') }
    const fallback = await new SearchStore(f.env, f.userId).search({ query: 'operational' }, origin)
    assert.equal(fallback.mode, 'keyword')
    assert.equal(fallback.semanticUnavailable, true)
    assert.equal(fallback.results[0].id, article.id)
  })
})

describe('semantic indexing lifecycle', () => {
  it('bounds chunks including CJK text and uses stable, valid Vectorize IDs', async t => {
    const f = fixture(); t.after(() => f.db.close())
    const article = (await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')).article
    const chunks = splitPassages('## Heading\n\n' + '文字😀'.repeat(2000))
    assert.ok(chunks.length > 2)
    assert.ok(chunks.every(chunk => chunk.content.length <= 2000 && chunk.heading === 'Heading'))
    const first = await articlePassages(article, [])
    assert.deepEqual(await articlePassages(article, []), first)
    assert.ok(first.every(passage => passage.id.length <= 64))
  })
  it('reuses embeddings on duplicate deliveries and note edits, and durably retries AI failures', async t => {
    const f = searchFixture(); t.after(() => f.db.close())
    const article = (await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')).article
    const run = f.env.AI!.run
    let model = ''
    f.env.AI!.run = async (selected, input) => { model = selected; return run(selected, input) }
    await dispatchSearchJobs(f.env)
    assert.deepEqual(f.deliveries, [{ articleId: article.id }])
    await finishIndex(f, article.id)
    assert.equal(model, EMBEDDING_MODEL)
    const initial = f.embeddings.flat().length
    await finishIndex(f, article.id)
    assert.equal(f.embeddings.flat().length, initial)
    const notes = new HighlightStore(f.env.DB, f.userId)
    const { highlight } = await notes.create(article.id, { start: 0, end: 4, quote: 'text', note: 'An original note' })
    await finishIndex(f, article.id)
    assert.equal(f.embeddings.flat().length, initial + 1)
    await notes.updateNote(article.id, highlight.id, 'A changed note')
    f.env.AI!.run = async () => { throw new Error('Temporary inference outage') }
    // First delivery removes the old note vector; the next tries its replacement.
    await indexArticle(f.env, article.id)
    const failed = await indexArticle(f.env, article.id)
    assert.ok(failed.retryAfter! >= 30)
    assert.equal(f.db.prepare('SELECT attempts FROM search_jobs WHERE article_id=?').get(article.id)!.attempts, 1)
    f.env.AI!.run = run
    f.db.prepare('UPDATE search_jobs SET available_at=0 WHERE article_id=?').run(article.id)
    await finishIndex(f, article.id)
    assert.equal(f.embeddings.flat().length, initial + 2)
    assert.equal([...f.vectors.values()].filter(vector => vector.metadata.articleId === article.id).length, initial + 1)
  })
  it('retains progress across embedding batches and rejects malformed AI responses', async t => {
    const f = searchFixture(); t.after(() => f.db.close())
    const article = (await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')).article
    f.db.prepare('UPDATE articles SET markdown=? WHERE id=?').run(Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\n${'Long paragraph. '.repeat(100)}`).join('\n\n'), article.id)
    const run = f.env.AI!.run
    f.env.AI!.run = async () => ({ data: [[1, 2]] })
    assert.ok((await indexArticle(f.env, article.id)).retryAfter)
    assert.equal(f.vectors.size, 0)
    f.env.AI!.run = run
    f.db.prepare('UPDATE search_jobs SET available_at=0').run()
    assert.ok((await indexArticle(f.env, article.id)).retryAfter)
    assert.equal(f.embeddings[0].length, 8)
    await finishIndex(f, article.id)
    assert.equal(f.embeddings.flat().length, 12)
    assert.equal(f.vectors.size, 12)
  })
  it('hides deleted data immediately and retries vector cleanup without re-embedding', async t => {
    const f = searchFixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const article = (await store.save('https://articles.org/story')).article
    await finishIndex(f, article.id)
    assert.ok(f.vectors.size)
    await store.remove(article.id)
    assert.equal((await new SearchStore(f.env, f.userId).search({ query: 'quiet' }, origin)).results.length, 0)
    const remove = f.env.VECTORS!.deleteByIds
    f.env.VECTORS!.deleteByIds = async () => { throw new Error('Vectorize unavailable') }
    assert.ok((await indexArticle(f.env, article.id)).retryAfter)
    assert.ok(f.vectors.size)
    f.env.VECTORS!.deleteByIds = remove
    f.db.prepare('UPDATE search_jobs SET available_at=0').run()
    await finishIndex(f, article.id)
    assert.equal(f.vectors.size, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM search_chunks').get()!.n, 0)
  })
  it('cleans up a deletion racing with inference, and does not run concurrent duplicate jobs', async t => {
    const f = searchFixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const article = (await store.save('https://articles.org/story')).article
    const run = f.env.AI!.run
    let duplicateRetry = 0
    f.env.AI!.run = async (model, input) => {
      duplicateRetry = (await indexArticle(f.env, article.id)).retryAfter!
      await store.remove(article.id)
      return run(model, input)
    }
    assert.ok((await indexArticle(f.env, article.id)).retryAfter)
    assert.ok(duplicateRetry > 0)
    assert.ok(f.vectors.size)
    assert.equal((await new SearchStore(f.env, f.userId).search({ query: 'quiet' }, origin)).results.length, 0)
    await finishIndex(f, article.id)
    assert.equal(f.vectors.size, 0)
  })
  it('acknowledges invalid/completed queue messages and retries pending work', async t => {
    const f = searchFixture(); t.after(() => f.db.close())
    const article = (await new ArticleStore(f.env, f.userId, f.fetcher).save('https://articles.org/story')).article
    let acknowledgements = 0
    let retries = 0
    f.env.AI!.run = async () => { throw new Error('Quota exceeded') }
    await consumeSearchQueue({ messages: [
      { body: { articleId: article.id }, ack() { acknowledgements++ }, retry() { retries++ } },
      { body: { articleId: 'invalid' }, ack() { acknowledgements++ }, retry() { retries++ } },
    ] }, f.env)
    assert.equal(acknowledgements, 1)
    assert.equal(retries, 1)
  })
})
