# Juniper

A personal information archive, right now it supports articles, bookmarks, quotes from Twitter/X and YouTube clips.

## Content type

| Content  | Description                                                                                   |
| -------- | --------------------------------------------------------------------------------------------- |
| Article  | Article content is downloaded and searchable, supports highlights and notes.                  |
| Bookmark | For non article pages. Page title, description and preview images are saved, but not content. |
| Quote    | Short-form text based content.                                                                |
| Video    | YouTube links with transcript support.                                                        |

## Run locally

Requires Node 24.3 or newer.

```sh
npm install
cp wrangler.jsonc.example wrangler.jsonc
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

## How imports work

- The server fetches the public article URL, checking its host, DNS addresses, and each redirect.
- HTML is parsed without executing scripts. The importer selects the main article and removes
  navigation, ads, sharing controls, sidebars, and other common page furniture.
- Headings, paragraphs, emphasis, links, lists, quotes, tables, and code become Markdown.
- Images in the extracted article (including common lazy-load attributes) are downloaded to R2.
  Markdown references `/images/<article-id>/<file>` served by this app.
- D1 stores article metadata, Markdown, and plain text. A unique URL per account prevents duplicate records.
- An image failure still saves the article and reports a warning. Failed article writes clean up
  images already downloaded. Images are deduplicated within an article.

## Accounts, allowlist, and Turnstile

Configure these Worker secrets with the interactive prompts:

```sh
npx wrangler secret put AUTH_ALLOWED_EMAILS
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY
```

`AUTH_ALLOWED_EMAILS` is a comma-separated list, for example
`alice@example.com,bob@example.com`. Entries are trimmed, lowercased, and deduplicated.
Only those addresses may sign up or sign in. Missing, empty, or malformed configuration keeps
the app locked. Every protected request and MCP token use rechecks the allowlist, so removing
an address immediately blocks access, including previously signed-in sessions.
`BETTER_AUTH_SECRET` is an independent high-entropy secret of at least 32 characters; generate
one with `openssl rand -hex 32`. The previous `AUTH_EMAIL`, `AUTH_PASSWORD`,
`AUTH_SESSION_SECRET`, and global `MCP_TOKEN` settings are no longer used.

Set these public values under `vars` in `wrangler.jsonc`, or through Wrangler/Dashboard settings:

```json
{
  "BETTER_AUTH_URL": "https://YOUR-WORKER.workers.dev",
  "TURNSTILE_SITE_KEY": "YOUR_PUBLIC_TURNSTILE_SITE_KEY"
}
```

## Agent search and MCP

Juniper exposes a read-only, stateless Streamable HTTP MCP server at `/mcp` with
`search_saved_urls` and `get_saved_url`. Search combines D1 full-text search with
Workers AI `@cf/baai/bge-m3` embeddings and a 1,024-dimensional cosine Vectorize index.
Article passages, highlighted quotes, and personal notes are searchable. Results include
original URLs, Juniper reader URLs, and matching excerpts. Reading an article serves its
saved snapshot and never fetches the original website.

### Cloudflare setup

```sh
npx wrangler vectorize create juniper-passages --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index juniper-passages --property-name=domain --type=string
npx wrangler vectorize create-metadata-index juniper-passages --property-name=savedAt --type=number
npx wrangler queues create juniper-search
```

Configure an MCP client that supports bearer headers with:

```json
{
  "url": "https://YOUR-WORKER.workers.dev/mcp",
  "headers": { "Authorization": "Bearer YOUR_PERSONAL_TOKEN" }
}
```

## Checks

```sh
npm run typecheck
npm run build
npm run deploy:check
```

## Deploy to Cloudflare

Create the storage resources in your Cloudflare account:

```sh
npx wrangler login
npx wrangler d1 create juniper-articles
npx wrangler r2 bucket create juniper-images
```

Set `database_id` in `wrangler.jsonc` to the ID returned by `wrangler d1 create`. Create the
Vectorize index, metadata indexes, and queue in the Cloudflare setup section above. Apply the
database migrations before deploying:

```sh
npm run db:migrate:remote
npm run deploy
```
