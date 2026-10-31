import type { AppEnv } from './types.ts'
import type { Highlight, HighlightInput } from '../actions/public/highlight-model.ts'
import { and, asc, eq, exists, ne } from 'drizzle-orm'
import { database } from './database.ts'
import { savedArticles, savedHighlights } from './schema.ts'

export class HighlightStore {
  private db: ReturnType<typeof database>
  constructor(binding: AppEnv['DB'], private userId: string) { this.db = database(binding) }
  private owned(articleId: string) {
    return and(eq(savedHighlights.articleId, articleId), exists(this.db.select({ id: savedArticles.id }).from(savedArticles)
      .where(and(eq(savedArticles.id, articleId), eq(savedArticles.userId, this.userId)))))
  }
  async list(articleId: string): Promise<Highlight[]> {
    return this.db.select().from(savedHighlights).where(this.owned(articleId))
      .orderBy(asc(savedHighlights.start), asc(savedHighlights.createdAt), asc(savedHighlights.id)).all()
  }
  async get(articleId: string, id: string): Promise<Highlight | null> {
    return await this.db.select().from(savedHighlights).where(and(this.owned(articleId), eq(savedHighlights.id, id))).get() ?? null
  }
  async create(articleId: string, input: HighlightInput) {
    if (!await this.db.select({ id: savedArticles.id }).from(savedArticles).where(and(eq(savedArticles.id, articleId), eq(savedArticles.userId, this.userId))).get()) throw new Error('Article not found')
    const id = crypto.randomUUID()
    await this.db.insert(savedHighlights).values({ id, articleId, ...input, createdAt: new Date().toISOString() }).onConflictDoNothing().run()
    const highlight = await this.db.select().from(savedHighlights)
      .where(and(this.owned(articleId), eq(savedHighlights.start, input.start), eq(savedHighlights.end, input.end))).get()
    if (!highlight) throw new Error('Highlight could not be saved')
    return { highlight, duplicate: highlight.id !== id }
  }
  async updateNote(articleId: string, id: string, note: string) {
    if (!await this.get(articleId, id)) return null
    await this.db.update(savedHighlights).set({ note }).where(and(this.owned(articleId), eq(savedHighlights.id, id))).run()
    return this.get(articleId, id)
  }
  async updateSegment(articleId: string, id: string, input: HighlightInput) {
    if (!await this.get(articleId, id)) return null
    const duplicate = await this.db.select({ id: savedHighlights.id }).from(savedHighlights)
      .where(and(this.owned(articleId), eq(savedHighlights.start, input.start), eq(savedHighlights.end, input.end), ne(savedHighlights.id, id))).get()
    if (duplicate) throw new Error('This segment already has a highlight.')
    await this.db.update(savedHighlights).set(input).where(and(this.owned(articleId), eq(savedHighlights.id, id))).run()
    return this.get(articleId, id)
  }
  async remove(articleId: string, id: string) {
    if (!await this.get(articleId, id)) return false
    await this.db.delete(savedHighlights).where(and(this.owned(articleId), eq(savedHighlights.id, id))).run()
    return true
  }
}
