import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { build, transform } from 'esbuild'
import { createAssetServer, type ScriptEntry } from 'remix/assets'

import { assetConfig, browserEntry } from '../app/asset-config.ts'
import { buildStyles } from './styles.ts'

const rootDir = resolve(import.meta.dirname, '..')
const outputDir = resolve(rootDir, 'dist')
const publicDir = resolve(outputDir, 'public')
const sourceKey = (filePath: string) => relative(rootDir, filePath).split(sep).join('/')
const assets = createAssetServer({
  ...assetConfig,
  rootDir,
  watch: false,
  minify: true,
  fingerprint: true,
  scripts: { define: { 'process.env.NODE_ENV': '"production"' } },
})

try {
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(publicDir, { recursive: true })
  await cp(resolve(rootDir, 'public'), publicDir, { recursive: true })
  await buildStyles(rootDir, resolve(publicDir, 'library.css'))

  const entries: Record<string, ScriptEntry> = {}
  const urls = new Set<string>()
  const discovered = await assets.getAssets()
  for (const asset of discovered) {
    if (!asset.filePath || !sourceKey(asset.filePath).startsWith('app/')) continue
    if (asset.type === 'script') {
      const entry = await assets.getScriptEntry(asset.filePath)
      entries[sourceKey(asset.filePath)] = entry
      urls.add(entry.href)
      entry.preloads.forEach((url) => urls.add(url))
      for (const url of Object.values(entry.importMap.imports ?? {})) urls.add(url)
      for (const scope of Object.values(entry.importMap.scopes ?? {})) {
        for (const url of Object.values(scope)) urls.add(url)
      }
    } else {
      urls.add(await assets.getHref(asset.filePath))
      for (const url of await assets.getPreloads(asset.filePath)) urls.add(url)
    }
  }
  if (!entries[browserEntry]) throw new Error(`Missing browser entry: ${browserEntry}`)

  for (const href of urls) {
    const url = new URL(href, 'https://assets.invalid')
    if (url.origin !== 'https://assets.invalid') continue
    if (!url.pathname.startsWith(`${assetConfig.basePath}/`) || url.search) {
      throw new Error(`Cannot export asset URL: ${href}`)
    }
    const response = await assets.fetch(new Request(url))
    if (!response?.ok) throw new Error(`Failed to compile ${href}: ${response?.status}`)
    const destination = resolve(publicDir, `.${decodeURIComponent(url.pathname)}`)
    if (!destination.startsWith(publicDir + sep)) throw new Error(`Invalid asset path: ${href}`)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, new Uint8Array(await response.arrayBuffer()))
  }

  await writeFile(resolve(outputDir, 'asset-manifest.json'), JSON.stringify(entries, null, 2) + '\n')
  let publicHeaders = ''
  try {
    publicHeaders = await readFile(resolve(publicDir, '_headers'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Remix preserves source extensions even though these files contain compiled JavaScript.
  // Workers otherwise infers MIME types from filenames (e.g. .ts is a video type).
  const scriptHeaders = ['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs'].map(
    (extension) => `/assets/*.${extension}\n  Content-Type: text/javascript; charset=utf-8`,
  )
  await writeFile(resolve(publicDir, '_headers'), [
    publicHeaders.trimEnd(),
    '/assets/*\n  Cache-Control: public, max-age=31536000, immutable',
    ...scriptHeaders,
    '',
  ].filter((value, index) => value || index > 0).join('\n'))

  const result = await build({
    absWorkingDir: rootDir,
    entryPoints: ['worker.ts'],
    outfile: resolve(outputDir, 'worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd'],
    external: ['node:*'],
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'remix/component',
    metafile: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      __ASSET_MANIFEST__: JSON.stringify(entries),
    },
    plugins: [{
      name: 'worker-assets',
      setup(builder) {
        builder.onLoad({ filter: /[/\\]app[/\\].*[/\\]public[/\\].*\.[cm]?[jt]sx?$/ }, async (args) => {
          const extension = args.path.split('.').at(-1)
          const transformed = await transform(await readFile(args.path, 'utf8'), {
            loader: extension === 'tsx' ? 'tsx' : extension === 'jsx' ? 'jsx' : extension === 'ts' ? 'ts' : 'js',
            jsx: 'automatic',
            jsxImportSource: 'remix/component',
            // Source identity survives bundling and does not contain the build machine's path.
            define: { 'import.meta.url': JSON.stringify(`file:///${sourceKey(args.path)}`) },
          })
          return { contents: transformed.code, loader: 'js' }
        })
      },
    }],
  })
  await writeFile(resolve(outputDir, 'worker-meta.json'), JSON.stringify(result.metafile, null, 2) + '\n')
  console.log(`Built Worker and ${urls.size} browser assets in dist/`)
} finally {
  await assets.close()
}
