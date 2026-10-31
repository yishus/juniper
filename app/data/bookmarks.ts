import { parseDocument } from 'htmlparser2'
import { isTag } from 'domhandler'
import { findAll, textContent } from 'domutils'
import { fetchPublic, publicUrl, readLimited, type Fetcher } from './network.ts'

// A bookmark only needs its URL. Metadata is optional, including for sites that
// render in JavaScript or block automated requests.
export async function captureBookmark(input: string, fetcher: Fetcher, signal?: AbortSignal) {
  const source = publicUrl(input.trim()).href
  let url = source
  let title = new URL(source).hostname.replace(/^www\./, '')
  let site = title
  let description = ''
  let image: string | null = null
  try {
    const fetched = await fetchPublic(source, fetcher, signal)
    url = fetched.url
    title = site = new URL(url).hostname.replace(/^www\./, '')
    if (!/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(fetched.response.headers.get('Content-Type') ?? '')) {
      await fetched.response.body?.cancel()
      return { url, title, site, description, image }
    }
    const html = new TextDecoder().decode(await readLimited(fetched.response, 2 * 1024 * 1024))
    const all = findAll(isTag, parseDocument(html, { decodeEntities: true }).children)
    const meta = (key: string) => all.find(el => el.name === 'meta' && (el.attribs.property === key || el.attribs.name === key))?.attribs.content?.trim()
    const clean = (value: string, limit: number) => value.replace(/\s+/g, ' ').trim().slice(0, limit)
    title = clean(meta('og:title') || meta('twitter:title') || textContent(all.find(el => el.name === 'title') ?? []) || title, 500)
    site = clean(meta('og:site_name') || site, 200)
    description = clean(meta('og:description') || meta('description') || meta('twitter:description') || '', 500)
    const preview = meta('og:image') || meta('twitter:image')
    if (preview) {
      try { image = publicUrl(preview, url).href } catch { /* Keep the bookmark without a preview. */ }
    }
  } catch { /* Saving the link does not depend on metadata capture. */ }
  return { url, title, site, description, image }
}
