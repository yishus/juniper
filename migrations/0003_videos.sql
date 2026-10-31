CREATE UNIQUE INDEX videos_per_account ON articles(user_id, json_extract(summary, '$.video.videoId'))
  WHERE json_extract(summary, '$.kind')='video';

CREATE TABLE video_transcripts (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  cues TEXT NOT NULL
);

DROP TRIGGER saved_search_article_insert;
DROP TRIGGER saved_search_article_update;
CREATE TRIGGER saved_search_article_insert AFTER INSERT ON articles BEGIN
  INSERT INTO saved_search(article_id, source_id, title, url, author, text)
    VALUES (new.id, new.id, json_extract(new.summary, '$.title'), new.url,
      coalesce(json_extract(new.summary, '$.author'), '') || ' ' || coalesce(json_extract(new.summary, '$.quote.handle'), ''),
      new.text || char(10) || coalesce(json_extract(new.summary, '$.quote.note'), '') || char(10) || coalesce(json_extract(new.summary, '$.video.note'), ''));
  INSERT INTO search_jobs(article_id, revision) VALUES (new.id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;
CREATE TRIGGER saved_search_article_update AFTER UPDATE OF summary, text, markdown ON articles BEGIN
  DELETE FROM saved_search WHERE article_id=old.id AND source_id=old.id;
  INSERT INTO saved_search(article_id, source_id, title, url, author, text)
    VALUES (new.id, new.id, json_extract(new.summary, '$.title'), new.url,
      coalesce(json_extract(new.summary, '$.author'), '') || ' ' || coalesce(json_extract(new.summary, '$.quote.handle'), ''),
      new.text || char(10) || coalesce(json_extract(new.summary, '$.quote.note'), '') || char(10) || coalesce(json_extract(new.summary, '$.video.note'), ''));
  INSERT INTO search_jobs(article_id, revision) VALUES (new.id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;

DROP TRIGGER saved_search_highlight_update;
CREATE TRIGGER saved_search_highlight_update AFTER UPDATE OF note, quote, start_offset, end_offset ON highlights BEGIN
  DELETE FROM saved_search WHERE source_id=old.id;
  INSERT INTO saved_search(article_id, source_id, title, url, author, text) SELECT new.article_id, new.id, json_extract(summary, '$.title'), url, json_extract(summary, '$.author'), new.quote || char(10) || new.note FROM articles WHERE id=new.article_id;
  INSERT INTO search_jobs(article_id, revision) VALUES (new.article_id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;
