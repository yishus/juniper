export interface YouTubePlayer {
  getCurrentTime(): number
  getDuration(): number
  loadVideoById(options: { videoId: string; startSeconds: number; endSeconds?: number }): void
  pauseVideo(): void
  destroy(): void
}
interface YouTubeAPI {
  Player: new (element: HTMLIFrameElement, options: { events: { onReady(): void; onError(): void } }) => YouTubePlayer
}
type PlayerWindow = Window & { YT?: YouTubeAPI; onYouTubeIframeAPIReady?: () => void }
let loading: Promise<YouTubeAPI> | undefined

export function loadYouTubePlayer(): Promise<YouTubeAPI> {
  const browser = window as PlayerWindow
  if (browser.YT?.Player) return Promise.resolve(browser.YT)
  if (loading) return loading
  loading = new Promise<YouTubeAPI>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    const previous = browser.onYouTubeIframeAPIReady
    const timeout = window.setTimeout(failed, 15000)
    function failed() {
      window.clearTimeout(timeout)
      script.remove()
      browser.onYouTubeIframeAPIReady = previous
      loading = undefined
      reject(new Error('Player controls could not load. You can still enter highlight times below.'))
    }
    script.onerror = failed
    browser.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout)
      browser.onYouTubeIframeAPIReady = previous
      previous?.()
      if (browser.YT?.Player) resolve(browser.YT)
      else failed()
    }
    document.head.append(script)
  })
  return loading
}
