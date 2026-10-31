import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { ArticleSummary, TranscriptCue } from './types.ts'

// These declarations map the existing D1 schema. Numbered SQL migrations remain
// responsible for applying schema changes, including FTS and search triggers.
// Auth dates stay ISO text to preserve records written by the previous adapter.
export const authUsers = sqliteTable('ba_user', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull(), image: text('image'),
  createdAt: text('createdAt').notNull(), updatedAt: text('updatedAt').notNull(),
})
export const authSessions = sqliteTable('ba_session', {
  id: text('id').primaryKey(), expiresAt: text('expiresAt').notNull(), token: text('token').notNull().unique(),
  createdAt: text('createdAt').notNull(), updatedAt: text('updatedAt').notNull(), ipAddress: text('ipAddress'), userAgent: text('userAgent'),
  userId: text('userId').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
}, table => [index('ba_session_userId_idx').on(table.userId)])
export const authAccounts = sqliteTable('ba_account', {
  id: text('id').primaryKey(), accountId: text('accountId').notNull(), providerId: text('providerId').notNull(),
  userId: text('userId').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'), refreshToken: text('refreshToken'), idToken: text('idToken'),
  accessTokenExpiresAt: text('accessTokenExpiresAt'), refreshTokenExpiresAt: text('refreshTokenExpiresAt'),
  scope: text('scope'), password: text('password'), createdAt: text('createdAt').notNull(), updatedAt: text('updatedAt').notNull(),
}, table => [index('ba_account_userId_idx').on(table.userId)])
export const authVerifications = sqliteTable('ba_verification', {
  id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(),
  expiresAt: text('expiresAt').notNull(), createdAt: text('createdAt').notNull(), updatedAt: text('updatedAt').notNull(),
}, table => [index('ba_verification_identifier_idx').on(table.identifier)])
export const authRateLimits = sqliteTable('ba_rate_limit', {
  id: text('id').primaryKey(), key: text('key').notNull().unique(), count: integer('count').notNull(), lastRequest: integer('lastRequest').notNull(),
})
export const mcpTokens = sqliteTable('auth_mcp_tokens', {
  userId: text('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(), createdAt: text('created_at').notNull(),
})
export const savedArticles = sqliteTable('articles', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  url: text('url').notNull(),
  summary: text('summary', { mode: 'json' }).$type<ArticleSummary>().notNull(),
  markdown: text('markdown').notNull(),
  text: text('text').notNull(),
  savedAt: text('saved_at').notNull(),
}, table => [
  unique().on(table.userId, table.url),
  index('articles_owner_saved').on(table.userId, table.savedAt, table.id),
  uniqueIndex('quotes_post_per_account').on(table.userId, sql`json_extract(${table.summary}, '$.quote.postId')`).where(sql`json_extract(${table.summary}, '$.kind')='quote'`),
  uniqueIndex('videos_per_account').on(table.userId, sql`json_extract(${table.summary}, '$.video.videoId')`).where(sql`json_extract(${table.summary}, '$.kind')='video'`),
])

export const savedHighlights = sqliteTable('highlights', {
  id: text('id').primaryKey(), articleId: text('article_id').notNull().references(() => savedArticles.id, { onDelete: 'cascade' }),
  start: integer('start_offset').notNull(), end: integer('end_offset').notNull(), quote: text('quote').notNull(),
  note: text('note').notNull().default(''), createdAt: text('created_at').notNull(),
}, table => [unique().on(table.articleId, table.start, table.end)])
export const readingList = sqliteTable('reading_list', {
  articleId: text('article_id').primaryKey().references(() => savedArticles.id, { onDelete: 'cascade' }),
})
export const articleDeletions = sqliteTable('article_deletions', {
  articleId: text('article_id').primaryKey(), userId: text('user_id').notNull(), imageKeys: text('image_keys', { mode: 'json' }).$type<string[]>().notNull(),
})
// Jobs and chunks deliberately outlive articles so deleted vectors can be cleaned up.
export const searchJobs = sqliteTable('search_jobs', {
  articleId: text('article_id').primaryKey(), revision: text('revision').notNull(), attempts: integer('attempts').notNull().default(0),
  availableAt: integer('available_at').notNull().default(0), leaseUntil: integer('lease_until').notNull().default(0),
  leaseToken: text('lease_token'), lastError: text('last_error'),
})
export const searchChunks = sqliteTable('search_chunks', {
  id: text('id').primaryKey(), articleId: text('article_id').notNull(), sourceId: text('source_id').notNull(),
  kind: text('kind').$type<'article' | 'highlight'>().notNull(), content: text('content').notNull(), embeddingText: text('embedding_text').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true), indexed: integer('indexed', { mode: 'boolean' }).notNull().default(false),
}, table => [index('search_chunks_article').on(table.articleId, table.active, table.indexed)])

// Read mapping only: migrations create this as an FTS5 virtual table and triggers
// maintain its contents. MATCH, snippet, and bm25 stay explicit SQL expressions.
export const savedSearch = sqliteTable('saved_search', {
  articleId: text('article_id'), sourceId: text('source_id'), title: text('title'), url: text('url'), author: text('author'), text: text('text'),
})

export const videoTranscripts = sqliteTable('video_transcripts', {
  articleId: text('article_id').primaryKey().references(() => savedArticles.id, { onDelete: 'cascade' }),
  cues: text('cues', { mode: 'json' }).$type<TranscriptCue[]>().notNull(),
})
