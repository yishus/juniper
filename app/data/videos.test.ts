import * as assert from 'node:assert/strict'
import { describe, it } from 'remix/test'
import { videoFixture, videoId, videoUrl, subtitles } from '../../test/video-fixtures.ts'
import { youtubeVideo, parseVideoTime, validateVideoHighlight } from '../actions/public/youtube.ts'
import { captureVideo, parseTranscript } from './videos.ts'
import { ArticleStore } from './articles.ts'
import { HighlightStore } from './highlights.ts'
import { SearchStore } from './search.ts'
import { articlePassages } from './search-index.ts'

describe('saved YouTube videos', () => {
  it('canonicalizes video links without treating timestamps as separate saves', () => {
    for (const url of [videoUrl + '&t=20s&si=tracking', `https://youtu.be/${videoId}?t=40`, `https://m.youtube.com/shorts/${videoId}`, `https://youtube.com/live/${videoId}`, `https://www.youtube.com/embed/${videoId}`]) {
      assert.deepEqual(youtubeVideo(url), { videoId, url: videoUrl })
    }
    for (const url of [`https://youtube.com.evil.org/watch?v=${videoId}`, `https://youtube.com@evil.org/watch?v=${videoId}`, `https://user@youtube.com/watch?v=${videoId}`, 'https://youtube.com/playlist?list=abc', 'https://youtu.be/invalid', `javascript:${videoId}`]) assert.equal(youtubeVideo(url), null)
    assert.equal(parseVideoTime('1:02:03.125'), 3723125)
    assert.ok(Number.isNaN(parseVideoTime('2:99')))
  })
  it('captures metadata and captions, and lets public videos save without captions', async t => {
    const f = videoFixture(); t.after(() => f.db.close())
    const captured = await captureVideo(videoUrl, f.fetcher)
    assert.equal(captured.title, 'Room for <ideas>'); assert.equal(captured.duration, 120000)
    assert.deepEqual(captured.transcript, parseTranscript(subtitles))
    const unavailable = await captureVideo(videoUrl, (input, init) => new URL(input.toString()).pathname === '/watch' ? Promise.resolve(new Response('Unavailable', { status: 403 })) : f.fetcher(input, init))
    assert.deepEqual(unavailable.transcript, []); assert.equal(unavailable.duration, null)
    await assert.rejects(captureVideo(videoUrl, (input, init) => new URL(input.toString()).pathname === '/oembed' ? Promise.resolve(new Response('Private', { status: 404 })) : f.fetcher(input, init)), /could not be loaded/)
  })
  it('validates subtitle ranges, text, sizes, and video highlights on the server', () => {
    const cues = parseTranscript(subtitles)
    assert.equal(parseTranscript('1\n00:00:01,000 --> 00:00:04,000\nHello <b>world</b> &amp; ideas')[0].text, 'Hello world & ideas')
    assert.equal(validateVideoHighlight({ start: '0:01', end: '0:08.500', note: ' Why ' }, cues, 120000).quote, 'Make room for ideas. Keep a nebula of possibilities.')
    assert.equal(validateVideoHighlight({ start: 9000, end: 10000 }, [], null).quote, 'Video highlight · 0:09–0:10')
    for (const input of [{ start: -1, end: 10 }, { start: 0, end: 0 }, { start: 2000, end: 1000 }, { start: 0, end: 120001 }, { start: '0:00', end: '2:99' }, { start: 1.1, end: 2 }, { start: 0, end: 1000, note: 'a'.repeat(5001) }]) assert.throws(() => validateVideoHighlight(input, cues, 120000))
    for (const input of ['', 'Plain text without times', 'WEBVTT\n\n00:00:04.000 --> 00:00:01.000\nBackwards', '1\n00:00:00,000 --> 00:00:02,000\n', 'x'.repeat(1000001)]) assert.throws(() => parseTranscript(input))
    assert.throws(() => parseTranscript(subtitles, 4000))
  })
  it('deduplicates saves, isolates accounts, indexes notes and transcripts, and cleans up media', async t => {
    const f = videoFixture(); t.after(() => f.db.close())
    const store = new ArticleStore(f.env, f.userId, f.fetcher)
    const { article } = await store.save(`https://youtu.be/${videoId}?t=30`)
    assert.equal(article.kind, 'video'); assert.equal(article.imageCount, 1); assert.deepEqual(article.transcript, parseTranscript(subtitles))
    const count = f.requests.length
    const again = await store.save(videoUrl + '&t=50')
    assert.equal(again.duplicate, true); assert.equal(again.article.id, article.id); assert.equal(f.requests.length, count)
    assert.equal((await store.setReadingList(article.id, true))?.inReadingList, false)
    assert.equal((await store.list())[0].video?.videoId, videoId)
    assert.equal('transcript' in (await store.list())[0], false)
    const other = new ArticleStore(f.env, 'another-account', f.fetcher)
    assert.equal(await other.get(article.id), null); assert.equal(await other.updateVideoNote(article.id, 'bad'), null); assert.equal(await other.importTranscript(article.id, subtitles), null)
    const otherVideo = await other.save(videoUrl)
    assert.notEqual(otherVideo.article.id, article.id)
    await store.updateVideoNote(article.id, 'Supernova')
    const search = new SearchStore(f.env, f.userId)
    assert.equal((await search.search({ kind: 'video', query: 'nebula' }, 'https://juniper.test')).results[0].id, article.id)
    assert.equal((await search.search({ query: 'Supernova' }, 'https://juniper.test')).results.length, 1)
    const highlights = new HighlightStore(f.env.DB, f.userId)
    const input = validateVideoHighlight({ start: 1000, end: 8500, note: 'Remember a comet' }, article.transcript!, 120000)
    const { highlight } = await highlights.create(article.id, input)
    assert.equal((await search.search({ query: 'comet' }, 'https://juniper.test')).results[0].excerpts[0].source, 'highlight')
    assert.equal((await highlights.create(article.id, input)).duplicate, true)
    await store.importTranscript(article.id, '1\n00:00:01,000 --> 00:00:05,000\nNew sunflower')
    assert.equal((await highlights.get(article.id, highlight.id))?.quote, input.quote)
    assert.match((await articlePassages((await store.get(article.id))!, await highlights.list(article.id))).map(p => p.content).join('\n'), /Supernova/)
    const key = `${article.id}/1.jpg`
    assert.ok(f.objects.has(key))
    await store.remove(article.id)
    assert.equal(f.objects.has(key), false)
    assert.equal((await highlights.list(article.id)).length, 0)
    assert.equal(f.db.prepare('SELECT cues FROM video_transcripts WHERE article_id=?').get(article.id), undefined)
    assert.equal((await search.search({ query: 'Supernova' }, 'https://juniper.test')).results.length, 0)
  })
})
