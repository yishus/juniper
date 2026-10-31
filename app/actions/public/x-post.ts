// Restrict capture to a single post, dropping share tracking and media suffixes.
export function xPost(input: string): { url: string; handle: string | null; postId: string } | null {
  let url: URL
  try { url = new URL(input) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !/^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname)) return null
  const match = /^\/(?:([a-z\d_]{1,15})\/status|i(?:\/web)?\/status)\/([1-9]\d{0,24})(?:\/(?:photo|video)\/\d+)?\/?$/i.exec(url.pathname)
  if (!match) return null
  const handle = /^\/i(?:\/web)?\/status\//i.test(url.pathname) ? null : match[1]?.toLowerCase() ?? null
  return { url: `https://x.com/${handle ?? 'i'}/status/${match[2]}`, handle, postId: match[2] }
}
