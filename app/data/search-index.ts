import { ArticleStore } from './articles.ts'
import { HighlightStore } from './highlights.ts'
import type { Highlight } from '../actions/public/highlight-model.ts'
import type { AppEnv, Article } from './types.ts'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { batchWrites, database } from './database.ts'
import { savedArticles, searchChunks, searchJobs } from './schema.ts'

export const EMBEDDING_MODEL = '@cf/baai/bge-m3'
export const EMBEDDING_DIMENSIONS = 1024
const INDEX_VERSION = 'bge-m3-passages-v1'
const embeddingBatchSize = 8
const leaseMilliseconds = 10 * 60_000

export interface Passage {
  id: string
  articleId: string
  sourceId: string
  kind: 'article' | 'highlight'
  content: string
  embeddingText: string
}

// Character bounds also work for scripts without whitespace. Paragraph/heading
// boundaries take priority; a small overlap preserves context across long blocks.
export function splitPassages(markdown: string): { heading: string; content: string }[] {
  const result: { heading: string; content: string }[] = []
  let heading = ''
  let buffer = ''
  const flush = () => {
    if (buffer.trim()) result.push({ heading, content: buffer.trim() })
    buffer = ''
  }
  for (const block of markdown.replace(/!\[[^\]]*\]\([^\n]*?\)/g, '').split(/\n\s*\n/)) {
    if (!block.trim()) continue
    const title = /^#{1,6}\s+([^\n]+)/.exec(block)
    if (title) { flush(); heading = title[1].slice(0, 256) }
    if (buffer.length + block.length + 2 > 2000) flush()
    let rest = block.trim()
    while (rest.length > 2000) {
      let end = rest.lastIndexOf(' ', 2000)
      if (end < 1400) end = 2000
      // Never split a UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--
      result.push({ heading, content: rest.slice(0, end) })
      let start = end - 160
      if (/[\uDC00-\uDFFF]/.test(rest[start])) start++
      rest = rest.slice(start)
    }
    buffer += (buffer ? '\n\n' : '') + rest
  }
  flush()
  return result
}

export async function articlePassages(article: Article, highlights: Highlight[]): Promise<Passage[]> {
  const sources = [
    { id: article.id, kind: 'article' as const, text: article.markdown + ((article.video?.note || article.quote?.note) ? `\n\nPersonal note:\n${article.video?.note || article.quote?.note}` : '') },
    ...highlights.map(highlight => ({ id: highlight.id, kind: 'highlight' as const,
      text: `Highlighted passage:\n${highlight.quote}${highlight.note ? `\n\nPersonal note:\n${highlight.note}` : ''}` })),
  ]
  const passages: Passage[] = []
  for (const source of sources) {
    for (const { heading, content } of splitPassages(source.text)) {
      const embeddingText = `${article.title.slice(0, 256)}\n${heading}\n${content}`
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${INDEX_VERSION}\n${source.id}\n${embeddingText}`))
      const suffix = Array.from(new Uint8Array(hash).slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('')
      passages.push({ id: `${article.id}:${suffix}`, articleId: article.id, sourceId: source.id, kind: source.kind, content, embeddingText })
    }
  }
  return [...new Map(passages.map(passage => [passage.id, passage])).values()]
}

export async function embed(env: AppEnv, texts: string[]): Promise<number[][]> {
  if (!env.AI) throw new Error('Workers AI is not configured')
  const response = await env.AI.run(EMBEDDING_MODEL, { text: texts })
  if (!Array.isArray(response.data) || response.data.length !== texts.length || response.data.some(vector =>
    !Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || vector.some(value => !Number.isFinite(value)))) {
    throw new Error('Workers AI returned invalid embeddings')
  }
  return response.data
}

// A bounded amount of work per delivery keeps large imports and retries cheap.
// Completed passage embeddings are retained across retries and note edits.
export async function indexArticle(env: AppEnv, articleId: string): Promise<{ retryAfter?: number }> {
  const db = database(env.DB)
  const owner = await db.select({ userId: savedArticles.userId }).from(savedArticles).where(eq(savedArticles.id, articleId)).get()
  const store = new ArticleStore(env, owner?.userId ?? '__deleted__')
  if (!env.VECTORS) return { retryAfter: 300 }
  const now = Date.now()
  const token = crypto.randomUUID()
  const job = await db.update(searchJobs).set({ leaseToken: token, leaseUntil: now + leaseMilliseconds })
    .where(and(eq(searchJobs.articleId, articleId), lte(searchJobs.leaseUntil, now), lte(searchJobs.availableAt, now)))
    .returning({ revision: searchJobs.revision, attempts: searchJobs.attempts }).get()
  if (!job) {
    const pending = await db.select({ availableAt: searchJobs.availableAt, leaseUntil: searchJobs.leaseUntil }).from(searchJobs).where(eq(searchJobs.articleId, articleId)).get()
    return pending ? { retryAfter: Math.max(5, Math.ceil((Math.max(pending.availableAt, pending.leaseUntil) - now) / 1000)) } : {}
  }
  try {
    const article = await store.get(articleId)
    if (article && !env.AI) return { retryAfter: 300 }
    if (article) {
      const passages = await articlePassages(article, await new HighlightStore(env.DB, article.userId).list(articleId))
      const current = await db.select({ revision: searchJobs.revision }).from(searchJobs).where(eq(searchJobs.articleId, articleId)).get()
      if (current?.revision !== job.revision) return { retryAfter: 5 }
      const existing = await db.select({ id: searchChunks.id, active: searchChunks.active }).from(searchChunks).where(eq(searchChunks.articleId, articleId)).all()
      const wanted = new Set(passages.map(passage => passage.id))
      const previous = new Map(existing.map(passage => [passage.id, passage]))
      const statements = [
        ...existing.filter(passage => passage.active && !wanted.has(passage.id))
          .map(passage => db.update(searchChunks).set({ active: false }).where(eq(searchChunks.id, passage.id))),
        ...passages.filter(passage => !previous.get(passage.id)?.active).map(passage =>
          db.insert(searchChunks).values({ id: passage.id, articleId, sourceId: passage.sourceId, kind: passage.kind, content: passage.content, embeddingText: passage.embeddingText })
            .onConflictDoUpdate({ target: searchChunks.id, set: { active: true } })),
      ]
      await batchWrites(db, statements)
    }
    const obsolete = await db.select({ id: searchChunks.id }).from(searchChunks)
      .where(and(eq(searchChunks.articleId, articleId), article ? eq(searchChunks.active, false) : undefined)).limit(32).all()
    if (obsolete.length) {
      await env.VECTORS.deleteByIds(obsolete.map(passage => passage.id))
      await db.delete(searchChunks).where(inArray(searchChunks.id, obsolete.map(passage => passage.id))).run()
      return { retryAfter: 5 }
    }
    if (article) {
      const pending = await db.select({ id: searchChunks.id, embeddingText: searchChunks.embeddingText }).from(searchChunks)
        .where(and(eq(searchChunks.articleId, articleId), eq(searchChunks.active, true), eq(searchChunks.indexed, false)))
        .orderBy(asc(searchChunks.id)).limit(embeddingBatchSize).all()
      if (pending.length) {
        const values = await embed(env, pending.map(passage => passage.embeddingText))
        await env.VECTORS.upsert(pending.map((passage, i) => ({ id: passage.id, namespace: article.userId, values: values[i], metadata: {
          articleId, domain: new URL(article.url).hostname, savedAt: Date.parse(article.savedAt),
        } })))
        await db.update(searchChunks).set({ indexed: true }).where(inArray(searchChunks.id, pending.map(passage => passage.id))).run()
      }
      if (await db.select({ id: searchChunks.id }).from(searchChunks)
        .where(and(eq(searchChunks.articleId, articleId), eq(searchChunks.active, true), eq(searchChunks.indexed, false))).limit(1).get()) {
        return { retryAfter: 5 }
      }
    }
    // A source edit/deletion during inference changes revision. Leave that job
    // queued so its subsequent cleanup runs after this delivery releases its lease.
    const removed = await db.delete(searchJobs).where(and(eq(searchJobs.articleId, articleId), eq(searchJobs.revision, job.revision), eq(searchJobs.leaseToken, token)))
      .returning({ articleId: searchJobs.articleId }).get()
    return removed ? {} : { retryAfter: 5 }
  } catch (error) {
    const retryAfter = Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7))
    await db.update(searchJobs).set({ attempts: sql`${searchJobs.attempts}+1`, availableAt: Date.now() + retryAfter * 1000,
      lastError: error instanceof Error ? error.message.slice(0, 200) : 'Indexing failed',
    }).where(and(eq(searchJobs.articleId, articleId), eq(searchJobs.revision, job.revision), eq(searchJobs.leaseToken, token))).run()
    return { retryAfter }
  } finally {
    await db.update(searchJobs).set({ leaseToken: null, leaseUntil: 0 }).where(and(eq(searchJobs.articleId, articleId), eq(searchJobs.leaseToken, token))).run()
  }
}

export async function dispatchSearchJobs(env?: AppEnv) {
  if (!env?.SEARCH_QUEUE || !env.VECTORS || !env.AI) return
  const now = Date.now()
  const results = await database(env.DB).select({ articleId: searchJobs.articleId }).from(searchJobs)
    .where(and(lte(searchJobs.availableAt, now), lte(searchJobs.leaseUntil, now))).orderBy(asc(searchJobs.availableAt), asc(searchJobs.articleId)).limit(10).all()
  if (results.length) await env.SEARCH_QUEUE.sendBatch(results.map(job => ({ body: { articleId: job.articleId } })))
}

export interface SearchQueueBatch {
  messages: { body: unknown; ack(): void; retry(options: { delaySeconds: number }): void }[]
}

export async function consumeSearchQueue(batch: SearchQueueBatch, env: AppEnv) {
  for (const message of batch.messages) {
    const body = message.body as { articleId?: unknown } | null
    if (!body || typeof body.articleId !== 'string' || !/^[\da-f-]{36}$/.test(body.articleId)) { message.ack(); continue }
    const result = await indexArticle(env, body.articleId)
    if (result.retryAfter) message.retry({ delaySeconds: result.retryAfter })
    else message.ack()
  }
}
