import { z } from 'zod'
import { embed } from './search-index.ts'
import type { AppEnv, ArticleSummary } from './types.ts'
import { routes } from '../routes.ts'
import { and, desc, eq, exists, gte, inArray, like, lte, notExists, or, sql, type SQL } from 'drizzle-orm'
import { database, readingListMembership } from './database.ts'
import { readingList, savedArticles, savedSearch, searchChunks, searchJobs } from './schema.ts'

const domain = z.string().max(253).transform(value => value.toLowerCase()).refine(value =>
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(value), 'Use a hostname such as example.com')
export const searchInput = z.object({
  query: z.string().trim().max(500).default(''),
  url: z.url().max(4096).optional(),
  domain: domain.optional(),
  savedAfter: z.iso.datetime({ offset: true }).optional(),
  savedBefore: z.iso.datetime({ offset: true }).optional(),
  inReadingList: z.boolean().optional(),
  kind: z.enum(['article', 'quote', 'video', 'bookmark']).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().max(8192).optional(),
}).strict()
export type SearchInput = z.input<typeof searchInput>

export interface SearchResult {
  kind: ArticleSummary['kind']
  id: string
  title: string
  url: string
  readerUrl: string
  author: string | null
  savedAt: string
  inReadingList: boolean
  excerpts: { text: string; source: 'article' | 'highlight'; sourceId: string }[]
}
export interface SearchResponse {
  results: SearchResult[]
  nextCursor: string | null
  mode: 'browse' | 'keyword' | 'hybrid'
  semanticUnavailable: boolean
  // Ranked retrieval examines bounded candidates. Browsing has no such window.
  candidateWindow: number | null
}

export class SearchInputError extends Error {}
export function encodeCursor(value: unknown): string {
  return btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), byte => String.fromCharCode(byte)).join(''))
}
export function decodeCursor(value: string): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)))) }
  catch { throw new SearchInputError('Invalid cursor. Start a new search.') }
}

type Row = { summary: ArticleSummary; inReadingList: boolean; excerpt?: string; sourceId?: string | null; chunkId?: string; kind?: 'article' | 'highlight' }

export class SearchStore {
  constructor(private env: AppEnv, private userId: string) {}
  async search(input: SearchInput, origin: string): Promise<SearchResponse> {
    const parsed = searchInput.parse(input)
    if (parsed.savedAfter && parsed.savedBefore && Date.parse(parsed.savedAfter) > Date.parse(parsed.savedBefore)) {
      throw new SearchInputError('savedAfter must be before savedBefore.')
    }
    const { cursor, limit, ...filters } = parsed
    const key = JSON.stringify({ userId: this.userId, ...filters })
    let offset = 0
    if (cursor) {
      const decoded = z.object({ v: z.literal(1), key: z.literal(key), offset: z.number().int().min(0).max(1_000_000) })
        .safeParse(decodeCursor(cursor))
      if (!decoded.success) throw new SearchInputError('This cursor does not match the search. Start a new search.')
      offset = decoded.data.offset
    }
    const db = database(this.env.DB)
    const summarySelect = { summary: savedArticles.summary, inReadingList: readingListMembership(db) }
    const clauses: SQL[] = [eq(savedArticles.userId, this.userId)]
    if (parsed.kind) clauses.push(sql`coalesce(json_extract(${savedArticles.summary}, '$.kind'), 'article')=${parsed.kind}`)
    if (parsed.url) {
      const url = new URL(parsed.url); url.hash = ''
      clauses.push(eq(savedArticles.url, url.href))
    }
    if (parsed.domain) {
      clauses.push(or(like(savedArticles.url, `https://${parsed.domain}/%`), like(savedArticles.url, `http://${parsed.domain}/%`))!)
    }
    if (parsed.savedAfter) clauses.push(gte(savedArticles.savedAt, new Date(parsed.savedAfter).toISOString()))
    if (parsed.savedBefore) clauses.push(lte(savedArticles.savedAt, new Date(parsed.savedBefore).toISOString()))
    if (parsed.inReadingList !== undefined) {
      const membership = db.select({ articleId: readingList.articleId }).from(readingList).where(eq(readingList.articleId, savedArticles.id))
      clauses.push(parsed.inReadingList ? exists(membership) : notExists(membership))
    }
    const where = and(...clauses)
    const toResult = (row: Row): SearchResult => {
      const article = row.summary
      return {
        kind: article.kind ?? 'article',
        id: article.id, title: article.title, url: article.url,
        readerUrl: new URL(routes.article.href({ id: article.id }), origin).href,
        author: article.author, savedAt: article.savedAt, inReadingList: row.inReadingList,
        excerpts: [{ text: (row.excerpt || article.description).slice(0, 700),
          source: row.kind ?? (row.sourceId && row.sourceId !== article.id ? 'highlight' : 'article'), sourceId: row.sourceId ?? article.id }],
      }
    }
    const page = (results: SearchResult[], mode: SearchResponse['mode'], semanticUnavailable = false): SearchResponse => ({
      results: results.slice(offset, offset + limit),
      nextCursor: results.length > offset + limit ? encodeCursor({ v: 1, key, offset: offset + limit }) : null,
      mode, semanticUnavailable, candidateWindow: mode === 'browse' ? null : 150,
    })
    if (!parsed.query) {
      const rows = await db.select(summarySelect).from(savedArticles).where(where)
        .orderBy(desc(savedArticles.savedAt), desc(savedArticles.id)).limit(limit + 1).offset(offset).all()
      return { results: rows.slice(0, limit).map(toResult),
        nextCursor: rows.length > limit ? encodeCursor({ v: 1, key, offset: offset + limit }) : null,
        mode: 'browse', semanticUnavailable: false, candidateWindow: null }
    }
    const terms = [...new Set(parsed.query.match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16)
    // FTS5 functions and MATCH remain SQL expressions; schema references, joins,
    // ownership filters, and bound values still go through Drizzle.
    const keyword = terms.length ? await db.select({ ...summarySelect, sourceId: savedSearch.sourceId,
      excerpt: sql<string>`snippet(${savedSearch}, 5, '', '', ' … ', 36)`,
    }).from(savedSearch).innerJoin(savedArticles, eq(savedArticles.id, savedSearch.articleId))
      .where(and(sql`${savedSearch} match ${terms.map(term => `"${term}"`).join(' OR ')}`, where))
      .orderBy(sql`bm25(${savedSearch}, 0, 0, 8, 3, 2, 1)`, desc(savedArticles.savedAt), desc(savedArticles.id)).limit(100).all() : []
    let semantic: Row[] = []
    let semanticUnavailable = !this.env.AI || !this.env.VECTORS
    if (this.env.AI && this.env.VECTORS) {
      try {
        const vectorFilter: Record<string, unknown> = {}
        // Vectorize indexes only the first 64 bytes of string metadata. Longer
        // hostnames are filtered in D1 rather than silently losing all matches.
        if (parsed.domain && new TextEncoder().encode(parsed.domain).length <= 64) vectorFilter.domain = { $eq: parsed.domain }
        if (parsed.savedAfter || parsed.savedBefore) vectorFilter.savedAt = {
          ...(parsed.savedAfter ? { $gte: Date.parse(parsed.savedAfter) } : {}),
          ...(parsed.savedBefore ? { $lte: Date.parse(parsed.savedBefore) } : {}),
        }
        const [vector] = await embed(this.env, [parsed.query])
        const { matches } = await this.env.VECTORS.query(vector, {
          namespace: this.userId, topK: 50, returnMetadata: 'none', ...(Object.keys(vectorFilter).length ? { filter: vectorFilter } : {}),
        })
        const ids = matches.filter(match => Number.isFinite(match.score)).map(match => match.id).slice(0, 50)
        if (ids.length) {
          // Resolve from D1 and hide pending revisions: stale vectors can never
          // disclose deleted articles, removed notes, or an incomplete reindex.
          const rows = await db.select({ ...summarySelect, excerpt: searchChunks.content, sourceId: searchChunks.sourceId, kind: searchChunks.kind, chunkId: searchChunks.id })
            .from(searchChunks).innerJoin(savedArticles, eq(savedArticles.id, searchChunks.articleId))
            .where(and(inArray(searchChunks.id, ids), eq(searchChunks.active, true), eq(searchChunks.indexed, true),
              notExists(db.select({ articleId: searchJobs.articleId }).from(searchJobs).where(eq(searchJobs.articleId, savedArticles.id))), where)).all()
          const byId = new Map(rows.map(row => [row.chunkId, row]))
          semantic = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
        }
      } catch (error) {
        semanticUnavailable = true
        console.error('Semantic search unavailable:', error instanceof Error ? error.name : 'Unknown error')
      }
    }
    const ranked = new Map<string, { result: SearchResult; score: number }>()
    for (const source of [keyword, semantic]) {
      const seen = new Set<string>()
      let rank = 0
      for (const row of source) {
        const result = toResult(row)
        let entry = ranked.get(result.id)
        if (!entry) { entry = { result, score: 0 }; ranked.set(result.id, entry) }
        if (!seen.has(result.id)) { entry.score += 1 / (60 + ++rank); seen.add(result.id) }
        const excerpt = result.excerpts[0]
        if (entry.result.excerpts.length < 2 && !entry.result.excerpts.some(existing => existing.text === excerpt.text)) entry.result.excerpts.push(excerpt)
      }
    }
    return page([...ranked.values()].sort((a, b) => b.score - a.score || b.result.savedAt.localeCompare(a.result.savedAt) || a.result.id.localeCompare(b.result.id))
      .map(entry => entry.result), semanticUnavailable ? 'keyword' : 'hybrid', semanticUnavailable)
  }
}
