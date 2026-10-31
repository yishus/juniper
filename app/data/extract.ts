import { parseDocument } from 'htmlparser2'
import { isTag, isText, type AnyNode, type Element } from 'domhandler'
import { findAll, textContent, removeElement } from 'domutils'
import { ImportError, publicUrl } from './network.ts'

const ignoredTags = new Set(['script', 'style', 'noscript', 'nav', 'footer', 'aside', 'form', 'button', 'input', 'svg', 'iframe'])
const noise = /(^|[\s_-])(advertisement|advert|ads|cookie|newsletter|social|share|sharing|related|comments|sidebar|menu)([\s_-]|$)/i
const blockTags = new Set(['p', 'div', 'section', 'article', 'main', 'figure', 'figcaption', 'header'])
function cleanText(node: AnyNode) { return textContent(node).replace(/\s+/g, ' ').trim() }
function escape(text: string) { return text.replace(/[\\`*_[\]<>]/g, '\\$&') }

export function extractArticle(html: string, url: string) {
  const doc = parseDocument(html, { decodeEntities: true })
  const all = findAll(isTag, doc.children)
  const meta = (key: string) => all.find(el => el.name === 'meta' && (el.attribs.property === key || el.attribs.name === key))?.attribs.content?.trim()
  const title = meta('og:title') || cleanText(all.find(el => el.name === 'h1') ?? all.find(el => el.name === 'title') ?? doc) || new URL(url).hostname
  const author = meta('author') || meta('article:author') || null
  const site = meta('og:site_name') || new URL(url).hostname.replace(/^www\./, '')
  for (const node of all) {
    if (ignoredTags.has(node.name) || node.attribs.hidden !== undefined || node.attribs['aria-hidden'] === 'true' ||
        noise.test(`${node.attribs.class ?? ''} ${node.attribs.id ?? ''}`)) removeElement(node)
  }
  const elements = findAll(isTag, doc.children)
  const semantic = elements.filter(el => el.name === 'article' || el.name === 'main' || el.attribs.role === 'main')
  const candidates = semantic.length ? semantic : elements.filter(el => ['div', 'section', 'body'].includes(el.name))
  const score = (node: Element) => {
    const paragraphs = findAll(el => el.name === 'p', node.children)
    const words = paragraphs.reduce((sum, el) => sum + cleanText(el).length, 0)
    const linkText = findAll(el => el.name === 'a', node.children).reduce((sum, el) => sum + cleanText(el).length, 0)
    return words - linkText * 2 + (node.name === 'article' ? 200 : 0)
  }
  const root = candidates.sort((a, b) => score(b) - score(a))[0]
  if (!root || cleanText(root).length < 100) throw new ImportError('No readable article was found. This page may require sign-in or JavaScript.')

  const images = new Map<string, { node: Element; alt: string }[]>()
  for (const node of findAll(el => el.name === 'img', root.children)) {
    const srcset = node.attribs['data-srcset'] || node.attribs.srcset
    const source = node.attribs['data-src'] || node.attribs['data-original'] ||
      srcset?.split(',').at(-1)?.trim().split(/\s+/)[0] || node.attribs.src
    if (!source || (node.attribs.width === '1' && node.attribs.height === '1')) { removeElement(node); continue }
    try {
      const src = publicUrl(source, url).href
      node.attribs.src = src
      images.set(src, [...(images.get(src) ?? []), { node, alt: node.attribs.alt ?? '' }])
    } catch { removeElement(node) }
  }

  const render = (node: AnyNode): string => {
    if (isText(node)) return escape(node.data.replace(/\s+/g, ' '))
    if (!isTag(node)) return ''
    const inside = () => node.children.map(render).join('')
    if (ignoredTags.has(node.name)) return ''
    if (/^h[1-6]$/.test(node.name)) return node.name === 'h1' && cleanText(node) === title ? '' : `\n\n${'#'.repeat(Number(node.name[1]))} ${inside().trim()}\n\n`
    if (node.name === 'br') return '\n'
    if (node.name === 'hr') return '\n\n---\n\n'
    if (node.name === 'strong' || node.name === 'b') return `**${inside().trim()}**`
    if (node.name === 'em' || node.name === 'i') return `*${inside().trim()}*`
    if (node.name === 'pre') {
      const content = textContent(node).trim()
      const fence = '`'.repeat(Math.max(3, ...Array.from(content.matchAll(/`+/g), m => m[0].length + 1)))
      return `\n\n${fence}\n${content}\n${fence}\n\n`
    }
    if (node.name === 'code') {
      const content = textContent(node)
      const fence = '`'.repeat(Math.max(1, ...Array.from(content.matchAll(/`+/g), m => m[0].length + 1)))
      return `${fence} ${content} ${fence}`
    }
    if (node.name === 'a') {
      try { return `[${inside().trim()}](${publicUrl(node.attribs.href, url).href.replace(/[()]/g, c => c === '(' ? '%28' : '%29')})` } catch { return inside() }
    }
    if (node.name === 'img') return node.attribs.src ? `\n\n![${escape(node.attribs.alt ?? '')}](${node.attribs.src})\n\n` : ''
    if (node.name === 'blockquote') return `\n\n${inside().trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`
    if (node.name === 'ul' || node.name === 'ol') {
      const list = node.children.filter(child => isTag(child) && child.name === 'li')
      return '\n\n' + list.map((child, index) => `${node.name === 'ol' ? `${index + 1}.` : '-'} ${render(child).trim().replace(/\n/g, '\n   ')}`).join('\n') + '\n\n'
    }
    if (node.name === 'table') {
      const rows = findAll(el => el.name === 'tr', node.children).map(row => row.children.filter(el => isTag(el) && ['td', 'th'].includes(el.name)).map(el => render(el).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')))
      if (!rows.length) return ''
      const width = Math.max(...rows.map(row => row.length))
      const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`
      return '\n\n' + [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n'
    }
    return blockTags.has(node.name) ? `\n\n${inside().trim()}\n\n` : inside()
  }
  const text = findAll(el => el.name === 'p' || /^h[1-6]$/.test(el.name), root.children).map(cleanText).join('\n\n') || cleanText(root)
  return {
    title: title.slice(0, 500), author, site, text,
    description: (meta('description') || meta('og:description') || text).replace(/\s+/g, ' ').slice(0, 240),
    images,
    markdown: () => `# ${escape(title)}\n\nSource: ${url}\n\n${root.children.map(render).join('').replace(/\n{3,}/g, '\n\n').trim()}\n`,
  }
}
