import { clientEntry, on, ref, type Handle } from 'remix/component'
import type { ArticleSummary, QuoteDraft } from '../../data/types.ts'
import { xPost } from './x-post.ts'
import { youtubeVideo, videoTime } from './youtube.ts'
import { routes } from '../../routes.ts'
import { ArrowPathIcon, ArrowUpIcon, BookmarkIcon, DocumentTextIcon, EllipsisVerticalIcon, LinkIcon, MagnifyingGlassIcon, TrashIcon, XMarkIcon } from './icons.tsx'

export const Library = clientEntry(import.meta.url + '#Library', function Library(handle: Handle<{ articles: ArticleSummary[]; initialError?: string; initialDraft?: QuoteDraft; initialBookmark?: boolean; initialUrl?: string }>) {
  let articles = handle.props.articles
  let query = ''
  let sort = 'newest'
  let kind = 'all'
  let draft = handle.props.initialDraft
  let urlValue = draft?.url ?? handle.props.initialUrl ?? ''
  let bookmark = handle.props.initialBookmark ?? false
  let pending = false
  let deletingId = ''
  let updatingId = ''
  let error = handle.props.initialError ?? ''
  let notice = ''
  let popoverOpen = false
  let popover: HTMLElement | undefined
  let urlInput: HTMLInputElement | undefined

  async function deleteArticle(article: ArticleSummary) {
    if (deletingId || updatingId) return
    const row = document.getElementById(`saved-article-${article.id}`)
    const nextLink = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector<HTMLAnchorElement>('[data-article-link]')
    deletingId = article.id; error = ''; notice = ''
    await handle.update()
    try {
      const response = await fetch(routes.deleteArticle.href({ id: article.id }), { method: 'POST', headers: { Accept: 'application/json' }, signal: handle.signal })
      const result = await response.json() as { deleted?: boolean; error?: string }
      if (handle.signal.aborted) return
      if (response.status !== 404 && (!response.ok || !result.deleted)) throw new Error(result.error ?? 'Could not delete this article. Please try again.')
      articles = articles.filter(item => item.id !== article.id)
      if (!articles.length) query = ''
      notice = article.kind === 'bookmark' ? 'Bookmark deleted.' : article.kind === 'video' ? 'Video deleted.' : article.kind === 'quote' ? 'Quote deleted.' : 'Article deleted.'
      await handle.update()
      if (nextLink?.isConnected) nextLink.focus({ preventScroll: true })
      else document.getElementById('add-article-trigger')?.focus({ preventScroll: true })
    } catch (failure) {
      if (!handle.signal.aborted) error = failure instanceof Error ? failure.message : 'Could not delete this article. Please try again.'
    } finally { if (!handle.signal.aborted) { deletingId = ''; handle.update() } }
  }

  async function setReadingList(article: ArticleSummary, included: boolean) {
    if (deletingId || updatingId) return
    let updated = false
    updatingId = article.id; error = ''; notice = ''
    await handle.update()
    try {
      const response = await fetch(routes.readingList.href({ id: article.id }), {
        method: 'POST', body: new URLSearchParams({ included: String(included) }),
        headers: { Accept: 'application/json' }, signal: handle.signal,
      })
      const result = await response.json() as { article?: ArticleSummary; error?: string }
      if (handle.signal.aborted) return
      if (!response.ok || !result.article) throw new Error(result.error ?? 'Could not update your reading list. Please try again.')
      articles = articles.map(item => item.id === article.id ? result.article! : item)
      notice = included ? 'Added to reading list.' : 'Removed from reading list.'
      updated = true
    } catch (failure) {
      if (!handle.signal.aborted) error = failure instanceof Error ? failure.message : 'Could not update your reading list. Please try again.'
    } finally {
      if (!handle.signal.aborted) {
        updatingId = ''; await handle.update()
        if (updated) (document.getElementById(`saved-actions-${article.id}`) ?? document.getElementById('to-read-title'))?.focus({ preventScroll: true })
      }
    }
  }

  function positionPopover() {
    const trigger = document.getElementById('add-article-trigger')
    if (!trigger || !popover?.hasAttribute('popover')) return
    const bounds = trigger.getBoundingClientRect()
    const top = Math.max(16, bounds.bottom + 8)
    const viewportWidth = document.documentElement.clientWidth
    const width = popover.offsetWidth || Math.min(400, viewportWidth - 32)
    popover.style.top = `${top}px`
    popover.style.right = `${Math.max(16, Math.min(viewportWidth - bounds.right, viewportWidth - width - 16))}px`
    popover.style.maxHeight = `calc(100dvh - ${top + 16}px)`
  }

  handle.queueTask(() => {
    if (handle.props.initialError && popover?.hasAttribute('popover')) popover.showPopover()
  })

  return () => {
    const filtered = articles.filter(article => (kind === 'all' || (article.kind ?? 'article') === kind) && `${article.title} ${article.quote?.text ?? article.description} ${article.video?.note ?? article.quote?.note ?? ''} ${article.quote?.handle ?? ''} ${article.site} ${article.url} ${article.author ?? ''}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => sort === 'oldest' ? a.savedAt.localeCompare(b.savedAt) : sort === 'title' ? a.title.localeCompare(b.title) : b.savedAt.localeCompare(a.savedAt))
    const toRead = articles.filter(article => article.kind === 'article' && article.inReadingList)
    const busyId = deletingId || updatingId

    return <div class="pt-8 pb-12 max-[760px]:pt-6 min-[1400px]:pt-10">
      <section
        id="add-article"
        popover={handle.props.initialDraft ? undefined : 'auto'}
        role="dialog"
        aria-labelledby="add-article-title"
        class={handle.props.initialDraft ? 'mb-8 rounded-xl border border-line bg-paper p-5 text-ink' : 'fixed inset-auto top-[76px] right-4 m-0 max-h-[calc(100dvh-96px)] w-[400px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-line bg-paper p-5 text-ink shadow-lg'}
        mix={[
          ref((node, signal) => {
            popover = node
            window.addEventListener('resize', positionPopover, { signal })
            window.addEventListener('scroll', positionPopover, { signal, passive: true })
          }),
          on('beforetoggle', event => {
            if ((event as ToggleEvent).newState === 'open') positionPopover()
          }),
          on('toggle', event => {
            popoverOpen = (event as ToggleEvent).newState === 'open'
            handle.update()
            if (popoverOpen && !pending) urlInput?.focus()
          }),
        ]}
      >
        <div class="mb-4 flex items-center justify-between gap-4">
          <h2 id="add-article-title" class="text-sm font-semibold">{draft ? 'Review quote' : 'Add to your library'}</h2>
          {handle.props.initialDraft ? <a href={routes.home.href()} class="text-xs underline">Cancel</a> : <button type="button" popoverTarget="add-article" popoverTargetAction="hide" aria-label="Close add form" class="flex size-7 items-center justify-center rounded-md text-subtle hover:bg-control hover:text-ink"><XMarkIcon class="size-4" /></button>}
        </div>
        <form method="post" action={routes.save.href()} aria-busy={pending} mix={on('submit', async event => {
          event.preventDefault()
          if (pending) return
          const form = event.currentTarget
          const data = new FormData(form, event.submitter)
          pending = true; error = ''; notice = ''
          await handle.update()
          try {
            const response = await fetch(routes.save.href(), { method: 'POST', body: data, headers: { Accept: 'application/json' }, signal: handle.signal })
            const result = await response.json() as { article?: ArticleSummary; draft?: QuoteDraft; duplicate?: boolean; error?: string }
            if (response.ok && result.draft) {
              draft = result.draft; urlValue = draft.url
              await handle.update()
              form.querySelector<HTMLTextAreaElement>('[name="quoteText"]')?.focus()
              return
            }
            if (!response.ok || !result.article) throw new Error(result.error ?? 'We could not save this article. Please try again.')
            const article = result.article
            articles = [article, ...articles.filter(item => item.id !== article.id)]
            query = ''
            kind = 'all'
            notice = result.duplicate ? 'This item is already in your library.' : article.kind === 'bookmark' ? 'Bookmark saved.' : article.kind === 'video' ? 'Video saved. Open it to highlight moments.' : article.kind === 'quote' ? 'Quote saved.' : article.warnings.length ? `Article saved. ${article.warnings.length} image${article.warnings.length === 1 ? '' : 's'} could not be downloaded.` : 'Article saved.'
            form.reset()
            draft = undefined; urlValue = ''; bookmark = false
            if (popover?.hasAttribute('popover')) popover.hidePopover()
          } catch (failure) {
            if (handle.signal.aborted) return
            error = failure instanceof Error ? failure.message : 'Something went wrong. Please try again.'
          } finally {
            if (!handle.signal.aborted) { pending = false; handle.update() }
          }
        })}>
          <label class="sr-only" for="article-url">Website, article, YouTube video, or X post URL</label>
          <div class="flex items-center gap-2.5 rounded-lg border border-line-strong px-3 focus-within:border-ink focus-within:ring-2 focus-within:ring-control">
            <span class="shrink-0 text-subtle [&>svg]:size-4" aria-hidden="true"><LinkIcon /></span>
            <input id="article-url" class="w-full min-w-0 bg-transparent py-3 text-sm outline-none placeholder:text-subtle disabled:opacity-60 max-[760px]:text-base" name="url" type="url" placeholder={bookmark ? 'Paste a website URL…' : 'Paste an article, YouTube, or X URL…'} required maxLength={4096} autoComplete="url" autoFocus disabled={pending} readOnly={Boolean(draft)} value={urlValue} mix={[ref(node => { urlInput = node }), on('input', event => { urlValue = event.currentTarget.value; handle.update() })]} />
          </div>
          {!draft && <label class="mt-4 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed">
            <input name="kind" type="checkbox" value="bookmark" checked={bookmark} disabled={pending} class="mt-0.5 size-3.5 shrink-0 accent-ink" mix={on('change', event => { bookmark = event.currentTarget.checked; handle.update() })} />
            <span><span class="block font-medium">Save as bookmark</span><span class="text-muted">Keep a beautiful website to revisit. Opens the original site.</span></span>
          </label>}
          {draft && <div class="mt-4 space-y-3">
            {draft.warning && <p class="text-xs leading-relaxed text-muted" role="status">{draft.warning}</p>}
            <label class="block text-xs font-medium" for="quote-text">Quote text</label>
            <textarea id="quote-text" name="quoteText" rows={7} required maxLength={25000} value={draft.text} disabled={pending} class="block w-full rounded-lg border border-line-strong bg-paper p-3 text-sm leading-relaxed outline-none focus:border-ink" mix={on('input', event => { if (draft) { draft.text = event.currentTarget.value; handle.update() } })} />
            <label class="block text-xs font-medium" for="quote-author">Author</label>
            <input id="quote-author" name="author" maxLength={200} value={draft.author} disabled={pending} class="block w-full rounded-lg border border-line-strong bg-paper p-2.5 text-sm outline-none focus:border-ink" mix={on('input', event => { if (draft) { draft.author = event.currentTarget.value; handle.update() } })} />
            <label class="block text-xs font-medium" for="quote-save-note">Why I saved this <span class="font-normal text-subtle">(optional)</span></label>
            <textarea id="quote-save-note" name="note" rows={3} maxLength={5000} value={draft.note} disabled={pending} class="block w-full rounded-lg border border-line-strong bg-paper p-3 text-sm outline-none focus:border-ink" mix={on('input', event => { if (draft) { draft.note = event.currentTarget.value; handle.update() } })} />
            <p class="text-xs text-subtle">Saving this post’s text. Threads and media aren’t included.</p>
          </div>}
          <button class="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-xs font-semibold text-paper transition-colors hover:bg-accent-hover disabled:opacity-60" type="submit" disabled={pending}>
            {pending && <ArrowPathIcon class="size-4 animate-spin" />}
            {pending ? bookmark ? 'Saving bookmark…' : draft ? 'Saving quote…' : xPost(urlValue) ? 'Capturing quote…' : youtubeVideo(urlValue) ? 'Saving video…' : 'Saving item…' : bookmark ? 'Save bookmark' : draft ? 'Save quote' : xPost(urlValue) ? 'Preview quote' : youtubeVideo(urlValue) ? 'Save video' : 'Save item'}
          </button>
          {draft ? <button type="button" disabled={pending} class="mt-3 text-xs text-muted underline underline-offset-4" mix={on('click', () => { draft = undefined; error = ''; handle.update() })}>Change link</button> : !bookmark && <button type="submit" name="capture" value="manual" disabled={pending} class="mt-3 text-xs text-muted underline underline-offset-4">Paste quote text instead (X link)</button>}
        </form>
        {error && <p class="mt-3 rounded-lg border border-line-strong border-l-[3px] border-l-ink bg-surface p-3 text-xs" role="alert">{error}</p>}
      </section>

      <div aria-live="polite" aria-atomic="true">
        {error && !popoverOpen && <p class="mb-5 rounded-lg border border-line-strong border-l-[3px] border-l-ink bg-surface px-3.5 py-2.5 text-xs" role="alert">{error}</p>}
        {notice && <p class="mb-5 rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 text-xs">{notice}</p>}
      </div>
      <section aria-labelledby="to-read-title" class="mb-9">
        <h2 id="to-read-title" tabIndex={-1} class="mb-4 flex items-center gap-2 text-sm font-semibold">To read <span class="inline-flex h-[23px] min-w-[23px] items-center justify-center rounded-md border border-line bg-surface px-1.5 font-mono text-[11px] leading-none text-muted">{toRead.length}</span></h2>
        {toRead.length ? <ul class="rounded-xl border border-line bg-surface px-4">
          {toRead.map(article => <li key={article.id} class="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
            <form method="post" action={routes.readingList.href({ id: article.id })} mix={on('submit', event => { event.preventDefault(); void setReadingList(article, false) })}>
              <input type="hidden" name="included" value="false" />
              <button type="submit" disabled={Boolean(busyId)} aria-label={`Mark ${article.title} as read`} title="Mark as read" class="flex size-8 items-center justify-center rounded-md text-muted hover:bg-control hover:text-ink disabled:opacity-50">
                {busyId === article.id ? <ArrowPathIcon class="size-4 animate-spin" /> : <span class="size-4 rounded border border-line-strong bg-paper" aria-hidden="true" />}
              </button>
            </form>
            <a class="min-w-0 flex-1 rounded-sm hover:underline hover:underline-offset-4" href={routes.article.href({ id: article.id })}>
              <span class="block truncate text-sm font-medium">{article.title}</span>
              <span class="mt-0.5 block truncate font-mono text-[10px] text-subtle">{article.site} · {article.readingMinutes} min read</span>
            </a>
            <ArticleActions article={article} scope="reading" busyId={busyId} onDelete={deleteArticle} onReadingList={setReadingList} />
          </li>)}
        </ul> : <p class="rounded-xl border border-dashed border-line-strong bg-surface px-4 py-5 text-xs leading-relaxed text-muted">Your next reads go here. Use an article’s three-dot menu to add it to your reading list.</p>}
      </section>
      <section aria-labelledby="collection-title">
        <div class="flex items-center justify-between gap-5 pb-[18px] max-[760px]:flex-col max-[760px]:items-start max-[760px]:gap-4">
          <h1 id="collection-title" class="flex items-center gap-2 text-sm font-semibold whitespace-nowrap">Library <span class="inline-flex h-[23px] min-w-[23px] items-center justify-center rounded-md border border-line bg-surface px-1.5 font-mono text-[11px] leading-none text-muted">{articles.length}</span></h1>
          <div class="flex min-w-0 items-center gap-2.5 max-[760px]:w-full max-[420px]:flex-wrap">
            <div class="flex min-h-9 items-center gap-1.5 rounded-[7px] border border-line bg-paper px-2.5 focus-within:border-ink max-[760px]:min-h-11 max-[760px]:min-w-0 max-[760px]:flex-1 max-[420px]:basis-full">
              <span aria-hidden="true" class="text-subtle [&>svg]:size-4"><MagnifyingGlassIcon /></span>
              <label class="sr-only" for="search">Search your library</label>
              <input id="search" class="w-[140px] min-w-0 bg-transparent py-[5px] text-xs outline-none placeholder:text-subtle max-[760px]:w-full" type="search" placeholder="Search your list" value={query} mix={on('input', event => { query = event.currentTarget.value; handle.update() })} />
            </div>
            <label class="sr-only" for="sort">Sort articles</label>
            <select id="sort" class="min-h-9 max-w-[140px] cursor-pointer rounded-[7px] border border-line bg-paper px-[9px] py-1.5 text-xs text-muted max-[760px]:min-h-11 max-[760px]:max-w-full" value={sort} mix={on('change', event => { sort = event.currentTarget.value; handle.update() })}>
              <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title A–Z</option>
            </select>
          </div>
        </div>
        <div class="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by type">
          {(['all', 'article', 'quote', 'video', 'bookmark'] as const).map(value => <button type="button" aria-pressed={kind === value} class={`min-h-9 rounded-md border px-3 py-1.5 text-xs max-[760px]:min-h-11 ${kind === value ? 'border-ink bg-ink text-paper' : 'border-line text-muted hover:bg-control'}`} mix={on('click', () => { kind = value; handle.update() })}>{value === 'all' ? 'All' : value === 'article' ? 'Articles' : value === 'video' ? 'Videos' : value === 'bookmark' ? 'Bookmarks' : 'Quotes'}</button>)}
        </div>
        {!articles.length ? <div class="canvas-dots flex min-h-[366px] flex-col items-center justify-center rounded-xl border border-line bg-surface px-6 py-8 text-center max-[420px]:px-4 min-[1400px]:min-h-[390px]">
          <div class="mb-[22px] text-ink" aria-hidden="true"><DocumentTextIcon class="size-20" /></div>
          <p class="mb-2.5 font-mono text-[9px] tracking-[1px] text-subtle">THE START OF SOMETHING GOOD</p>
          <h3 class="mb-3 text-2xl leading-[1.3] font-semibold tracking-[-.8px] max-[760px]:text-[22px] max-[420px]:text-[21px]">Leave a little something for later.</h3>
          <p class="text-xs leading-[1.8] text-muted">An interesting idea. A beautifully made website.<br />Save an article, video, quote, or bookmark.</p>
          <button class="mt-[22px] flex items-center gap-2.5 rounded-full border border-line-strong bg-paper px-3.5 py-2 text-[11px] font-medium transition-colors hover:border-ink hover:bg-control" type="button" popoverTarget="add-article">Save your first item <ArrowUpIcon class="size-3.5" /></button>
        </div> : !filtered.length ? <div class="rounded-xl border border-line bg-surface px-5 py-[70px] text-center">
          <span class="text-subtle [&>svg]:mx-auto"><MagnifyingGlassIcon /></span>
          <h3 class="my-[15px] text-2xl font-semibold tracking-[-.7px]">No items found</h3>
          <p class="my-3 text-xs text-muted">Try another title, author, or website.</p>
          <button type="button" class="text-xs underline underline-offset-4" mix={on('click', () => { query = ''; kind = 'all'; handle.update() })}>Clear filters</button>
        </div> : <div class="border-t border-line">{filtered.map(article => <ArticleRow key={article.id} article={article} busyId={busyId} onDelete={deleteArticle} onReadingList={setReadingList} />)}</div>}
      </section>
    </div>
  }
})

interface ArticleActionProps {
  article: ArticleSummary
  busyId: string
  onDelete: (article: ArticleSummary) => Promise<void>
  onReadingList: (article: ArticleSummary, included: boolean) => Promise<void>
}

function ArticleRow(handle: Handle<ArticleActionProps>) {
  return () => {
    const article = handle.props.article
    const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(article.savedAt))
    if (article.kind === 'quote') return <article id={`saved-article-${article.id}`} class="relative border-b border-line">
      <a data-article-link="" href={routes.article.href({ id: article.id })} class="block rounded-md py-6 pr-12 hover:bg-surface" aria-labelledby={`article-title-${article.id}`}>
        <p class="mb-3 font-mono text-[10px] text-subtle">Quote · X</p>
        <blockquote id={`article-title-${article.id}`} class="font-serif text-xl leading-relaxed whitespace-pre-wrap wrap-anywhere max-[760px]:text-lg">{article.quote?.text ?? article.description}</blockquote>
        <div class="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span class="font-medium text-ink">{article.author ?? 'X post'}</span>
          {article.quote?.handle && <span>@{article.quote.handle}</span>}
          <span aria-hidden="true">·</span><time dateTime={article.savedAt}>{date}</time>
        </div>
        {article.quote?.note && <p class="mt-3 line-clamp-2 text-xs leading-relaxed text-muted">{article.quote.note}</p>}
      </a>
      <div class="absolute top-5 right-0"><ArticleActions {...handle.props} scope="saved" /></div>
    </article>
    return <article id={`saved-article-${article.id}`} class="relative border-b border-line">
      <a data-article-link="" class="group flex items-start gap-[22px] rounded-md py-[26px] transition-colors hover:bg-surface max-[760px]:grid max-[760px]:grid-cols-[64px_minmax(0,1fr)] max-[760px]:gap-x-3 max-[760px]:gap-y-2 max-[760px]:py-5 max-[420px]:grid-cols-[60px_minmax(0,1fr)]" href={article.kind === 'bookmark' ? article.url : routes.article.href({ id: article.id })} target={article.kind === 'bookmark' ? '_blank' : undefined} rel={article.kind === 'bookmark' ? 'noopener noreferrer' : undefined} aria-labelledby={`article-title-${article.id}`}>
      <div class="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface text-subtle max-[760px]:row-span-2 max-[760px]:size-16 max-[420px]:size-[60px] [&>svg]:size-[30px]" aria-hidden="true">
        {article.image ? <img class="size-full object-cover" src={article.image} alt="" loading="lazy" /> : <BookmarkIcon />}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 font-mono text-[10px] text-subtle max-[760px]:flex-wrap max-[760px]:gap-x-1.5 max-[760px]:gap-y-1">{article.kind === 'bookmark' ? <>Bookmark <span>·</span> {new URL(article.url).hostname.replace(/^www\./, '')} <span class="sr-only">(opens in a new tab)</span></> : article.kind === 'video' ? `Video · YouTube${article.video?.duration ? ` · ${videoTime(article.video.duration)}` : ''}${article.author ? ` · ${article.author}` : ''}` : <>{article.site} <span>·</span> {article.readingMinutes} min read</>}</div>
        <h3 id={`article-title-${article.id}`} class="group-hover:underline group-hover:underline-offset-4 mt-[7px] mb-[9px] text-[21px] leading-[1.35] font-semibold tracking-[-.6px] max-[760px]:text-[19px] max-[420px]:text-[17px]">{article.title}</h3>
        <p class="line-clamp-2 text-xs leading-[1.8] text-muted">{article.video?.note || article.description || (article.kind === 'video' ? 'Open this video to highlight useful moments.' : '')}</p>
        {article.warnings.length > 0 && <div class="mt-[11px] text-[10px] text-muted"><span class="underline decoration-dotted underline-offset-3" title={article.warnings.join('\n')}>Some images unavailable</span></div>}
      </div>
      <div class="flex w-[105px] shrink-0 flex-col items-end gap-3.5 pt-0.5 text-right max-[760px]:col-start-2 max-[760px]:min-h-11 max-[760px]:w-auto max-[760px]:items-start max-[760px]:justify-center max-[760px]:pr-12 max-[760px]:pt-0 max-[760px]:text-left">
        <time class="font-mono text-[10px] text-subtle" dateTime={article.savedAt}>{date}</time>
      </div>
      </a>
      <div class="absolute top-[56px] right-0 max-[760px]:top-auto max-[760px]:bottom-5">
        <ArticleActions {...handle.props} scope="saved" />
      </div>
    </article>
  }
}

function ArticleActions(handle: Handle<ArticleActionProps & { scope: 'saved' | 'reading' }>) {
  let trigger: HTMLButtonElement | undefined
  let popover: HTMLDivElement | undefined
  let open = false

  function position() {
    if (!trigger || !popover) return
    const bounds = trigger.getBoundingClientRect()
    const height = popover.offsetHeight || 96
    popover.style.top = `${Math.max(8, bounds.bottom + height + 8 > window.innerHeight ? bounds.top - height - 6 : bounds.bottom + 6)}px`
    popover.style.left = `${Math.max(8, Math.min(bounds.right - 240, document.documentElement.clientWidth - 248))}px`
  }

  function close() {
    popover?.hidePopover()
    trigger?.focus({ preventScroll: true })
  }

  return () => {
    const { article, scope, busyId } = handle.props
    const id = `${scope}-menu-${article.id}`
    return <div>
      <button id={`${scope}-actions-${article.id}`} type="button" popoverTarget={id} aria-label={`Actions for ${article.title}`} aria-expanded={open ? 'true' : 'false'} aria-controls={id} title="Item actions" disabled={Boolean(busyId)} class="flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-control hover:text-ink disabled:opacity-50 max-[760px]:size-11" mix={ref(node => { trigger = node })}>
        {busyId === article.id ? <ArrowPathIcon class="size-4 animate-spin" /> : <EllipsisVerticalIcon class="size-5" />}
      </button>
      <div id={id} popover="auto" aria-label={`Actions for ${article.title}`} class="fixed inset-auto m-0 w-[240px] max-w-[calc(100vw-16px)] rounded-lg border border-line bg-paper p-1.5 text-ink shadow-lg" mix={[
        ref((node, signal) => {
          popover = node
          const reposition = () => { if (popover?.matches(':popover-open')) position() }
          window.addEventListener('resize', reposition, { signal })
          window.addEventListener('scroll', reposition, { signal, passive: true })
        }),
        on('beforetoggle', event => { if ((event as ToggleEvent).newState === 'open') position() }),
        on('toggle', event => {
          open = (event as ToggleEvent).newState === 'open'
          handle.update()
          if (open) popover?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
        }),
      ]}>
        {article.kind === 'article' && <form method="post" action={routes.readingList.href({ id: article.id })} mix={on('submit', event => {
          event.preventDefault(); close(); void handle.props.onReadingList(article, !article.inReadingList)
        })}>
          <input type="hidden" name="included" value={String(!article.inReadingList)} />
          <button type="submit" disabled={Boolean(busyId)} class="flex min-h-10 w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs hover:bg-control disabled:opacity-50"><BookmarkIcon class="size-4" />{article.inReadingList ? 'Remove from reading list' : 'Add to reading list'}</button>
        </form>}
        <form method="post" action={routes.deleteArticle.href({ id: article.id })} mix={on('submit', event => {
          event.preventDefault(); close(); void handle.props.onDelete(article)
        })}>
          <button type="submit" aria-label={`Delete ${article.title}`} disabled={Boolean(busyId)} class="flex min-h-10 w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs hover:bg-control disabled:opacity-50"><TrashIcon class="size-4" />Delete</button>
        </form>
      </div>
    </div>
  }
}

