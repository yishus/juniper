import { clientEntry, on, type Handle } from 'remix/component'
import type { Article } from '../../data/types.ts'
import { routes } from '../../routes.ts'

export const QuoteView = clientEntry(import.meta.url + '#QuoteView', function QuoteView(handle: Handle<{ article: Article; initialError?: string; noteDraft?: string }>) {
  let note = handle.props.noteDraft ?? handle.props.article.quote?.note ?? ''
  let savedNote = handle.props.article.quote?.note ?? ''
  let busy = false
  let error = handle.props.initialError ?? ''
  let notice = ''

  return () => {
    const article = handle.props.article
    return <article class="mx-auto max-w-[720px] py-12 max-[760px]:py-8" aria-labelledby="quote-heading">
      <h1 id="quote-heading" class="mb-6 font-mono text-xs text-subtle">Saved quote · X</h1>
      <blockquote class="font-serif text-[28px] leading-relaxed whitespace-pre-wrap wrap-anywhere max-[760px]:text-[23px]">{article.quote?.text ?? article.text}</blockquote>
      <div class="mt-7 text-sm text-muted">
        <p class="font-semibold text-ink">{article.author ?? 'X post'}</p>
        {article.quote?.handle && <p class="mt-1 text-xs">@{article.quote.handle}</p>}
        <a class="mt-3 inline-block text-xs underline underline-offset-4" href={article.url} target="_blank" rel="noreferrer">View original post ↗</a>
        <p class="mt-3 text-xs text-subtle">Saved {new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(article.savedAt))}</p>
      </div>
      <form method="post" action={routes.quoteNote.href({ id: article.id })} class="mt-10 border-t border-line pt-6" aria-busy={busy} mix={on('submit', async event => {
        event.preventDefault()
        if (busy) return
        busy = true; error = ''; notice = ''
        const body = new URLSearchParams({ note })
        await handle.update()
        try {
          const response = await fetch(routes.quoteNote.href({ id: article.id }), { method: 'POST', body, headers: { Accept: 'application/json' }, signal: handle.signal })
          const result = await response.json() as { article?: Article; error?: string }
          if (!response.ok || !result.article) throw new Error(result.error ?? 'Could not save your note.')
          note = savedNote = result.article.quote?.note ?? ''
          notice = note ? 'Note saved.' : 'Note cleared.'
        } catch (failure) { if (!handle.signal.aborted) error = (failure as Error).message }
        finally { if (!handle.signal.aborted) { busy = false; handle.update() } }
      })}>
        <label for="quote-note" class="text-sm font-semibold">Why I saved this</label>
        <textarea id="quote-note" name="note" rows={4} maxLength={5000} value={note} disabled={busy} placeholder="Add your thoughts…" class="mt-3 block w-full rounded-lg border border-line-strong bg-paper p-3 text-sm leading-relaxed outline-none focus:border-ink" mix={on('input', event => { note = event.currentTarget.value; notice = ''; handle.update() })} />
        <button type="submit" disabled={busy} class="mt-3 rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-paper hover:bg-accent-hover disabled:opacity-60">{busy ? 'Saving…' : 'Save note'}</button>
        {savedNote && <button type="button" disabled={busy} class="ml-3 text-xs text-muted underline underline-offset-4" mix={on('click', () => { note = ''; notice = ''; handle.update() })}>Clear text</button>}
        <p aria-live="polite" class="mt-3 text-xs text-muted">{notice}</p>
        {error && <p role="alert" class="mt-3 text-xs">{error}</p>}
      </form>
    </article>
  }
})
