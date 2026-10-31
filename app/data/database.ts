import type { D1Database } from '@cloudflare/workers-types'
import { drizzle } from 'drizzle-orm/d1'
import type { AppEnv } from './types.ts'
import * as schema from './schema.ts'
import { eq, exists } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'

export function database(binding: AppEnv['DB']) {
  // The app exposes the prepare/batch surface shared by D1 and test fixtures.
  // Drizzle's D1 driver uses that surface; other D1 methods are not needed here.
  return drizzle(binding as D1Database, { schema })
}

export function readingListMembership(db: ReturnType<typeof database>) {
  return exists(db.select({ articleId: schema.readingList.articleId }).from(schema.readingList)
    .where(eq(schema.readingList.articleId, schema.savedArticles.id))).mapWith(Boolean)
}

// D1 batches are atomic. Bound indexing work also stays below its statement limit.
export async function batchWrites(db: ReturnType<typeof database>, statements: BatchItem<'sqlite'>[]) {
  for (let index = 0; index < statements.length; index += 32) {
    const [first, ...rest] = statements.slice(index, index + 32)
    if (first) await db.batch([first, ...rest])
  }
}
