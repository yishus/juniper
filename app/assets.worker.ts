import type { ScriptEntry } from 'remix/assets'

import { browserEntry } from './asset-config.ts'

// Inlined by scripts/build.ts; the Worker never reads files or compiles assets.
declare const __ASSET_MANIFEST__: Record<string, ScriptEntry>
const entries = __ASSET_MANIFEST__

export const assets = {
  async getScriptEntry(sourceId: string): Promise<ScriptEntry> {
    const key = sourceId.startsWith('file:')
      ? decodeURIComponent(new URL(sourceId).pathname).slice(1)
      : sourceId
    const entry = entries[key]
    if (!entry) throw new Error(`Missing built browser entry: ${key}`)
    return entry
  },
  async fetch(_request: Request): Promise<null> {
    // Existing files are served by Workers Static Assets before reaching the router.
    return null
  },
}

export const scriptEntry = entries[browserEntry]
