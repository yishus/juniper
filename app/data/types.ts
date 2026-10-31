export interface ArticleSummary {
  kind: 'article' | 'quote' | 'video' | 'bookmark'
  quote?: { text: string; handle: string | null; postId: string; note: string }
  video?: { videoId: string; duration: number | null; note: string }
  id: string
  url: string
  title: string
  description: string
  author: string | null
  site: string
  savedAt: string
  readingMinutes: number
  image: string | null
  imageCount: number
  warnings: string[]
  inReadingList: boolean
}

export interface QuoteDraft {
  url: string
  text: string
  author: string
  note: string
  warning?: string
}

export interface Article extends ArticleSummary {
  userId: string
  markdown: string
  text: string
  transcript?: TranscriptCue[]
}

export interface TranscriptCue { start: number; end: number; text: string }

// The D1 statement methods used by this app.
interface Statement {
  bind(...values: (string | number | null)[]): Statement
  run(): Promise<unknown>
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  raw<T = unknown[]>(): Promise<T[]>
}
export interface AppEnv {
  AUTH_ALLOWED_EMAILS?: string
  BETTER_AUTH_URL?: string
  BETTER_AUTH_SECRET?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
  AI?: {
    run(model: '@cf/baai/bge-m3', input: { text: string[] }): Promise<{ data: number[][] }>
  }
  VECTORS?: {
    upsert(vectors: { id: string; namespace: string; values: number[]; metadata: { articleId: string; domain: string; savedAt: number } }[]): Promise<unknown>
    deleteByIds(ids: string[]): Promise<unknown>
    query(vector: number[], options: { namespace: string; topK: number; returnMetadata: 'none'; filter?: Record<string, unknown> }): Promise<{ matches: { id: string; score: number }[] }>
  }
  SEARCH_QUEUE?: { sendBatch(messages: { body: { articleId: string } }[]): Promise<unknown> }
  DB: { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown> }
  IMAGES: {
    put(key: string, body: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>
    get(key: string): Promise<{
      body: ReadableStream<Uint8Array>
      httpMetadata?: { contentType?: string }
      httpEtag: string
    } | null>
    delete(keys: string[]): Promise<unknown>
  }
}
