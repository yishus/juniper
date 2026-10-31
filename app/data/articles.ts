import type { AppEnv, Article, ArticleSummary, QuoteDraft, TranscriptCue } from './types.ts'
import { Text } from 'domhandler'
import { routes } from '../routes.ts'
import { extractArticle } from './extract.ts'
import { fetchPublic, readLimited, publicUrl, ImportError, type Fetcher } from './network.ts'
import { captureQuote, quoteMarkdown, xPost } from './quotes.ts'
import { validateNote } from '../actions/public/highlight-model.ts'
import { youtubeVideo } from '../actions/public/youtube.ts'
import { captureVideo, fetchVideoTranscript, parseTranscript, validateTranscript, videoMarkdown } from './videos.ts'
import { captureBookmark } from './bookmarks.ts'
import { and, desc, eq, exists, not, sql } from 'drizzle-orm'
import { database, readingListMembership } from './database.ts'
import { articleDeletions, readingList, savedArticles, videoTranscripts } from './schema.ts'
export class ArticleStore {
  private db: ReturnType<typeof database>
  constructor(private env: AppEnv, private userId: string, private fetcher: Fetcher = fetch) {
    if (!userId) throw new Error('An account is required')
    this.db = database(env.DB)
  }
  private owned(id: string) { return and(eq(savedArticles.id, id), eq(savedArticles.userId, this.userId)) }
  async list(): Promise<ArticleSummary[]> {
    const jobs = await this.db.select().from(articleDeletions).where(eq(articleDeletions.userId, this.userId)).limit(20).all()
    await Promise.all(jobs.map(job => this.cleanDeletedImages(job.articleId, job.imageKeys)))
    const results = await this.db.select({ summary: savedArticles.summary, inReadingList: readingListMembership(this.db) }).from(savedArticles)
      .where(eq(savedArticles.userId, this.userId)).orderBy(desc(savedArticles.savedAt), desc(savedArticles.id)).all()
    return results.map(row => ({ ...row.summary, inReadingList: row.inReadingList }))
  }
  async get(id: string): Promise<Article | null> {
    const row = await this.db.select({ summary: savedArticles.summary, markdown: savedArticles.markdown, text: savedArticles.text, inReadingList: readingListMembership(this.db) })
      .from(savedArticles).where(this.owned(id)).get()
    if (!row) return null
    const article: Article = { ...row.summary, userId: this.userId, markdown: row.markdown, text: row.text, inReadingList: row.inReadingList }
    if (article.kind === 'video') {
      const transcript = await this.db.select().from(videoTranscripts).where(eq(videoTranscripts.articleId, id)).get()
      article.transcript = transcript?.cues ?? []
    }
    return article
  }
  async setReadingList(id: string, included: boolean): Promise<ArticleSummary | null> {
    if (included) {
      await this.db.insert(readingList).select(this.db.select({ articleId: savedArticles.id }).from(savedArticles)
        .where(and(this.owned(id), sql`json_extract(${savedArticles.summary}, '$.kind')='article'`))).onConflictDoNothing().run()
    } else {
      await this.db.delete(readingList).where(and(eq(readingList.articleId, id), exists(this.db.select({ id: savedArticles.id }).from(savedArticles).where(this.owned(id))))).run()
    }
    const article = await this.get(id)
    if (!article) return null
    const { markdown, text, userId, transcript, ...summary } = article
    return summary
  }
  private async cleanDeletedImages(id: string, keys: string[]): Promise<boolean> {
    try {
      if (keys.length) await this.env.IMAGES.delete(keys)
      await this.db.delete(articleDeletions).where(and(eq(articleDeletions.articleId, id), eq(articleDeletions.userId, this.userId))).run()
      return true
    } catch { return false }
  }
  async remove(id: string): Promise<{ deleted: true; cleanupPending: boolean } | null> {
    const article = await this.get(id)
    const job = await this.db.select().from(articleDeletions).where(and(eq(articleDeletions.articleId, id), eq(articleDeletions.userId, this.userId))).get()
    if (!article && !job) return null
    let keys: string[] = job?.imageKeys ?? []
    if (article) {
      keys = [...new Set([...(article.markdown + (article.image ?? '')).matchAll(/\/images\/([\da-f-]{36})\/(\d+\.(?:jpg|png|webp|gif|avif))/g)]
        .filter(match => match[1] === id).map(match => `${id}/${match[2]}`))]
      // Retain cleanup work in the same transaction as the deletion. The database
      // cascades highlights/notes; R2 failures can be retried without losing file keys.
      await this.db.batch([
        this.db.insert(articleDeletions).values({ articleId: id, userId: this.userId, imageKeys: keys })
          .onConflictDoUpdate({ target: articleDeletions.articleId, set: { userId: this.userId, imageKeys: keys } }),
        this.db.delete(savedArticles).where(this.owned(id)),
      ])
    }
    return { deleted: true, cleanupPending: !await this.cleanDeletedImages(id, keys) }
  }
  private async find(url: string) {
    const row = await this.db.select({ id: savedArticles.id }).from(savedArticles).where(and(eq(savedArticles.url, url), eq(savedArticles.userId, this.userId))).get()
    return row ? this.get(row.id) : null
  }
  previewQuote(input: string, signal?: AbortSignal): Promise<QuoteDraft> {
    return captureQuote(input, this.fetcher, signal)
  }
  async saveQuote(input: QuoteDraft): Promise<{ article: Article; duplicate: boolean }> {
    const post = xPost(publicUrl(input.url).href)
    if (!post) throw new ImportError('Enter a link to an X post.')
    const text = input.text.replace(/\r\n?/g, '\n').trim()
    if (!text || text.length > 25_000) throw new ImportError('Enter quote text, up to 25,000 characters.')
    if (input.author.length > 200) throw new ImportError('Keep the author name under 200 characters.')
    let note: string
    try { note = validateNote(input.note) } catch (error) { throw new ImportError((error as Error).message) }
    const author = input.author.trim() || (post.handle ? `@${post.handle}` : null)
    const summary: ArticleSummary = {
      kind: 'quote', quote: { text, handle: post.handle, postId: post.postId, note },
      id: crypto.randomUUID(), url: post.url, title: text.replace(/\s+/g, ' ').slice(0, 120),
      description: text.slice(0, 240), author, site: 'X', savedAt: new Date().toISOString(),
      readingMinutes: 0, image: null, imageCount: 0, warnings: [], inReadingList: false,
    }
    await this.db.insert(savedArticles).values({ id: summary.id, userId: this.userId, url: summary.url, summary, markdown: quoteMarkdown(text, author, summary.url), text, savedAt: summary.savedAt }).onConflictDoNothing().run()
    const row = await this.db.select({ id: savedArticles.id }).from(savedArticles)
      .where(and(eq(savedArticles.userId, this.userId), sql`json_extract(${savedArticles.summary}, '$.quote.postId')=${post.postId}`)).get()
    const article = row ? await this.get(row.id) : await this.find(post.url)
    if (!article) throw new Error('Quote was not persisted')
    return { article, duplicate: article.id !== summary.id }
  }
  async updateQuoteNote(id: string, note: string): Promise<Article | null> {
    const value = validateNote(note)
    await this.db.update(savedArticles).set({ summary: sql`json_set(${savedArticles.summary}, '$.quote.note', ${value})` })
      .where(and(this.owned(id), sql`json_extract(${savedArticles.summary}, '$.kind')='quote'`)).run()
    const article = await this.get(id)
    return article?.kind === 'quote' ? article : null
  }
  async updateVideoNote(id: string, note: string): Promise<Article | null> {
    await this.db.update(savedArticles).set({ summary: sql`json_set(${savedArticles.summary}, '$.video.note', ${validateNote(note)})` })
      .where(and(eq(savedArticles.id, id), eq(savedArticles.userId, this.userId), sql`json_extract(${savedArticles.summary}, '$.kind')='video'`)).run()
    const article = await this.get(id)
    return article?.kind === 'video' ? article : null
  }
  async importTranscript(id: string, input: string): Promise<Article | null> {
    const article = await this.get(id)
    if (article?.kind !== 'video') return null
    const cues = parseTranscript(input, article.video!.duration)
    return this.saveTranscript(article, cues)
  }
  async retryTranscript(id: string, signal?: AbortSignal): Promise<Article | null> {
    const article = await this.get(id)
    if (article?.kind !== 'video') return null
    if (article.transcript?.length) return article
    const captured = await fetchVideoTranscript(article.url, this.fetcher, signal)
    if (!captured.transcript.length) throw new ImportError('YouTube did not provide captions for this video. Try again later or import subtitles below.')
    const duration = article.video!.duration ?? captured.duration
    const cues = validateTranscript(captured.transcript, duration)
    return this.saveTranscript({ ...article, video: { ...article.video!, duration } }, cues, true)
  }
  private async saveTranscript(article: Article, cues: TranscriptCue[], onlyIfMissing = false): Promise<Article | null> {
    const db = this.db
    const empty = sql`json_array_length(${videoTranscripts.cues})=0`
    const missing = not(exists(db.select({ articleId: videoTranscripts.articleId }).from(videoTranscripts)
      .where(and(eq(videoTranscripts.articleId, article.id), sql`json_array_length(${videoTranscripts.cues})>0`))))
    // Existing highlights retain their captured excerpt when the transcript changes.
    // A retry must not replace subtitles imported while its fetch was in flight.
    await db.batch([
      db.update(savedArticles).set({ markdown: videoMarkdown(article.title, article.url, cues) + (article.image ? `\n![Video thumbnail](${article.image})\n` : ''), text: cues.map(cue => cue.text).join('\n'),
        summary: sql`json_set(${savedArticles.summary}, '$.description', ${cues.map(cue => cue.text).join(' ').slice(0, 240)}, '$.video.duration', coalesce(json_extract(${savedArticles.summary}, '$.video.duration'), ${article.video!.duration}))`,
      }).where(and(this.owned(article.id), onlyIfMissing ? missing : undefined)),
      db.insert(videoTranscripts).select(db.select({ articleId: savedArticles.id, cues: sql`${JSON.stringify(cues)}`.as('cues') }).from(savedArticles)
        .where(this.owned(article.id)))
        .onConflictDoUpdate({ target: videoTranscripts.articleId, set: { cues }, setWhere: onlyIfMissing ? empty : undefined }),
    ])
    return this.get(article.id)
  }
  private async saveVideo(input: string, signal?: AbortSignal): Promise<{ article: Article; duplicate: boolean }> {
    const video = youtubeVideo(input)!
    const existing = await this.find(video.url)
    if (existing) return { article: existing, duplicate: true }
    const captured = await captureVideo(video.url, this.fetcher, signal)
    const id = crypto.randomUUID()
    const keys: string[] = []
    let image: string | null = null
    try {
      try {
        const { response } = await fetchPublic(`https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`, this.fetcher, signal)
        if (!/^image\/jpeg\b/i.test(response.headers.get('Content-Type') ?? '')) { await response.body?.cancel(); throw new Error('Invalid thumbnail') }
        const body = await readLimited(response, 5 * 1024 * 1024)
        const key = `${id}/1.jpg`
        await this.env.IMAGES.put(key, body, { httpMetadata: { contentType: 'image/jpeg' } })
        keys.push(key)
        image = routes.image.href({ id, file: '1.jpg' })
      } catch { /* Saving a video does not depend on its thumbnail. */ }
      if (signal?.aborted) throw new ImportError('The import was cancelled. Please try again.')
      const summary: ArticleSummary = {
        kind: 'video', video: { videoId: video.videoId, duration: captured.duration, note: '' },
        id, url: video.url, title: captured.title, author: captured.author, site: 'YouTube',
        description: captured.transcript.map(cue => cue.text).join(' ').slice(0, 240),
        savedAt: new Date().toISOString(), readingMinutes: 0, image, imageCount: keys.length, warnings: [], inReadingList: false,
      }
      const markdown = videoMarkdown(summary.title, summary.url, captured.transcript) + (image ? `\n![Video thumbnail](${image})\n` : '')
      const db = this.db
      await db.batch([
        db.insert(savedArticles).values({ id, userId: this.userId, url: summary.url, summary, markdown, text: captured.transcript.map(cue => cue.text).join('\n'), savedAt: summary.savedAt }).onConflictDoNothing(),
        db.insert(videoTranscripts).select(db.select({ articleId: savedArticles.id, cues: sql`${JSON.stringify(captured.transcript)}`.as('cues') }).from(savedArticles)
          .where(and(eq(savedArticles.id, id), eq(savedArticles.userId, this.userId)))),
      ])
      const article = await this.find(video.url)
      if (!article) throw new Error('Video was not persisted')
      if (article.id !== id && keys.length) await this.env.IMAGES.delete(keys)
      return { article, duplicate: article.id !== id }
    } catch (error) {
      if (keys.length) await this.env.IMAGES.delete(keys)
      throw error
    }
  }
  async saveBookmark(input: string, signal?: AbortSignal): Promise<{ article: Article; duplicate: boolean }> {
    const source = publicUrl(input.trim()).href
    const existing = await this.find(source)
    if (existing) return { article: existing, duplicate: true }
    const captured = await captureBookmark(source, this.fetcher, signal)
    const canonical = await this.find(captured.url)
    if (canonical) return { article: canonical, duplicate: true }
    const id = crypto.randomUUID()
    const keys: string[] = []
    let image: string | null = null
    try {
      if (captured.image) {
        try {
          const fetched = await fetchPublic(captured.image, this.fetcher, signal)
          const contentType = fetched.response.headers.get('Content-Type')?.split(';')[0].toLowerCase() ?? ''
          const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' } as Record<string, string>)[contentType]
          if (!extension) { await fetched.response.body?.cancel(); throw new Error('Unsupported preview') }
          const body = await readLimited(fetched.response, 5 * 1024 * 1024)
          const file = `1.${extension}`
          const key = `${id}/${file}`
          await this.env.IMAGES.put(key, body, { httpMetadata: { contentType } })
          keys.push(key)
          image = routes.image.href({ id, file })
        } catch { /* A preview image is optional. */ }
      }
      if (signal?.aborted) throw new ImportError('The import was cancelled. Please try again.')
      const summary: ArticleSummary = {
        kind: 'bookmark', id, url: captured.url, title: captured.title, site: captured.site, description: captured.description,
        author: null, savedAt: new Date().toISOString(), readingMinutes: 0, image, imageCount: keys.length, warnings: [], inReadingList: false,
      }
      const text = [summary.title, summary.description, summary.url].filter(Boolean).join('\n\n')
      const escape = (value: string) => value.replace(/[\\`*_[\]<>]/g, '\\$&')
      const markdown = `# ${escape(summary.title)}\n\nSource: ${summary.url}\n\n${escape(summary.description)}\n`
      await this.db.insert(savedArticles).values({ id, userId: this.userId, url: summary.url, summary, markdown, text, savedAt: summary.savedAt }).onConflictDoNothing().run()
      const winner = await this.find(summary.url)
      if (!winner) throw new Error('Bookmark was not persisted')
      if (winner.id !== id && keys.length) await this.env.IMAGES.delete(keys)
      return { article: winner, duplicate: winner.id !== id }
    } catch (error) {
      if (keys.length) await this.env.IMAGES.delete(keys)
      throw error
    }
  }
  async save(input: string, signal?: AbortSignal): Promise<{ article: Article; duplicate: boolean }> {
    const source = publicUrl(input.trim()).href
    if (xPost(source)) return this.saveQuote(await this.previewQuote(source, signal))
    if (youtubeVideo(source)) return this.saveVideo(source, signal)
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(new URL(source).hostname)) {
      throw new ImportError('Use a YouTube video link: watch, Shorts, live, embed, or youtu.be.')
    }
    const existing = await this.find(source)
    if (existing) return { article: existing, duplicate: true }
    const { response, url } = await fetchPublic(source, this.fetcher, signal)
    if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
      await response.body?.cancel()
      throw new ImportError('That URL is not an HTML article. Try a link to a web page.')
    }
    const canonical = await this.find(url)
    if (canonical) { await response.body?.cancel(); return { article: canonical, duplicate: true } }
    const html = new TextDecoder().decode(await readLimited(response, 2 * 1024 * 1024))
    const extracted = extractArticle(html, url)
    const id = crypto.randomUUID()
    const keys: string[] = []
    const warnings: string[] = []
    let thumbnail: string | null = null
    let bytes = 0
    let index = 0
    try {
      for (const [src, nodes] of extracted.images) {
        let local: string | null = null
        try {
          if (index >= 12 || bytes >= 24 * 1024 * 1024) throw new ImportError('Image limit reached')
          index++
          const { response: image } = await fetchPublic(src, this.fetcher, signal)
          const contentType = image.headers.get('Content-Type')?.split(';')[0].toLowerCase() ?? ''
          const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' } as Record<string, string>)[contentType]
          if (!extension) { await image.body?.cancel(); throw new ImportError('Unsupported image') }
          const body = await readLimited(image, Math.min(5 * 1024 * 1024, 24 * 1024 * 1024 - bytes))
          bytes += body.byteLength
          const key = `${id}/${index}.${extension}`
          await this.env.IMAGES.put(key, body, { httpMetadata: { contentType } })
          keys.push(key)
          local = routes.image.href({ id, file: `${index}.${extension}` })
          thumbnail ??= local
        } catch {
          for (const { node, alt } of nodes) {
            node.name = 'span'; node.children = [new Text(alt ? `[Image unavailable: ${alt}]` : '[Image unavailable]')]; node.attribs = {}
          }
          const alt = nodes.find(n => n.alt)?.alt
          warnings.push(alt ? `Image unavailable: ${alt.slice(0, 100)}` : 'An image could not be downloaded.')
        }
        if (local) for (const { node } of nodes) node.attribs.src = local
      }
      if (signal?.aborted) throw new ImportError('The import was cancelled. Please try again.')
      const summary: ArticleSummary = {
        kind: 'article',
        id, url, title: extracted.title, description: extracted.description,
        author: extracted.author, site: extracted.site, savedAt: new Date().toISOString(),
        readingMinutes: Math.max(1, Math.ceil(extracted.text.split(/\s+/).length / 225)),
        image: thumbnail, imageCount: keys.length, warnings, inReadingList: false,
      }
      const article: Article = { ...summary, userId: this.userId, markdown: extracted.markdown(), text: extracted.text }
      await this.db.insert(savedArticles).values({ id, userId: this.userId, url, summary, markdown: article.markdown, text: article.text, savedAt: summary.savedAt }).onConflictDoNothing().run()
      const winner = await this.find(url)
      if (!winner) throw new Error('Article was not persisted')
      if (winner.id !== id) await this.env.IMAGES.delete(keys)
      return { article: winner, duplicate: winner.id !== id }
    } catch (error) {
      if (keys.length) await this.env.IMAGES.delete(keys)
      throw error
    }
  }
}
