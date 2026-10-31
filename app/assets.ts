import { fileURLToPath } from 'node:url'
import { createAssetServer } from 'remix/assets'

import { assetConfig, browserEntry } from './asset-config.ts'

// Node-only asset compiler for source-level router tests. The Worker build replaces
// this module with assets.worker.ts; development runs the same Worker as deployment.
export const assets = createAssetServer({
  ...assetConfig,
  rootDir: fileURLToPath(new URL('..', import.meta.url)),
  watch: false,
})

export const scriptEntry = await assets.getScriptEntry(browserEntry)
