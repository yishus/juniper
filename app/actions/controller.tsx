import { createController } from 'remix/router'
import type { AppContext } from '../router.ts'
import { assets } from '../assets.ts'
import { routes } from '../routes.ts'
import { HomePage } from './home-page.tsx'
import { ArticlePage, ArticleNotFoundPage } from './article-page.tsx'
import { ArticleStore } from '../data/articles.ts'
import { HighlightStore } from '../data/highlights.ts'
import { articleMarkdown } from '../data/markdown.ts'
import { markdownText, validateHighlight, validateNote } from './public/highlight-model.ts'
import type { AppEnv, Article, QuoteDraft } from '../data/types.ts'
import { xPost } from './public/x-post.ts'
import { ImportError, readLimited, type Fetcher } from '../data/network.ts'
import { handleMcp } from './mcp.ts'
import { CurrentUser, authConfigured, safeReturnTo, getAuth, issueMcpToken } from '../data/accounts.ts'
import { handleAuthRequest, submitAuthForm } from './auth-requests.ts'
import { AccountPage } from './account-page.tsx'
import { LoginPage } from './login-page.tsx'
import { validateVideoHighlight } from './public/youtube.ts'
import { database } from '../data/database.ts'
import { mcpTokens } from '../data/schema.ts'
import { eq } from 'drizzle-orm'

export function createAppController(env?: AppEnv, fetcher?: Fetcher) {
  const storeFor = (context: AppContext) => env ? new ArticleStore(env, context.get(CurrentUser)!.id, fetcher) : null
  const highlightsFor = (context: AppContext) => env ? new HighlightStore(env.DB, context.get(CurrentUser)!.id) : null
  const authPage = (context: AppContext, signup = false) => {
    const returnTo = safeReturnTo(context.url.searchParams.get('returnTo'), context.url.origin)
    if (context.get(CurrentUser)) return new Response(null, { status: 302, headers: { Location: returnTo } })
    return context.render(<LoginPage signup={signup} returnTo={returnTo} siteKey={env?.TURNSTILE_SITE_KEY} unavailable={!authConfigured(env)} />, { status: authConfigured(env) ? 200 : 503 })
  }
  const submit = async (context: AppContext, signup = false) => {
    if (!authConfigured(env)) return authPage(context, signup)
    const result = await submitAuthForm(context.request, env, signup)
    if (result.response) return result.response
    return context.render(<LoginPage signup={signup} returnTo={result.returnTo} siteKey={env.TURNSTILE_SITE_KEY} email={result.email} error={result.error} />, { status: result.status, headers: result.retryAfter ? { 'Retry-After': result.retryAfter } : {} })
  }
  const accountPage = async (context: AppContext, token?: string) => {
    const user = context.get(CurrentUser)!
    const saved = await database(env!.DB).select({ createdAt: mcpTokens.createdAt }).from(mcpTokens).where(eq(mcpTokens.userId, user.id)).get()
    return context.render(<AccountPage email={user.email} token={token} tokenCreatedAt={saved?.createdAt} endpoint={new URL('/mcp', env!.BETTER_AUTH_URL).href} />)
  }

  async function mutateHighlight(context: AppContext, articleId: string, action: 'create' | 'note' | 'delete', highlightId?: string) {
    const request = context.request
    const store = storeFor(context)
    const highlights = highlightsFor(context)
    const origin = request.headers.get('Origin')
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return Response.json({ error: 'Please edit highlights from Juniper.' }, { status: 403 })
    if (!store || !highlights) return Response.json({ error: 'Article storage is unavailable.' }, { status: 503 })
    let article: Article | null
    try { article = await store.get(articleId) } catch {
      return Response.json({ error: 'Could not load this article. Please try again.' }, { status: 503 })
    }
    if (!article) return Response.json({ error: 'Article not found.' }, { status: 404 })
    if (article.kind === 'bookmark') return Response.json({ error: 'Bookmarks do not have highlights.' }, { status: 422 })
    const formSubmission = article.kind === 'video' && !request.headers.get('Content-Type')?.includes('application/json')
    const native = formSubmission && !request.headers.get('Accept')?.includes('application/json')
    const fail = async (message: string, status: number) => native
      ? context.render(<ArticlePage article={article} highlights={await highlights.list(articleId)} error={message} editHighlightId={highlightId} />, { status })
      : Response.json({ error: message }, { status })
    const success = (result: object, status = 200) => native
      ? new Response(null, { status: 303, headers: { Location: routes.article.href({ id: articleId }) } })
      : Response.json(result, { status })
    let data: Record<string, unknown>
    try {
      const raw = new TextDecoder().decode(await readLimited(new Response(request.body, { headers: request.headers }), 64000))
      data = formSubmission ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid highlight data.')
    } catch { return fail('Invalid highlight data.', 422) }
    let selection: ReturnType<typeof validateHighlight> | undefined
    let note = ''
    try {
      if (article.kind === 'video' && (action === 'create' || (action === 'note' && ('start' in data || 'end' in data)))) {
        selection = validateVideoHighlight(data, article.transcript ?? [], article.video!.duration)
      } else if (action === 'create') selection = validateHighlight(data, markdownText(articleMarkdown(article)))
      if (action === 'note') note = validateNote(data.note)
    } catch (error) { return fail((error as Error).message, 422) }
    try {
      if (action === 'create') {
        const result = await highlights.create(articleId, selection!)
        if (result.duplicate && selection!.note && result.highlight.note !== selection!.note) {
          return fail('This passage already has a highlight. Edit its note in the sidebar.', 409)
        }
        return success(result, result.duplicate ? 200 : 201)
      }
      if (action === 'note') {
        if (selection) {
          const existing = (await highlights.list(articleId)).find(item => item.id !== highlightId && item.start === selection.start && item.end === selection.end)
          if (existing) return fail('This segment already has a highlight.', 409)
        }
        const highlight = selection ? await highlights.updateSegment(articleId, highlightId!, selection) : await highlights.updateNote(articleId, highlightId!, note)
        return highlight ? success({ highlight }) : fail('Highlight not found.', 404)
      }
      return await highlights.remove(articleId, highlightId!) ? success({ deleted: true }) : fail('Highlight not found.', 404)
    } catch (error) {
      console.error('Highlight update failed:', error)
      return fail('Could not save this change. Please try again.', 503)
    }
  }
  return createController(routes, {
    actions: {
      login(context) { return authPage(context) },
      signup(context) { return authPage(context, true) },
      loginSubmit(context) { return submit(context) },
      signupSubmit(context) { return submit(context, true) },
      auth(context) { return handleAuthRequest(context.request, env) },
      async logout(context) {
        const headers = new Headers(context.request.headers)
        headers.set('Content-Type', 'application/json'); headers.delete('Content-Length')
        const response = await (await getAuth(env!)).handler(new Request(`${env!.BETTER_AUTH_URL}/api/auth/sign-out`, { method: 'POST', headers, body: '{}' }))
        const result = new Headers(response.headers); result.delete('Content-Type'); result.delete('Content-Length'); result.set('Location', routes.login.href())
        return new Response(null, { status: response.ok ? 303 : response.status, headers: result })
      },
      account(context) { return accountPage(context) },
      async mcpToken(context) {
        const form = new URLSearchParams(new TextDecoder().decode(await readLimited(new Response(context.request.body), 1024)))
        const user = context.get(CurrentUser)!
        if (form.get('intent') === 'create') return accountPage(context, await issueMcpToken(env!, user.id))
        if (form.get('intent') === 'revoke') {
          await database(env!.DB).delete(mcpTokens).where(eq(mcpTokens.userId, user.id)).run()
          return new Response(null, { status: 303, headers: { Location: routes.account.href() } })
        }
        return Response.json({ error: 'Invalid request.' }, { status: 400 })
      },
      mcp(context) {
        return handleMcp(context.request, env)
      },
      async assets(context) {
        return (await assets.fetch(context.request)) ?? new Response('Not Found', { status: 404 })
      },
      async home(context) {
        const store = storeFor(context)
        const selected = context.url.searchParams.get('article')
        if (selected) return new Response(null, { status: 302, headers: { Location: routes.article.href({ id: selected }) } })
        return context.render(<HomePage articles={await store?.list() ?? []} />)
      },
      async article(context) {
        const store = storeFor(context)
        const article = await store?.get(context.params.id)
        if (!article) return context.render(<ArticleNotFoundPage />, { status: 404 })
        if (article.kind === 'bookmark') return new Response(null, { status: 302, headers: { Location: article.url } })
        return context.render(<ArticlePage article={article} highlights={await highlightsFor(context)!.list(article.id)} editHighlightId={context.url.searchParams.get('editHighlight') ?? undefined} />)
      },
      async readingList(context) {
        const store = storeFor(context)
        const origin = context.request.headers.get('Origin')
        if ((origin && origin !== context.url.origin) || context.request.headers.get('Sec-Fetch-Site') === 'cross-site') {
          return Response.json({ error: 'Please edit your reading list from Juniper.' }, { status: 403 })
        }
        if (!store) return Response.json({ error: 'Article storage is unavailable.' }, { status: 503 })
        let included: boolean
        try {
          if (Number(context.request.headers.get('Content-Length')) > 1024) throw new Error('Invalid submission')
          const form = new URLSearchParams(new TextDecoder().decode(await readLimited(new Response(context.request.body), 1024)))
          const value = form.get('included')
          if (value !== 'true' && value !== 'false') throw new Error('Invalid submission')
          included = value === 'true'
        } catch { return Response.json({ error: 'Choose whether to add or remove this article.' }, { status: 422 }) }
        try {
          const article = await store.setReadingList(context.params.id, included)
          if (!article) return Response.json({ error: 'Article not found.' }, { status: 404 })
          if (context.request.headers.get('Accept')?.includes('application/json')) return Response.json({ article })
          return new Response(null, { status: 303, headers: { Location: routes.home.href() } })
        } catch (error) {
          console.error('Reading list update failed:', error)
          return Response.json({ error: 'Could not update your reading list. Please try again.' }, { status: 503 })
        }
      },
      async deleteArticle(context) {
        const store = storeFor(context)
        const origin = context.request.headers.get('Origin')
        if ((origin && origin !== context.url.origin) || context.request.headers.get('Sec-Fetch-Site') === 'cross-site') {
          return Response.json({ error: 'Please delete articles from Juniper.' }, { status: 403 })
        }
        const json = context.request.headers.get('Accept')?.includes('application/json')
        let status = 503
        let message = 'Could not delete this article. Please try again.'
        try {
          if (!store) throw new Error('Storage unavailable')
          const result = await store.remove(context.params.id)
          if (result) {
            if (json) return Response.json(result, { status: result.cleanupPending ? 202 : 200 })
            return new Response(null, { status: 303, headers: { Location: routes.home.href() } })
          }
          status = 404
          message = 'This article has already been deleted.'
        } catch (error) { console.error('Article deletion failed:', error) }
        if (json) return Response.json({ error: message }, { status })
        return context.render(<HomePage articles={await store?.list() ?? []} error={message} />, { status })
      },
      createHighlight(context) {
        return mutateHighlight(context, context.params.id, 'create')
      },
      updateHighlight(context) {
        return mutateHighlight(context, context.params.id, 'note', context.params.highlightId)
      },
      deleteHighlight(context) {
        return mutateHighlight(context, context.params.id, 'delete', context.params.highlightId)
      },
      async quoteNote(context) {
        const store = storeFor(context)
        const request = context.request
        const origin = request.headers.get('Origin')
        if ((origin && origin !== context.url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
          return Response.json({ error: 'Please edit notes from Juniper.' }, { status: 403 })
        }
        if (!store) return Response.json({ error: 'Storage is unavailable.' }, { status: 503 })
        const article = await store.get(context.params.id)
        if (!article || !['quote', 'video'].includes(article.kind)) return Response.json({ error: 'Item not found.' }, { status: 404 })
        const json = request.headers.get('Accept')?.includes('application/json')
        let note = article.video?.note ?? article.quote?.note ?? ''
        let message = ''
        let status = 422
        try {
          const form = new URLSearchParams(new TextDecoder().decode(await readLimited(new Response(request.body), 64_000)))
          if (!form.has('note')) throw new Error('Enter a valid note.')
          note = form.get('note') ?? ''
          validateNote(note)
        } catch (error) { message = (error as Error).message }
        if (!message) {
          try {
            const updated = article.kind === 'video' ? await store.updateVideoNote(article.id, note) : await store.updateQuoteNote(article.id, note)
            if (!updated) return Response.json({ error: 'Quote not found.' }, { status: 404 })
            if (json) return Response.json({ article: updated })
            return new Response(null, { status: 303, headers: { Location: routes.article.href({ id: article.id }) } })
          } catch { message = 'Could not save your note. Please try again.'; status = 503 }
        }
        return json ? Response.json({ error: message }, { status })
          : context.render(<ArticlePage article={article} highlights={await highlightsFor(context)!.list(article.id)} error={message} noteDraft={note} />, { status })
      },
      async videoTranscript(context) {
        const origin = context.request.headers.get('Origin')
        if ((origin && origin !== context.url.origin) || context.request.headers.get('Sec-Fetch-Site') === 'cross-site') return Response.json({ error: 'Please edit transcripts from Juniper.' }, { status: 403 })
        const store = storeFor(context)
        const article = await store?.get(context.params.id)
        if (article?.kind !== 'video') return Response.json({ error: 'Video not found.' }, { status: 404 })
        const json = context.request.headers.get('Accept')?.includes('application/json')
        try {
          const bytes = await readLimited(new Response(context.request.body), 4_000_000)
          const form = new URLSearchParams(new TextDecoder().decode(bytes))
          const updated = await store!.importTranscript(article.id, form.get('transcript') ?? '')
          if (json) return Response.json({ article: updated })
          return new Response(null, { status: 303, headers: { Location: routes.article.href({ id: article.id }) } })
        } catch (error) {
          const status = error instanceof ImportError ? 422 : 503
          const message = error instanceof ImportError ? error.message : 'Could not save the transcript. Please try again.'
          return json ? Response.json({ error: message }, { status }) : context.render(<ArticlePage article={article} highlights={await highlightsFor(context)!.list(article.id)} error={message} />, { status })
        }
      },
      async retryVideoTranscript(context) {
        const origin = context.request.headers.get('Origin')
        if ((origin && origin !== context.url.origin) || context.request.headers.get('Sec-Fetch-Site') === 'cross-site') return Response.json({ error: 'Please edit transcripts from Juniper.' }, { status: 403 })
        const store = storeFor(context)
        if (!store) return Response.json({ error: 'Storage is unavailable.' }, { status: 503 })
        const article = await store.get(context.params.id)
        if (article?.kind !== 'video') return Response.json({ error: 'Video not found.' }, { status: 404 })
        const json = context.request.headers.get('Accept')?.includes('application/json')
        try {
          const updated = await store.retryTranscript(article.id, context.request.signal)
          if (!updated) return Response.json({ error: 'Video not found.' }, { status: 404 })
          if (json) return Response.json({ article: updated })
          return new Response(null, { status: 303, headers: { Location: routes.article.href({ id: article.id }) } })
        } catch (error) {
          const message = error instanceof ImportError ? error.message : 'Could not save the transcript. Please try again.'
          return json ? Response.json({ error: message }, { status: 503 })
            : context.render(<ArticlePage article={article} highlights={await highlightsFor(context)!.list(article.id)} error={message} />, { status: 503 })
        }
      },
      async save(context) {
        const store = storeFor(context)
        const json = context.request.headers.get('Accept')?.includes('application/json')
        const origin = context.request.headers.get('Origin')
        if ((origin && origin !== context.url.origin) || context.request.headers.get('Sec-Fetch-Site') === 'cross-site') {
          return Response.json({ error: 'Please save items from Juniper.' }, { status: 403 })
        }
        let message = ''
        let status = 422
        let draft: QuoteDraft | undefined
        let bookmark = false
        let submittedUrl = ''
        try {
          if (!store) { status = 503; throw new ImportError('Article storage is not configured. Start the app with npm run dev.') }
          const bytes = await readLimited(new Response(context.request.body, { headers: context.request.headers }), 320_000)
          const form = await new Response(bytes, { headers: context.request.headers }).formData()
          const url = form.get('url')
          bookmark = form.get('kind') === 'bookmark'
          if (typeof url !== 'string' || url.length > 4096) throw new ImportError('Enter a valid website URL.')
          submittedUrl = url
          if (form.has('kind') && !['auto', 'bookmark'].includes(String(form.get('kind')))) throw new ImportError('Choose a valid content type.')
          if (!bookmark && form.get('capture') === 'manual' && !xPost(url)) throw new ImportError('Paste an X post URL to save a quote.')
          if (!bookmark && xPost(url)) {
            if (!form.has('quoteText')) {
              const post = xPost(url)!
              draft = form.get('capture') === 'manual' ? { url: post.url, text: '', author: post.handle ? `@${post.handle}` : '', note: '' }
                : await store.previewQuote(url, AbortSignal.timeout(15_000))
              if (json) return Response.json({ draft })
              return context.render(<HomePage articles={await store.list()} draft={draft} />)
            }
            const text = form.get('quoteText'), author = form.get('author'), note = form.get('note')
            if (typeof text !== 'string' || typeof author !== 'string' || typeof note !== 'string') throw new ImportError('Invalid quote submission.')
            draft = { url, text, author, note }
          } else if (!bookmark && form.has('quoteText')) throw new ImportError('Enter a link to an X post.')
          const result = bookmark ? await store.saveBookmark(url, AbortSignal.timeout(30_000))
            : draft ? await store.saveQuote(draft) : await store.save(url, AbortSignal.timeout(90000))
          if (json) return Response.json(result, { status: result.duplicate ? 200 : 201 })
          return new Response(null, { status: 303, headers: { Location: routes.home.href() } })
        } catch (error) {
          message = error instanceof ImportError ? error.message : error instanceof DOMException && error.name === 'TimeoutError' ? 'The website took too long to respond. Please try again.' : 'We could not save this item. Please try again.'
          if (!(error instanceof ImportError)) { console.error('Article import failed:', error); status = 502 }
        }
        if (json) return Response.json({ error: message }, { status })
        return context.render(<HomePage articles={await store?.list() ?? []} error={message} draft={draft} bookmark={bookmark} submittedUrl={submittedUrl} />, { status })
      },
      async markdown(context) {
        const store = storeFor(context)
        const article = await store?.get(context.params.id)
        if (!article) return new Response('Article not found', { status: 404 })
        const name = article.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 80) || 'article'
        return new Response(article.markdown, { headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}.md"`,
          'X-Content-Type-Options': 'nosniff',
        } })
      },
      async image(context) {
        const store = storeFor(context)
        if (!/^[\da-f-]{36}$/.test(context.params.id) || !/^\d+\.(jpg|png|webp|gif|avif)$/.test(context.params.file)) return new Response('Not Found', { status: 404 })
        if (!await store?.get(context.params.id)) return new Response('Not Found', { status: 404 })
        const image = await env?.IMAGES.get(`${context.params.id}/${context.params.file}`)
        if (!image) return new Response('Not Found', { status: 404 })
        return new Response(image.body, { headers: {
          'Content-Type': image.httpMetadata?.contentType ?? 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000, immutable',
          ETag: image.httpEtag, 'X-Content-Type-Options': 'nosniff',
        } })
      },
    },
  })
}
