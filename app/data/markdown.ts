import { Marked } from 'marked'
import { parseDocument } from 'htmlparser2'
import { isTag, isText, type AnyNode } from 'domhandler'
import { textContent } from 'domutils'
import type { Article } from './types.ts'
import type { MarkdownNode, MarkdownTag } from '../actions/public/markdown-view.tsx'

// Use Marked for Markdown syntax, then rebuild a small, safe JSX tree. Raw HTML
// and arbitrary attributes never reach the reader or an innerHTML assignment.
const parser = new Marked({ gfm: true, renderer: { html: () => '' } })
const allowed = new Set<MarkdownTag>(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img'])

function safeLink(href: string, base: string): string | undefined {
  try {
    const url = new URL(href, base)
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) return url.href
  } catch {}
  return undefined
}

export function articleMarkdown(article: Pick<Article, 'id' | 'title' | 'url' | 'markdown'>): MarkdownNode[] {
  const html = parser.parse(article.markdown, { async: false })
  const doc = parseDocument(html, { decodeEntities: true })
  const elements = doc.children.filter(isTag)
  // Import metadata is already displayed in the page header.
  if (elements[0]?.name === 'h1' && textContent(elements[0]).trim() === article.title) {
    doc.children = doc.children.filter(node => node !== elements[0])
    if (elements[1]?.name === 'p' && textContent(elements[1]).trim() === `Source: ${article.url}`) {
      doc.children = doc.children.filter(node => node !== elements[1])
    }
  }

  const convert = (node: AnyNode): MarkdownNode[] => {
    if (isText(node)) return [node.data]
    if (!isTag(node) || !allowed.has(node.name as MarkdownTag)) return []
    const children = node.children.flatMap(convert)
    const result: Exclude<MarkdownNode, string> = { tag: node.name as MarkdownTag, children }
    if (node.name === 'a') {
      result.href = safeLink(node.attribs.href, article.url)
      if (!result.href) return children
      result.title = node.attribs.title
    }
    if (node.name === 'img') {
      // Keep the reader self-contained: images come from this article's saved files.
      const prefix = `/images/${article.id}/`
      const src = node.attribs.src ?? ''
      if (!src.startsWith(prefix) || !/^\d+\.(jpg|png|webp|gif|avif)$/.test(src.slice(prefix.length))) return node.attribs.alt ? [node.attribs.alt] : []
      result.src = src
      result.alt = node.attribs.alt ?? ''
      result.title = node.attribs.title
    }
    if (node.name === 'ol' && /^\d{1,6}$/.test(node.attribs.start ?? '')) result.start = Number(node.attribs.start)
    if (['th', 'td'].includes(node.name) && ['left', 'center', 'right'].includes(node.attribs.align)) result.align = node.attribs.align as 'left' | 'center' | 'right'
    return [result]
  }
  return doc.children.flatMap(convert)
}
