import type { Handle, RemixNode } from 'remix/component'
import { jsx } from 'remix/component/jsx-runtime'
import { textSegments, type Highlight } from './highlight-model.ts'

export type MarkdownTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'strong' | 'em' | 'del' | 'blockquote' | 'ul' | 'ol' | 'li' | 'pre' | 'code' | 'hr' | 'br' | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td' | 'a' | 'img'
export type MarkdownNode = string | {
  tag: MarkdownTag
  children: MarkdownNode[]
  href?: string
  src?: string
  alt?: string
  title?: string
  start?: number
  align?: 'left' | 'center' | 'right'
}

export function MarkdownView(handle: Handle<{ nodes: MarkdownNode[]; highlights?: Highlight[]; activeId?: string }>) {
  return () => {
    let offset = 0
    const anchored = new Set<string>()
    const highlights = handle.props.highlights ?? []
    function renderNode(node: MarkdownNode, index: number): RemixNode {
      if (typeof node === 'string') {
        const start = offset
        offset += node.length
        if (!highlights.length || !node.trim()) return node
        return textSegments(node, start, highlights).map(segment => {
          if (!segment.ids.length || !segment.text.trim()) return segment.text
          const anchors = segment.ids.filter(id => !anchored.has(id)).map(id => {
            anchored.add(id)
            return <span key={id} id={`highlight-text-${id}`} class="scroll-mt-28" aria-hidden="true" />
          })
          return [...anchors, <mark key={segment.start} data-highlight-ids={segment.ids.join(' ')} tabIndex={-1} class={segment.ids.includes(handle.props.activeId ?? '') ? 'reader-highlight reader-highlight-active' : 'reader-highlight'}>{segment.text}</mark>]
        })
      }
      const children = node.children.map(renderNode)
      if (node.tag === 'a') return <a key={index} href={node.href} title={node.title} target="_blank" rel="noopener noreferrer">{children}</a>
      if (node.tag === 'img') return <img key={index} src={node.src} alt={node.alt ?? ''} title={node.title} loading="lazy" decoding="async" />
      if (node.tag === 'ol') return <ol key={index} start={node.start}>{children}</ol>
      if (node.tag === 'th') return <th key={index} style={{ textAlign: node.align }}>{children}</th>
      if (node.tag === 'td') return <td key={index} style={{ textAlign: node.align }}>{children}</td>
      return jsx(node.tag, { children }, index)
    }
    return handle.props.nodes.map(renderNode)
  }
}
