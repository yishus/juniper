import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'remix/test'
import { createTestServer } from 'remix/node-fetch-server/test'
import { createAppRouter } from '../router.ts'
import { videoFixture, videoUrl } from '../../test/video-fixtures.ts'
import { signIn } from '../../test/auth.ts'
import { buildStyles } from '../../scripts/styles.ts'
import { ArticleStore } from '../data/articles.ts'
import { HighlightStore } from '../data/highlights.ts'

declare global {
  interface Window {
    __videoTest: { time: number; commands: { type: string; startSeconds?: number; endSeconds?: number }[] }
  }
}

describe('YouTube browser flow', () => {
  it('saves one video, captures moments, selects transcript text, edits highlights, and persists changes', { timeout: 45000 }, async t => {
    const f = videoFixture(); t.after(() => f.db.close())
    const temporary = await mkdtemp(join(tmpdir(), 'juniper-video-'))
    t.after(() => rm(temporary, { recursive: true, force: true }))
    const cssFile = join(temporary, 'library.css')
    await buildStyles(process.cwd(), cssFile)
    const router = createAppRouter(f.env, f.fetcher)
    const server = await createTestServer(async request => new URL(request.url).pathname === '/library.css'
      ? new Response(await readFile(cssFile), { headers: { 'Content-Type': 'text/css' } }) : router.fetch(request))
    f.env.BETTER_AUTH_URL = server.baseUrl
    const page = await t.serve(server)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    // Control the real IFrame API boundary, without depending on a third-party
    // video or network availability. The app itself hydrates and calls real routes.
    await page.route('https://www.youtube.com/embed/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Video player fixture</body></html>' }))
    await page.route('https://www.youtube.com/iframe_api', route => route.fulfill({ contentType: 'text/javascript', body: `
      window.__videoTest = {time: 2, commands: []};
      window.YT = {Player: class {
        constructor(element, options) { setTimeout(() => options.events.onReady(), 0); }
        getCurrentTime() { return window.__videoTest.time; }
        getDuration() { return 120; }
        loadVideoById(options) { window.__videoTest.time = options.startSeconds; window.__videoTest.commands.push({type: 'load', ...options}); }
        pauseVideo() { window.__videoTest.commands.push({type: 'pause'}); }
        destroy() {}
      }};
      window.onYouTubeIframeAPIReady();
    ` }))
    const cookie = await signIn(request => router.fetch(request), f.env, server.baseUrl)
    await page.context().addCookies(cookie.split('; ').map(value => ({ name: value.slice(0, value.indexOf('=')), value: value.slice(value.indexOf('=') + 1), url: server.baseUrl })))
    await page.goto('/')
    await page.locator('#add-article-trigger').click()
    await page.locator('#article-url').fill(videoUrl)
    await page.getByRole('button', { name: 'Save video', exact: true }).click()
    await page.getByText('Video saved. Open it to highlight moments.').waitFor()
    assert.equal((await new ArticleStore(f.env, f.userId).list()).length, 1)
    await page.locator('[data-article-link]').click()
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button')?.disabled && Boolean(window.__videoTest))
    const startButton = page.getByRole('button', { name: 'Start highlight', exact: true })
    await startButton.waitFor({ state: 'visible' })
    await startButton.click()
    await page.evaluate(() => { window.__videoTest.time = 7 })
    await page.getByRole('button', { name: 'Finish highlight', exact: true }).click()
    assert.equal(await page.locator('input[name="start"]').inputValue(), '0:02')
    assert.equal(await page.locator('input[name="end"]').inputValue(), '0:07')
    await page.locator('#video-highlight-note').fill('A useful moment')
    await page.getByRole('button', { name: 'Save highlight', exact: true }).click()
    await page.getByText('Highlight saved.', { exact: true }).waitFor()
    await page.getByRole('link', { name: 'Play highlight 0:02 to 0:07' }).click()
    assert.equal(await page.evaluate(() => window.__videoTest.commands.some(command => command.type === 'load' && command.startSeconds === 2 && command.endSeconds === 7)), true)
    await page.getByRole('link', { name: 'Edit', exact: true }).click()
    await page.locator('input[name="end"]').fill('0:06')
    await page.locator('#video-highlight-note').fill('Adjusted moment')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.getByText('Highlight updated.', { exact: true }).waitFor()
    // Keyboard selection exercises the same accessible passage-selection path.
    await page.locator('[data-cue]').first().evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    })
    await page.getByRole('button', { name: 'Highlight', exact: true }).click()
    await page.getByRole('link', { name: 'Play highlight 0:01 to 0:04' }).waitFor()
    await page.locator('#video-save-note').fill('Why this matters')
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
    await page.getByText('Note saved.', { exact: true }).waitFor()
    await page.reload()
    await page.getByRole('link', { name: 'Play highlight 0:02 to 0:06' }).waitFor()
    assert.equal(await page.locator('#video-save-note').inputValue(), 'Why this matters')
    await page.getByRole('button', { name: 'Remove', exact: true }).first().click()
    await page.getByText('Highlight removed.', { exact: true }).waitFor()
    const article = (await new ArticleStore(f.env, f.userId).list())[0]
    assert.equal((await new HighlightStore(f.env.DB, f.userId).list(article.id)).length, 1)
    assert.deepEqual(errors, [])
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  })
})
