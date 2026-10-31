import type { Handle } from 'remix/component'
import type { Article } from '../data/types.ts'
import { articleMarkdown } from '../data/markdown.ts'
import { routes } from '../routes.ts'
import { AppShell } from '../ui/app-shell.tsx'
import { Reader } from './public/reader.tsx'
import { ArrowLeftIcon } from './public/icons.tsx'
import type { Highlight } from './public/highlight-model.ts'
import { QuoteView } from './public/quote-view.tsx'
import { VideoView } from './public/video-view.tsx'

export function ArticlePage(handle: Handle<{ article: Article; highlights: Highlight[]; error?: string; noteDraft?: string; editHighlightId?: string }>) {
  const article = handle.props.article
  const nodes = articleMarkdown(article)
  return () => <AppShell title={`${article.title} — Juniper`} nav={<BackLink />}>
    {article.kind === 'video' ? <VideoView article={article} highlights={handle.props.highlights} initialError={handle.props.error} noteDraft={handle.props.noteDraft} editHighlightId={handle.props.editHighlightId} />
      : article.kind === 'quote' ? <QuoteView article={article} initialError={handle.props.error} noteDraft={handle.props.noteDraft} />
      : <Reader article={{ id: article.id, title: article.title, url: article.url, author: article.author, site: article.site, readingMinutes: article.readingMinutes }} nodes={nodes} highlights={handle.props.highlights} />}
  </AppShell>
}

function BackLink() {
  return () => <a class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-control hover:text-ink" href={routes.home.href()}><ArrowLeftIcon class="size-3.5" />Library</a>
}

export function ArticleNotFoundPage() {
  return () => <AppShell title="Article not found — Juniper" nav={<BackLink />}>
    <div class="mx-auto max-w-[720px] py-16">
      <h1 class="text-2xl font-semibold tracking-tight">Article not found</h1>
      <a class="mt-5 inline-block text-sm text-muted underline underline-offset-4" href={routes.home.href()}>Return to your reading list</a>
    </div>
  </AppShell>
}
