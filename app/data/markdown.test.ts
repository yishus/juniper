import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { articleMarkdown } from './markdown.ts'
import type { MarkdownNode } from '../actions/public/markdown-view.tsx'
import { normalizeReaderSettings } from '../actions/public/reader-settings.ts'

const id = '9ef55d39-72bb-467a-a901-2dcbe9dd3ecb'
const metadata = { id, title: 'A good read', url: 'https://articles.org/story' }
function elements(nodes: MarkdownNode[]): Exclude<MarkdownNode, string>[] {
  return nodes.flatMap(node => typeof node === 'string' ? [] : [node, ...elements(node.children)])
}

describe('reader Markdown', () => {
  it('renders structural Markdown and keeps saved images inline', () => {
    const nodes = articleMarkdown({ ...metadata, markdown: `# A good read\n\nSource: https://articles.org/story\n\n## Chapter one\n\nA **bold** idea and *emphasis*.\n\n1. First\n2. Second\n\n> A quote\n\n\`\`\`js\nconst reading = true;\n\`\`\`\n\n![A desk](/images/${id}/1.png)\n\nAfter the image.\n\n| Topic | Note |\n| --- | --- |\n| Reading | Slowly |` })
    const tags = elements(nodes).map(node => node.tag)
    for (const tag of ['h2', 'strong', 'em', 'ol', 'blockquote', 'pre', 'code', 'img', 'table', 'th', 'td']) assert.ok(tags.includes(tag as typeof tags[number]), `Expected ${tag}`)
    assert.ok(!tags.includes('h1'))
    const image = elements(nodes).find(node => node.tag === 'img')!
    assert.equal(image.src, `/images/${id}/1.png`)
    const paragraphs = nodes.filter(node => typeof node !== 'string' && node.tag === 'p')
    const imageIndex = paragraphs.findIndex(node => typeof node !== 'string' && node.children.some(child => typeof child !== 'string' && child.tag === 'img'))
    assert.ok(imageIndex >= 0)
    assert.match(JSON.stringify(paragraphs[imageIndex + 1]), /After the image/)
  })
  it('drops raw HTML and unsafe URLs while preserving safe content', () => {
    const nodes = articleMarkdown({ ...metadata, markdown: `<script>alert(1)</script>\n\n<iframe src="https://evil.org"></iframe>\n\n[unsafe](javascript:alert%281%29) [data](data:text/html,script) [safe](/more)\n\n![tracking](https://evil.org/tracker.png)\n\n![other article](/images/another-id/1.png)\n\n![saved](/images/${id}/2.webp)\n\n\`<img onerror="alert(1)">\`` })
    const all = elements(nodes)
    assert.deepEqual(all.filter(node => node.tag === 'a').map(node => node.href), ['https://articles.org/more'])
    assert.deepEqual(all.filter(node => node.tag === 'img').map(node => node.src), [`/images/${id}/2.webp`])
    assert.ok(all.some(node => node.tag === 'code' && JSON.stringify(node.children).includes('onerror')))
    assert.ok(!JSON.stringify(nodes).includes('iframe'))
  })
  it('rejects image URL suffixes that could leave the saved image route', () => {
    const nodes = articleMarkdown({ ...metadata, markdown: `![bad](/images/${id}/../another/1.png)\n\n![bad](/images/${id}/1.png?tracking=1)\n\n![safe](/images/${id}/3.avif)` })
    assert.deepEqual(elements(nodes).filter(node => node.tag === 'img').map(node => node.src), [`/images/${id}/3.avif`])
  })
})

describe('reader preferences', () => {
  it('restores valid font choices and clamps stored font sizes to the supported range', () => {
    assert.deepEqual(normalizeReaderSettings({ font: 'sans', size: 23 }), { font: 'sans', size: 23 })
    assert.deepEqual(normalizeReaderSettings({ font: 'serif', size: 1000 }), { font: 'serif', size: 28 })
    assert.deepEqual(normalizeReaderSettings({ font: 'sans', size: -10 }), { font: 'sans', size: 14 })
    assert.deepEqual(normalizeReaderSettings({ font: 'serif', size: 19.7 }), { font: 'serif', size: 20 })
  })
  it('falls back to readable defaults for malformed preferences', () => {
    for (const value of [null, 'bad', { font: 'unknown', size: 'bad' }, { size: NaN }, { size: Infinity }]) {
      assert.deepEqual(normalizeReaderSettings(value), { font: 'serif', size: 18 })
    }
  })
})
