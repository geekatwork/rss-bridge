BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT set_config('rss_bridge.allow_deduplication', :'deduplicate', true);

DO $$
BEGIN
    IF NOT pg_try_advisory_xact_lock(735192, 30) THEN
        RAISE EXCEPTION 'Another schema migration is running';
    END IF;
END $$;

LOCK TABLE posts IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF current_setting('rss_bridge.allow_deduplication') <> 'true'
       AND EXISTS (SELECT link FROM posts WHERE link IS NOT NULL GROUP BY link HAVING COUNT(*) > 1) THEN
        RAISE EXCEPTION 'Duplicate links found. No changes applied. Review backup and rerun with --deduplicate to keep the lowest row ID per exact non-null link.';
    END IF;
END $$;

\ir /docker-entrypoint-initdb.d/02-unique-post-links.sql
\ir /docker-entrypoint-initdb.d/03-post-timestamp-provenance.sql

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attname = 'link'
        WHERE i.indexrelid = to_regclass('uq_posts_link_non_null')
          AND i.indrelid = 'posts'::regclass
          AND i.indisunique AND i.indisvalid AND i.indisready
          AND i.indnkeyatts = 1 AND i.indnatts = 1
          AND i.indkey[0] = a.attnum
          AND pg_get_expr(i.indpred, i.indrelid) = '(link IS NOT NULL)'
    ) THEN
        RAISE EXCEPTION 'uq_posts_link_non_null does not match the required unique partial index';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'posts'::regclass AND a.attname = 'posted_at_is_source'
          AND a.atttypid = 'boolean'::regtype AND a.attnotnull AND NOT a.attisdropped
          AND pg_get_expr(d.adbin, d.adrelid) = 'false'
    ) THEN
        RAISE EXCEPTION 'posted_at_is_source must be a non-null boolean defaulting to false';
    END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('02-unique-post-links'), ('03-post-timestamp-provenance')
ON CONFLICT (version) DO NOTHING;
TABLE schema_migrations;
COMMIT;
