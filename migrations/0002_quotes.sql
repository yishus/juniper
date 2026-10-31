-- Keep existing article records and their IDs. Quote metadata lives in the
-- shared summary; the original text remains a separately searchable snapshot.
UPDATE articles SET summary=json_insert(summary, '$.kind', 'article');

CREATE UNIQUE INDEX quotes_post_per_account ON articles(user_id, json_extract(summary, '$.quote.postId'))
  WHERE json_extract(summary, '$.kind')='quote';

DROP TRIGGER saved_search_article_insert;
DROP TRIGGER saved_search_article_update;

CREATE TRIGGER saved_search_article_insert AFTER INSERT ON articles BEGIN
  INSERT INTO saved_search(article_id, source_id, title, url, author, text)
    VALUES (new.id, new.id, json_extract(new.summary, '$.title'), new.url,
      coalesce(json_extract(new.summary, '$.author'), '') || ' ' || coalesce(json_extract(new.summary, '$.quote.handle'), ''),
      new.text || char(10) || coalesce(json_extract(new.summary, '$.quote.note'), ''));
  INSERT INTO search_jobs(article_id, revision) VALUES (new.id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;

CREATE TRIGGER saved_search_article_update AFTER UPDATE OF summary, text, markdown ON articles BEGIN
  DELETE FROM saved_search WHERE article_id=old.id AND source_id=old.id;
  INSERT INTO saved_search(article_id, source_id, title, url, author, text)
    VALUES (new.id, new.id, json_extract(new.summary, '$.title'), new.url,
      coalesce(json_extract(new.summary, '$.author'), '') || ' ' || coalesce(json_extract(new.summary, '$.quote.handle'), ''),
      new.text || char(10) || coalesce(json_extract(new.summary, '$.quote.note'), ''));
  INSERT INTO search_jobs(article_id, revision) VALUES (new.id, lower(hex(randomblob(16)))) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision, attempts=0, available_at=0, last_error=NULL;
END;
