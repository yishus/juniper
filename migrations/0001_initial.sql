-- Initial schema for an empty D1 database. Apply with Wrangler before starting the app.

-- Better Auth 1.7.12 schema and personal MCP tokens.
CREATE TABLE ba_user (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE TABLE ba_session (
  id TEXT NOT NULL PRIMARY KEY,
  expiresAt DATE NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES ba_user(id) ON DELETE CASCADE
);

CREATE TABLE ba_account (
  id TEXT NOT NULL PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES ba_user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt DATE,
  refreshTokenExpiresAt DATE,
  scope TEXT,
  password TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE TABLE ba_verification (
  id TEXT NOT NULL PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt DATE NOT NULL,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE TABLE ba_rate_limit (
  id TEXT NOT NULL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  lastRequest BIGINT NOT NULL
);

CREATE INDEX ba_session_userId_idx ON ba_session(userId);

CREATE INDEX ba_account_userId_idx ON ba_account(userId);

CREATE INDEX ba_verification_identifier_idx ON ba_verification(identifier);

CREATE TABLE auth_mcp_tokens (
  user_id TEXT PRIMARY KEY REFERENCES ba_user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Private libraries, highlights, reading lists, and image cleanup.
CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT NOT NULL,
  markdown TEXT NOT NULL,
  text TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  UNIQUE(user_id, url)
);

CREATE INDEX articles_owner_saved ON articles(user_id, saved_at, id);

CREATE TABLE highlights (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  quote TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(article_id, start_offset, end_offset)
);

CREATE TABLE reading_list (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE
);

CREATE TABLE article_deletions (
  article_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  image_keys TEXT NOT NULL
);

-- Search documents and outbox. Jobs/chunks outlive articles for vector cleanup.
CREATE TABLE search_jobs (
  article_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  last_error TEXT
);

CREATE TABLE search_chunks (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding_text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  indexed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX search_chunks_article ON search_chunks(article_id, active, indexed);

CREATE VIRTUAL TABLE saved_search USING fts5(
  article_id UNINDEXED, source_id UNINDEXED, title, url, author, text, tokenize='unicode61'
);

CREATE TRIGGER saved_search_article_insert AFTER INSERT ON articles BEGIN
  INSERT INTO saved_search(article_id, source_id, title, url, author, text) VALUES (new.id, new.id, json_extract(new.summary, '$.title'), new.url, json_extract(new.summary, '$.author'), new.text);
  INSERT INTO search_jobs(article_id, revision) VALUES (new.id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;

CREATE TRIGGER saved_search_article_update AFTER UPDATE OF summary, text, markdown ON articles BEGIN
  DELETE FROM saved_search WHERE article_id=old.id AND source_id=old.id;
  INSERT INTO saved_search(article_id, source_id, title, url, author, text) VALUES (new.id, new.id, json_extract(new.summary, '$.title'), new.url, json_extract(new.summary, '$.author'), new.text);
  INSERT INTO search_jobs(article_id, revision) VALUES (new.id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;

CREATE TRIGGER saved_search_article_delete AFTER DELETE ON articles BEGIN
  DELETE FROM saved_search WHERE article_id=old.id;
  INSERT INTO search_jobs(article_id, revision) VALUES (old.id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;

CREATE TRIGGER saved_search_highlight_insert AFTER INSERT ON highlights BEGIN
  INSERT INTO saved_search(article_id, source_id, title, url, author, text) SELECT new.article_id, new.id, json_extract(summary, '$.title'), url, json_extract(summary, '$.author'), new.quote || char(10) || new.note FROM articles WHERE id=new.article_id;
  INSERT INTO search_jobs(article_id, revision) VALUES (new.article_id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;

CREATE TRIGGER saved_search_highlight_update AFTER UPDATE OF note ON highlights BEGIN
  DELETE FROM saved_search WHERE source_id=old.id;
  INSERT INTO saved_search(article_id, source_id, title, url, author, text) SELECT new.article_id, new.id, json_extract(summary, '$.title'), url, json_extract(summary, '$.author'), new.quote || char(10) || new.note FROM articles WHERE id=new.article_id;
  INSERT INTO search_jobs(article_id, revision) VALUES (new.article_id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;

CREATE TRIGGER saved_search_highlight_delete AFTER DELETE ON highlights BEGIN
  DELETE FROM saved_search WHERE source_id=old.id;
  INSERT INTO search_jobs(article_id, revision) VALUES (old.article_id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;
