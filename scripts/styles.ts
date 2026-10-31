import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { Scanner } from '@tailwindcss/oxide'
import { compile } from 'tailwindcss'
import { transform } from 'lightningcss'

const require = createRequire(import.meta.url)

export async function buildStyles(rootDir: string, outputPath: string) {
  const source = resolve(rootDir, 'app/styles.css')
  const compiler = await compile(await readFile(source, 'utf8'), {
    base: dirname(source),
    from: source,
    async loadStylesheet(id, base) {
      const path = id.startsWith('.') ? resolve(base, id) : require.resolve(id === 'tailwindcss' ? 'tailwindcss/index.css' : id)
      return { path, base: dirname(path), content: await readFile(path, 'utf8') }
    },
  })
  const scanner = new Scanner({ sources: [
    { base: rootDir, pattern: 'app/**/*.{ts,tsx}', negated: false },
  ] })
  const css = compiler.build(scanner.scan())
  const { code } = transform({ filename: source, code: Buffer.from(css), minify: true })
  await writeFile(outputPath, code)
}
