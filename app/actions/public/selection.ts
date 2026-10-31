import type { HighlightInput } from './highlight-model.ts'

export interface SelectedPassage extends HighlightInput { x: number; y: number }

export function selectedPassage(content: HTMLElement, selection: Selection | null): SelectedPassage | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return null
  const prefix = range.cloneRange()
  prefix.selectNodeContents(content)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length
  prefix.setEnd(range.endContainer, range.endOffset)
  const end = prefix.toString().length
  const quote = (content.textContent ?? '').slice(start, end)
  if (!quote.trim() || quote.length > 10000) return null
  const bounds = range.getClientRects()[0] ?? range.getBoundingClientRect()
  return {
    start, end, quote, note: '',
    x: Math.max(16, Math.min(bounds.left, document.documentElement.clientWidth - 240)),
    y: Math.max(8, bounds.top >= 52 ? bounds.top - 44 : bounds.bottom + 8),
  }
}
