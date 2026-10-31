import { clientEntry, on, ref, type Handle } from 'remix/component'
import type { Article } from '../../data/types.ts'
import type { Highlight } from './highlight-model.ts'
import { routes } from '../../routes.ts'
import { parseVideoTime, videoTime } from './youtube.ts'
import { loadYouTubePlayer, type YouTubePlayer } from './youtube-player.ts'

const field = 'mt-2 block w-full rounded-lg border border-line-strong bg-paper p-2.5 text-sm outline-none focus:border-ink disabled:opacity-60'
const button = 'rounded-lg bg-ink px-3.5 py-2 text-xs font-semibold text-paper hover:bg-accent-hover disabled:opacity-60'
const secondary = 'rounded-lg border border-line-strong px-3 py-2 text-xs hover:bg-control disabled:opacity-60'
const editableTime = (time: number) => videoTime(time) + (time % 1000 ? `.${String(time % 1000).padStart(3, '0')}` : '')
const formParams = (form: HTMLFormElement) => new URLSearchParams([...new FormData(form)].map(([key, value]) => [key, String(value)]))

export const VideoView = clientEntry(import.meta.url + '#VideoView', function VideoView(handle: Handle<{ article: Article; highlights: Highlight[]; initialError?: string; noteDraft?: string; editHighlightId?: string }>) {
  let article = handle.props.article
  let highlights = handle.props.highlights
  let player: YouTubePlayer | undefined
  let ready = false
  let recording = false
  const initialHighlight = highlights.find(highlight => highlight.id === handle.props.editHighlightId)
  let start = initialHighlight ? editableTime(initialHighlight.start) : '0:00'
  let end = initialHighlight ? editableTime(initialHighlight.end) : ''
  let note = initialHighlight?.note ?? ''
  let editingId = initialHighlight?.id ?? ''
  let savedNote = handle.props.noteDraft ?? article.video?.note ?? ''
  let busy = false
  let error = handle.props.initialError ?? ''
  let playerError = ''
  let notice = ''
  let selected: { start: number; end: number } | undefined
  let transcriptElement: HTMLElement | undefined

  async function mutate(path: string, body: URLSearchParams): Promise<{ article?: Article; highlight?: Highlight; deleted?: boolean; duplicate?: boolean } | null> {
    if (busy) return null
    busy = true; error = ''; notice = ''
    await handle.update()
    try {
      const response = await fetch(path, { method: 'POST', body, headers: { Accept: 'application/json' }, signal: handle.signal })
      const data = await response.json() as { article?: Article; highlight?: Highlight; deleted?: boolean; duplicate?: boolean; error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Could not save this change. Please try again.')
      return data
    } catch (failure) { if (!handle.signal.aborted) error = (failure as Error).message; return null }
    finally { if (!handle.signal.aborted) { busy = false; handle.update() } }
  }

  function reset() { start = '0:00'; end = ''; note = ''; editingId = ''; recording = false; selected = undefined }
  async function saveHighlight(values: URLSearchParams) {
    const path = editingId ? routes.updateHighlight.href({ id: article.id, highlightId: editingId }) : routes.createHighlight.href({ id: article.id })
    const data = await mutate(path, values)
    if (!data?.highlight) return
    highlights = [...highlights.filter(item => item.id !== data.highlight!.id), data.highlight].sort((a, b) => a.start - b.start)
    notice = data.duplicate ? 'This segment is already highlighted.' : editingId ? 'Highlight updated.' : 'Highlight saved.'
    reset(); handle.update()
  }

  function play(startTime: number, endTime?: number) {
    if (!ready || !player) return
    player.loadVideoById({ videoId: article.video!.videoId, startSeconds: startTime / 1000, ...(endTime === undefined ? {} : { endSeconds: endTime / 1000 }) })
  }

  function readSelection() {
    const selection = window.getSelection()
    selected = undefined
    if (selection?.rangeCount && !selection.isCollapsed && transcriptElement) {
      const range = selection.getRangeAt(0)
      if (transcriptElement.contains(range.startContainer) && transcriptElement.contains(range.endContainer) && selection.toString().trim()) {
        const nodes = [...transcriptElement.querySelectorAll<HTMLElement>('[data-cue]')].filter(node => range.intersectsNode(node))
        if (nodes.length) selected = { start: Number(nodes[0].dataset.start), end: Number(nodes.at(-1)!.dataset.end) }
      }
    }
    handle.update()
  }

  return () => {
    const cues = article.transcript ?? []
    const rangeStart = parseVideoTime(start), rangeEnd = parseVideoTime(end)
    return <article class="py-9 max-[760px]:py-6" aria-labelledby="video-heading">
      <header class="mb-6">
        <p class="mb-2 font-mono text-xs text-subtle">Saved video · YouTube{article.video?.duration ? ` · ${videoTime(article.video.duration)}` : ''}</p>
        <h1 id="video-heading" class="text-3xl leading-tight font-semibold tracking-tight max-[760px]:text-2xl">{article.title}</h1>
        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
          {article.author && <span>{article.author}</span>}
          <a href={article.url} target="_blank" rel="noopener noreferrer" class="underline underline-offset-4">Watch on YouTube ↗</a>
          <span>Saved {new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(article.savedAt))}</span>
        </div>
      </header>
      <p role="alert" class="mb-3 text-sm">{error}</p>
      <p role="status" aria-live="polite" class="mb-3 text-xs text-muted">{notice}</p>
      <div class="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-8 max-[1000px]:grid-cols-1">
        <div class="min-w-0">
          <iframe title={`YouTube player: ${article.title}`} src={`https://www.youtube.com/embed/${article.video!.videoId}?enablejsapi=1&playsinline=1`} class="aspect-video min-h-[200px] w-full rounded-xl border border-line bg-surface" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" mix={ref((node, signal) => {
            const source = new URL(node.src); source.searchParams.set('origin', window.location.origin); node.src = source.href
            void loadYouTubePlayer().then(api => {
              if (signal.aborted) return
              player = new api.Player(node, { events: {
                onReady() { if (!signal.aborted) { ready = true; handle.update() } },
                onError() { if (!signal.aborted) { ready = false; playerError = 'This video cannot play here. Open it on YouTube and enter highlight times below.'; handle.update() } },
              } })
            }).catch(failure => { if (!signal.aborted) { playerError = failure.message; handle.update() } })
            signal.addEventListener('abort', () => { player?.destroy(); player = undefined }, { once: true })
          })} />
          {playerError && <p role="status" class="mt-3 text-xs text-muted">{playerError}</p>}
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" class={button} disabled={!ready || busy || Boolean(editingId)} mix={on('click', () => {
              if (!player) return
              if (!recording) {
                reset(); const time = Math.floor(player.getCurrentTime() * 1000); start = editableTime(time); recording = true; play(time)
              } else {
                end = editableTime(Math.floor(player.getCurrentTime() * 1000)); recording = false; player.pauseVideo()
              }
              handle.update()
            })}>{recording ? 'Finish highlight' : 'Start highlight'}</button>
            {recording && <span role="status" class="text-xs text-muted">Highlight starts at {start}. Keep watching, then finish.</span>}
          </div>
          <form method="post" action={editingId ? routes.updateHighlight.href({ id: article.id, highlightId: editingId }) : routes.createHighlight.href({ id: article.id })} aria-busy={busy} class="mt-5 rounded-xl border border-line bg-surface p-4" mix={on('submit', event => {
            event.preventDefault(); void saveHighlight(formParams(event.currentTarget))
          })}>
            <h2 class="text-sm font-semibold">{editingId ? 'Edit highlight' : 'Highlight a segment'}</h2>
            <p class="mt-1 text-xs leading-relaxed text-muted">Mark a moment while watching, select transcript text, or enter times below.</p>
            <div class="mt-3 grid grid-cols-2 gap-3">
              <label class="text-xs">Start<input name="start" value={start} placeholder="0:00" required disabled={busy} class={field} mix={on('input', event => { start = event.currentTarget.value; recording = false; handle.update() })} /></label>
              <label class="text-xs">End<input name="end" value={end} placeholder="0:30" required disabled={busy} class={field} mix={on('input', event => { end = event.currentTarget.value; recording = false; handle.update() })} /></label>
            </div>
            <label class="mt-3 block text-xs">Note <span class="text-subtle">(optional)</span><textarea id="video-highlight-note" name="note" value={note} rows={2} maxLength={5000} disabled={busy} class={field} mix={on('input', event => { note = event.currentTarget.value; handle.update() })} /></label>
            <div class="mt-3 flex flex-wrap gap-2">
              <button type="submit" disabled={busy || recording} class={button}>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Save highlight'}</button>
              <button type="button" class={secondary} disabled={!ready || !Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart} mix={on('click', () => play(rangeStart, rangeEnd))}>Preview segment</button>
              {(editingId || recording || end) && <button type="button" disabled={busy} class={secondary} mix={on('click', () => { reset(); handle.update() })}>Cancel</button>}
            </div>
          </form>
          <form method="post" action={routes.quoteNote.href({ id: article.id })} aria-busy={busy} class="mt-7 border-t border-line pt-6" mix={on('submit', async event => {
            event.preventDefault()
            const data = await mutate(routes.quoteNote.href({ id: article.id }), new URLSearchParams({ note: savedNote }))
            if (data?.article) { article = data.article; savedNote = article.video?.note ?? ''; notice = savedNote ? 'Note saved.' : 'Note cleared.'; handle.update() }
          })}>
            <label for="video-save-note" class="text-sm font-semibold">Why I saved this</label>
            <textarea id="video-save-note" name="note" value={savedNote} rows={3} maxLength={5000} disabled={busy} class={field} placeholder="Add your thoughts…" mix={on('input', event => { savedNote = event.currentTarget.value; handle.update() })} />
            <button type="submit" class={`${button} mt-3`} disabled={busy}>Save note</button>
          </form>
          <section class="mt-8 border-t border-line pt-6" aria-labelledby="transcript-heading">
            <h2 id="transcript-heading" class="text-sm font-semibold">Transcript</h2>
            {cues.length ? <p class="mt-2 text-xs text-muted">Select a passage to highlight its time range. Click a timestamp to play from there.</p>
              : <p class="mt-2 text-xs leading-relaxed text-muted">A transcript wasn’t available. You can highlight using the player or enter times above. Import subtitles below to select passages.</p>}
            {selected && <div class="sticky top-3 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-paper p-3 shadow-sm" role="group" aria-label="Highlight selected transcript">
              <span class="text-xs text-muted">{videoTime(selected.start)}–{videoTime(selected.end)}</span>
              <button type="button" class={button} disabled={busy} mix={on('click', () => {
                if (!selected) return
                editingId = ''; void saveHighlight(new URLSearchParams({ start: editableTime(selected.start), end: editableTime(selected.end), note: '' }))
              })}>Highlight</button>
              <button type="button" class={secondary} disabled={busy} mix={on('click', async () => {
                if (!selected) return
                start = editableTime(selected.start); end = editableTime(selected.end); note = ''; editingId = ''; recording = false
                await handle.update(); document.getElementById('video-highlight-note')?.focus()
              })}>Add note</button>
            </div>}
            <div class="mt-4 space-y-3" mix={[ref(node => { transcriptElement = node }), on('pointerup', readSelection), on('keyup', readSelection)]}>
              {cues.map((cue, index) => <div key={index} class="grid grid-cols-[56px_minmax(0,1fr)] gap-3">
                <a href={`${article.url}&t=${Math.floor(cue.start / 1000)}`} target="_blank" rel="noopener noreferrer" class="pt-1 font-mono text-[11px] text-subtle underline underline-offset-4" aria-label={`Play from ${videoTime(cue.start)}`} mix={on('click', event => { if (ready) { event.preventDefault(); play(cue.start) } })}>{videoTime(cue.start)}</a>
                <p data-cue="" data-start={cue.start} data-end={cue.end} class="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{highlights.some(item => item.start < cue.end && item.end > cue.start) ? <mark class="rounded bg-highlight text-ink">{cue.text}</mark> : cue.text}</p>
              </div>)}
            </div>
            <details class="mt-5 rounded-lg border border-line p-3">
              <summary class="cursor-pointer text-xs font-medium">{cues.length ? 'Replace transcript' : 'Import transcript'}</summary>
              <form method="post" action={routes.videoTranscript.href({ id: article.id })} class="mt-3" mix={on('submit', async event => {
                event.preventDefault()
                const form = event.currentTarget
                const data = await mutate(routes.videoTranscript.href({ id: article.id }), formParams(form))
                if (data?.article) { article = data.article; selected = undefined; notice = 'Transcript saved.'; form.reset(); handle.update() }
              })}>
                <label for="video-transcript" class="text-xs text-muted">Paste WebVTT or SRT subtitles. Existing highlights keep their saved excerpts.</label>
                <textarea id="video-transcript" name="transcript" required maxLength={1000000} rows={6} disabled={busy} class={field} placeholder={'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nA useful idea…'} />
                <button type="submit" class={`${button} mt-3`} disabled={busy}>Save transcript</button>
              </form>
            </details>
          </section>
        </div>
        <aside class="min-w-0 rounded-xl border border-line bg-surface p-5" aria-labelledby="video-highlights-heading">
          <h2 id="video-highlights-heading" class="text-sm font-semibold">Highlights <span class="ml-1 text-muted">{highlights.length}</span></h2>
          {!highlights.length && <p class="mt-3 text-xs leading-relaxed text-muted">Useful moments live here. Highlight a segment while watching or select a passage in the transcript.</p>}
          <ul class="mt-4 space-y-5">
            {highlights.map(highlight => <li key={highlight.id} id={`highlight-${highlight.id}`} class="border-t border-line pt-4">
              <a href={`${article.url}&t=${Math.floor(highlight.start / 1000)}`} target="_blank" rel="noopener noreferrer" class="font-mono text-xs font-semibold underline underline-offset-4" aria-label={`Play highlight ${videoTime(highlight.start)} to ${videoTime(highlight.end)}`} mix={on('click', event => { if (ready) { event.preventDefault(); play(highlight.start, highlight.end) } })}>{videoTime(highlight.start)}–{videoTime(highlight.end)}</a>
              <blockquote class="mt-2 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{highlight.quote}</blockquote>
              {highlight.note && <p class="mt-2 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-muted">{highlight.note}</p>}
              <div class="mt-3 flex gap-3">
                <a href={routes.article.href({ id: article.id }, { searchParams: { editHighlight: highlight.id } }) + '#video-highlight-note'} class="text-xs text-muted underline underline-offset-4" aria-disabled={busy} mix={on('click', async event => {
                  event.preventDefault()
                  if (busy) return
                  editingId = highlight.id; start = editableTime(highlight.start); end = editableTime(highlight.end); note = highlight.note; recording = false
                  await handle.update(); document.getElementById('video-highlight-note')?.focus()
                })}>Edit</a>
                <form method="post" action={routes.deleteHighlight.href({ id: article.id, highlightId: highlight.id })} mix={on('submit', async event => {
                  event.preventDefault()
                  const data = await mutate(routes.deleteHighlight.href({ id: article.id, highlightId: highlight.id }), new URLSearchParams())
                  if (data?.deleted) { highlights = highlights.filter(item => item.id !== highlight.id); if (editingId === highlight.id) reset(); notice = 'Highlight removed.'; handle.update() }
                })}><button type="submit" disabled={busy} class="text-xs text-muted underline underline-offset-4">Remove</button></form>
              </div>
            </li>)}
          </ul>
        </aside>
      </div>
    </article>
  }
})
