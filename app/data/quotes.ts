import { parseDocument } from 'htmlparser2'
import { isTag, isText, type AnyNode } from 'domhandler'
import { findAll } from 'domutils'
import { fetchPublic, publicUrl, readLimited, ImportError, type Fetcher } from './network.ts'
import type { QuoteDraft } from './types.ts'

// Shared URL recognition is also used by the add form; fetching stays server-only.
export { xPost } from '../actions/public/x-post.ts'
import { xPost } from '../actions/public/x-post.ts'

export async function captureQuote(input: string, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<QuoteDraft> {
  const post = xPost(publicUrl(input).href)
  if (!post) throw new ImportError('Enter a link to an X post.')
  const draft: QuoteDraft = { url: post.url, text: '', author: post.handle ? `@${post.handle}` : '', note: '' }
  try {
    const endpoint = new URL('https://publish.x.com/oembed')
    endpoint.search = new URLSearchParams({ url: post.url, omit_script: 'true', hide_thread: 'true' }).toString()
    const { response } = await fetchPublic(endpoint.href, fetcher, signal)
    if (!/^application\/json\b/i.test(response.headers.get('Content-Type') ?? '')) {
      await response.body?.cancel()
      throw new Error('Invalid response')
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(await readLimited(response, 256_000)))
    if (!data || typeof data !== 'object') throw new Error('Invalid response')
    const embed = data as { html?: unknown; author_name?: unknown; author_url?: unknown }
    if (typeof embed.html !== 'string') throw new Error('No post text')
    const doc = parseDocument(embed.html)
    const block = findAll(el => el.name === 'blockquote' && el.attribs.class?.split(/\s+/).includes('twitter-tweet'), doc.children)[0]
    const paragraph = block && findAll(el => el.name === 'p', block.children)[0]
    if (!paragraph) throw new Error('No post text')
    const text = (node: AnyNode): string => isText(node) ? node.data : isTag(node)
      ? ['script', 'style', 'iframe'].includes(node.name) ? '' : node.name === 'br' ? '\n' : node.children.map(text).join('') : ''
    draft.text = text(paragraph).trim()
    if (!draft.text || draft.text.length > 25_000) throw new Error('Invalid post text')
    if (typeof embed.author_name === 'string') draft.author = embed.author_name.slice(0, 200)
    if (!post.handle && typeof embed.author_url === 'string') {
      const authorUrl = publicUrl(embed.author_url)
      if (/^(?:www\.)?(?:x\.com|twitter\.com)$/.test(authorUrl.hostname) && /^\/[a-z\d_]{1,15}\/?$/i.test(authorUrl.pathname)) {
        draft.url = `https://x.com/${authorUrl.pathname.split('/')[1].toLowerCase()}/status/${post.postId}`
      }
    }
  } catch {
    draft.text = ''
    draft.warning = 'We couldn’t capture this post. Paste its text below to save it.'
  }
  return draft
}

export function quoteMarkdown(text: string, author: string | null, url: string): string {
  const escape = (value: string) => value.replace(/[\\`*_[\]<>#~|]/g, '\\$&')
  return `${text.split('\n').map(line => `> ${escape(line)}`).join('\n')}\n\n— ${escape(author ?? 'X post')}\n\nSource: ${url}\n`
}
