import { clientEntry, on, ref, type Handle } from 'remix/component'
import type { ArticleSummary } from '../../data/types.ts'
import { routes } from '../../routes.ts'
import { MarkdownView, type MarkdownNode } from './markdown-view.tsx'
import { ArrowUpRightIcon, XMarkIcon } from './icons.tsx'
import { DEFAULT_READER_SETTINGS, MAX_FONT_SIZE, MIN_FONT_SIZE, normalizeReaderSettings, READER_SETTINGS_KEY } from './reader-settings.ts'
import type { Highlight, HighlightInput } from './highlight-model.ts'
import { selectedPassage, type SelectedPassage } from './selection.ts'

export interface ReaderProps {
  article: Pick<ArticleSummary, 'id' | 'title' | 'url' | 'author' | 'site' | 'readingMinutes'>
  nodes: MarkdownNode[]
  highlights: Highlight[]
}

type NoteEditor = { highlight: Highlight } | { selection: HighlightInput }

export const Reader = clientEntry(import.meta.url + '#Reader', function Reader(handle: Handle<ReaderProps>) {
  let settings = { ...DEFAULT_READER_SETTINGS }
  let highlights = handle.props.highlights
  let candidate: SelectedPassage | null = null
  let editor: NoteEditor | null = null
  let draft = ''
  let activeId = ''
  let busy = false
  let error = ''
  let content: HTMLDivElement | undefined
  let noteInput: HTMLTextAreaElement | undefined

  function saveSettings() {
    candidate = null
    try { localStorage.setItem(READER_SETTINGS_KEY, JSON.stringify(settings)) } catch {}
    handle.update()
  }

  function captureSelection() {
    if (!content || editor || busy) return
    const next = selectedPassage(content, window.getSelection())
    if (JSON.stringify(candidate) === JSON.stringify(next)) return
    candidate = next
    handle.update()
  }

  async function mutate(href: string, body: unknown) {
    const response = await fetch(href, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: handle.signal })
    const result = await response.json() as { highlight?: Highlight; deleted?: boolean; error?: string }
    if (!response.ok) throw new Error(result.error ?? 'Could not save this change. Please try again.')
    return result
  }

  async function saveHighlight(selection: HighlightInput, note = '') {
    if (busy) return
    busy = true; error = ''
    await handle.update()
    try {
      const existing = highlights.find(h => h.start === selection.start && h.end === selection.end)
      const result = existing && note
        ? await mutate(routes.updateHighlight.href({ id: handle.props.article.id, highlightId: existing.id }), { note })
        : await mutate(routes.createHighlight.href({ id: handle.props.article.id }), { ...selection, note })
      if (handle.signal.aborted) return
      if (!result.highlight) throw new Error('Highlight could not be saved.')
      highlights = [...highlights.filter(h => h.id !== result.highlight!.id), result.highlight].sort((a, b) => a.start - b.start)
      activeId = result.highlight.id
      candidate = null; editor = null; draft = ''
      window.getSelection()?.removeAllRanges()
    } catch (failure) {
      if (!handle.signal.aborted) error = failure instanceof Error ? failure.message : 'Could not save the highlight.'
    } finally {
      if (!handle.signal.aborted) { busy = false; handle.update() }
    }
  }

  async function saveNote(highlight: Highlight) {
    if (busy) return
    busy = true; error = ''
    await handle.update()
    try {
      const result = await mutate(routes.updateHighlight.href({ id: handle.props.article.id, highlightId: highlight.id }), { note: draft })
      if (handle.signal.aborted) return
      if (!result.highlight) throw new Error('Note could not be saved.')
      highlights = highlights.map(h => h.id === highlight.id ? result.highlight! : h)
      editor = null; draft = ''
    } catch (failure) {
      if (!handle.signal.aborted) error = failure instanceof Error ? failure.message : 'Could not save the note.'
    } finally { if (!handle.signal.aborted) { busy = false; handle.update() } }
  }

  async function removeHighlight(highlight: Highlight) {
    if (busy) return
    busy = true; candidate = null; error = ''
    await handle.update()
    try {
      await mutate(routes.deleteHighlight.href({ id: handle.props.article.id, highlightId: highlight.id }), {})
      if (handle.signal.aborted) return
      highlights = highlights.filter(h => h.id !== highlight.id)
      if (activeId === highlight.id) activeId = ''
      if (editor && 'highlight' in editor && editor.highlight.id === highlight.id) editor = null
    } catch (failure) {
      if (!handle.signal.aborted) error = failure instanceof Error ? failure.message : 'Could not remove the highlight.'
    } finally { if (!handle.signal.aborted) { busy = false; handle.update() } }
  }

  async function openNote(next: NoteEditor) {
    if (busy) return
    editor = next; candidate = null; error = ''
    draft = 'highlight' in next ? next.highlight.note : ''
    await handle.update()
    noteInput?.focus()
    noteInput?.scrollIntoView({ block: 'nearest' })
  }

  async function jumpTo(highlight: Highlight) {
    activeId = highlight.id; candidate = null
    await handle.update()
    const mark = content?.querySelector<HTMLElement>(`[data-highlight-ids~="${CSS.escape(highlight.id)}"]`)
    mark?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
    mark?.focus({ preventScroll: true })
  }

  handle.queueTask(() => {
    try {
      settings = normalizeReaderSettings(JSON.parse(localStorage.getItem(READER_SETTINGS_KEY) ?? 'null'))
      handle.update()
    } catch {}
  })

  return () => {
    const article = handle.props.article
    const quote = editor ? ('highlight' in editor ? editor.highlight.quote : editor.selection.quote) : ''
    return <div class="pb-20">
      <div class="flex flex-wrap items-center justify-end gap-x-7 gap-y-4 border-b border-line py-5 max-[760px]:justify-between" role="group" aria-label="Reader appearance">
        <fieldset>
          <legend class="sr-only">Font family</legend>
          <div class="flex rounded-lg border border-line p-0.5">
            <button type="button" aria-pressed={settings.font === 'sans'} class={`rounded-md px-3 py-1.5 text-xs transition-colors ${settings.font === 'sans' ? 'bg-ink text-paper' : 'text-muted hover:bg-control'}`} mix={on('click', () => { settings.font = 'sans'; saveSettings() })}>Sans serif</button>
            <button type="button" aria-pressed={settings.font === 'serif'} class={`rounded-md px-3 py-1.5 font-serif text-xs transition-colors ${settings.font === 'serif' ? 'bg-ink text-paper' : 'text-muted hover:bg-control'}`} mix={on('click', () => { settings.font = 'serif'; saveSettings() })}>Serif</button>
          </div>
        </fieldset>
        <div class="flex items-center gap-3">
          <label for="reader-font-size" class="text-xs text-muted">Size</label>
          <input id="reader-font-size" class="h-5 w-28 cursor-pointer accent-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink" type="range" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} step={1} value={settings.size} aria-valuetext={`${settings.size} pixels`} mix={on('input', event => { settings.size = normalizeReaderSettings({ ...settings, size: Number(event.currentTarget.value) }).size; saveSettings() })} />
          <output for="reader-font-size" class="w-[4ch] font-mono text-[11px] text-subtle" aria-live="polite">{settings.size}px</output>
        </div>
      </div>
      <div class="grid grid-cols-[minmax(0,1fr)_280px] items-start gap-12 max-[1000px]:grid-cols-1 max-[1000px]:gap-8">
        <article id="reader" class="mx-auto w-full min-w-0 max-w-[720px] pt-12 max-[760px]:pt-8" aria-labelledby="reader-title" style={{ fontFamily: settings.font === 'serif' ? 'var(--font-serif)' : 'var(--font-sans)', fontSize: `${settings.size}px` }}>
          <header class="mb-[2em]">
            <div class="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-xs text-subtle">
              <a class="inline-flex items-center gap-1 hover:text-ink hover:underline hover:underline-offset-4" href={article.url} target="_blank" rel="noopener noreferrer">{article.site}<ArrowUpRightIcon class="size-3" /></a>
              <span aria-hidden="true">·</span><span>{article.readingMinutes} min read</span>
            </div>
            <h1 id="reader-title" class="text-[2em] leading-[1.18] font-semibold tracking-[-.03em] wrap-anywhere">{article.title}</h1>
            {article.author && <p class="mt-5 font-sans text-xs text-muted">{article.author}</p>}
          </header>
          <div class="reader-prose" mix={[
            ref((node, signal) => {
              content = node
              let timer: ReturnType<typeof setTimeout>
              document.addEventListener('selectionchange', () => { clearTimeout(timer); timer = setTimeout(captureSelection, 100) }, { signal })
              window.addEventListener('scroll', () => { if (candidate) { candidate = null; handle.update() } }, { signal, passive: true })
              window.addEventListener('resize', () => { candidate = null; handle.update() }, { signal })
              document.addEventListener('keydown', event => { if (event.key === 'Escape' && candidate) { candidate = null; handle.update() } }, { signal })
              signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
            }),
            on('pointerup', captureSelection),
            on('keyup', captureSelection),
            on('click', event => {
              if (!window.getSelection()?.isCollapsed) return
              const mark = (event.target as Element).closest?.('[data-highlight-ids]')
              const id = mark?.getAttribute('data-highlight-ids')?.split(' ')[0]
              if (id) { event.preventDefault(); activeId = id; handle.update(); document.getElementById(`highlight-${id}`)?.scrollIntoView({ block: 'nearest' }) }
            }),
          ]}><MarkdownView nodes={handle.props.nodes} highlights={highlights} activeId={activeId} /></div>
        </article>
        <aside class="sticky top-6 mt-12 max-h-[calc(100dvh-48px)] overflow-y-auto border-l border-line pl-6 max-[1000px]:static max-[1000px]:mt-0 max-[1000px]:max-h-none max-[1000px]:border-t max-[1000px]:border-l-0 max-[1000px]:pt-6 max-[1000px]:pl-0" aria-labelledby="highlights-title">
          <h2 id="highlights-title" class="mb-5 flex items-center gap-2 text-sm font-semibold">Highlights <span class="rounded border border-line bg-surface px-1.5 font-mono text-[10px] text-subtle">{highlights.length}</span></h2>
          <div aria-live="polite" aria-atomic="true">{error && <p role="alert" class="mb-4 rounded-lg border border-line-strong bg-surface p-3 text-xs">{error}</p>}</div>
          {editor && <form class="mb-5 rounded-lg border border-line-strong p-3" mix={on('submit', event => { event.preventDefault(); const current = editor; if (current) void ('highlight' in current ? saveNote(current.highlight) : saveHighlight(current.selection, draft)) })}>
            <blockquote class="mb-3 line-clamp-4 text-xs leading-relaxed text-muted">{quote}</blockquote>
            <label for="highlight-note" class="mb-2 block text-xs font-medium">Note (optional)</label>
            <textarea id="highlight-note" class="min-h-28 w-full resize-y rounded-md border border-line bg-paper p-2 text-xs leading-relaxed outline-none focus:border-ink" maxLength={5000} value={draft} disabled={busy} mix={[ref(node => { noteInput = node }), on('input', event => { draft = event.currentTarget.value; handle.update() })]} />
            <div class="mt-3 flex gap-2">
              <button type="submit" disabled={busy} class="rounded-md bg-ink px-3 py-1.5 text-xs text-paper disabled:opacity-50">{busy ? 'Saving…' : 'highlight' in editor ? 'Save note' : 'Save highlight'}</button>
              <button type="button" disabled={busy} class="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-control" mix={on('click', () => { editor = null; draft = ''; error = ''; handle.update() })}>Cancel</button>
            </div>
          </form>}
          {!highlights.length && <p class="text-xs text-subtle">No highlights yet.</p>}
          <ol class="space-y-4">{highlights.map(highlight => <li key={highlight.id} id={`highlight-${highlight.id}`} class={`scroll-mt-6 rounded-lg border p-3 ${activeId === highlight.id ? 'border-line-strong bg-surface' : 'border-line'}`}>
            <a href={`#highlight-text-${highlight.id}`} class="block w-full text-left font-serif text-sm leading-relaxed wrap-anywhere hover:underline hover:underline-offset-4" aria-label={`Go to highlight: ${highlight.quote}`} mix={on('click', event => { event.preventDefault(); void jumpTo(highlight) })}>{highlight.quote}</a>
            {highlight.note && <p class="mt-3 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-muted">{highlight.note}</p>}
            <div class="mt-3 flex items-center justify-between gap-2">
              <button type="button" disabled={busy} class="text-[11px] text-subtle hover:text-ink disabled:opacity-50" mix={on('click', () => { activeId = highlight.id; void openNote({ highlight }) })}>{highlight.note ? 'Edit note' : 'Add note'}</button>
              <button type="button" disabled={busy} aria-label="Remove highlight" title="Remove highlight" class="rounded p-1 text-subtle hover:bg-control hover:text-ink disabled:opacity-50" mix={on('click', () => { void removeHighlight(highlight) })}><XMarkIcon class="size-3.5" /></button>
            </div>
          </li>)}</ol>
        </aside>
      </div>
      {candidate && !editor && <div class="fixed z-50 flex items-center gap-1 rounded-lg border border-line-strong bg-ink p-1 text-xs text-paper shadow-lg" role="toolbar" aria-label="Selection actions" style={{ left: `${candidate.x}px`, top: `${candidate.y}px` }} mix={on('pointerdown', event => event.preventDefault())}>
        <button type="button" disabled={busy} class="rounded-md px-3 py-2 hover:bg-accent-hover disabled:opacity-50" mix={on('click', () => { if (candidate) void saveHighlight(candidate) })}>{busy ? 'Saving…' : 'Highlight'}</button>
        <button type="button" disabled={busy} class="rounded-md px-3 py-2 hover:bg-accent-hover disabled:opacity-50" mix={on('click', () => { if (candidate) { const existing = highlights.find(h => h.start === candidate!.start && h.end === candidate!.end); void openNote(existing ? { highlight: existing } : { selection: candidate }) } })}>Add note</button>
      </div>}
    </div>
  }
})
