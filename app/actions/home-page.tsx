import type { Handle } from 'remix/component'
import type { ArticleSummary, QuoteDraft } from '../data/types.ts'
import { AppShell } from '../ui/app-shell.tsx'
import { Library } from './public/library.tsx'
import { PlusIcon } from './public/icons.tsx'

export function HomePage(handle: Handle<{ articles: ArticleSummary[]; error?: string; draft?: QuoteDraft; bookmark?: boolean; submittedUrl?: string }>) {
  return () => (
    <AppShell title="Juniper — Your library" nav={
      <button id="add-article-trigger" type="button" popoverTarget="add-article" aria-label="Add item" title="Add item" class="flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-control hover:text-ink"><PlusIcon /></button>
    }>
      <Library articles={handle.props.articles} initialError={handle.props.error} initialDraft={handle.props.draft} initialBookmark={handle.props.bookmark} initialUrl={handle.props.submittedUrl} />
    </AppShell>
  )
}
