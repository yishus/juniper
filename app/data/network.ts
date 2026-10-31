export class ImportError extends Error {}

export type Fetcher = typeof fetch

export function publicUrl(input: string, base?: string): URL {
  let url: URL
  try { url = new URL(input, base) } catch { throw new ImportError('Enter a valid article URL, starting with https://.') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') ||
      /^[\d.]+$/.test(host) || host.includes(':') ||
      /(^|\.)(localhost|local|internal|test|invalid|example|home|lan)$/.test(host)) {
    throw new ImportError('Use a public http:// or https:// article URL.')
  }
  url.hash = ''
  return url
}

function publicAddress(address: string): boolean {
  if (address.includes(':')) {
    // Global-unicast IPv6 only; reject documentation and embedded private IPv4.
    return /^[23][\da-f]{3}:/i.test(address) && !/^2001:(db8|0):/i.test(address) && !address.includes('.')
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a, b, c] = parts
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 2 && c === 0))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113))
}

export async function fetchPublic(input: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  let url = publicUrl(input)
  for (let hop = 0; hop <= 4; hop++) {
    const deadline = AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])])
    const answers = await Promise.all(['A', 'AAAA'].map(async type => {
      const query = new URL('https://cloudflare-dns.com/dns-query')
      query.searchParams.set('name', url.hostname)
      query.searchParams.set('type', type)
      const response = await fetcher(query, { headers: { Accept: 'application/dns-json' }, signal: deadline })
      if (!response.ok) throw new ImportError('Could not verify this website. Please try again.')
      const dns = await response.json() as { Status: number; Answer?: { type: number; data: string }[] }
      if (dns.Status !== 0) throw new ImportError('This website could not be found.')
      return (dns.Answer ?? []).filter(record => record.type === 1 || record.type === 28).map(record => record.data)
    }))
    const addresses = answers.flat()
    if (!addresses.length || addresses.some(address => !publicAddress(address))) {
      throw new ImportError('This URL does not point to a public website.')
    }
    const response = await fetcher(url, {
      redirect: 'manual', signal: deadline,
      headers: { 'User-Agent': 'Juniper/1.0 (personal article archiver)', Accept: 'text/html,image/*;q=0.9,*/*;q=0.5' },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location')
      await response.body?.cancel()
      if (!location) throw new ImportError('The website returned an incomplete redirect.')
      url = publicUrl(location, url.href)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new ImportError(`The website returned HTTP ${response.status}. Try another article.`)
    }
    return { response, url: url.href }
  }
  throw new ImportError('The website redirected too many times.')
}

export async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get('Content-Length')) > maxBytes) {
    await response.body?.cancel()
    throw new ImportError('This file is too large to save.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new ImportError('The website returned an empty response.')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new ImportError('This file is too large to save.')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}
