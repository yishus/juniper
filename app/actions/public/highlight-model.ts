import type { MarkdownNode } from './markdown-view.tsx'

export interface Highlight {
  id: string
  articleId: string
  start: number
  end: number
  quote: string
  note: string
  createdAt: string
}

export function markdownText(nodes: MarkdownNode[]): string {
  return nodes.map(node => typeof node === 'string' ? node : markdownText(node.children)).join('')
}

export interface HighlightInput { start: number; end: number; quote: string; note: string }
export function validateHighlight(value: unknown, text: string): HighlightInput {
  if (!value || typeof value !== 'object') throw new Error('Select a passage in the article first.')
  const input = value as Partial<HighlightInput>
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start! < 0 || input.end! <= input.start! || input.end! > text.length ||
      typeof input.quote !== 'string' || !input.quote.trim() || input.quote.length > 10000 || text.slice(input.start, input.end) !== input.quote) {
    throw new Error('This selection does not match the saved article. Please select the passage again.')
  }
  return { start: input.start!, end: input.end!, quote: input.quote, note: validateNote(input.note ?? '') }
}

export function validateNote(value: unknown): string {
  if (typeof value !== 'string' || value.length > 5000) throw new Error('Notes must be 5,000 characters or fewer.')
  return value.trim()
}

export function textSegments(text: string, offset: number, highlights: Highlight[]) {
  const end = offset + text.length
  const relevant = highlights.filter(h => h.start < end && h.end > offset)
  const boundaries = [...new Set([offset, end, ...relevant.flatMap(h => [Math.max(offset, h.start), Math.min(end, h.end)])])].sort((a, b) => a - b)
  return boundaries.slice(0, -1).map((start, index) => ({
    start,
    text: text.slice(start - offset, boundaries[index + 1] - offset),
    ids: relevant.filter(h => h.start <= start && h.end > start).map(h => h.id),
  }))
}
