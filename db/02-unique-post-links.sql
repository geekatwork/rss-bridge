WITH ranked_duplicates AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY link ORDER BY id) AS duplicate_rank
    FROM posts
    WHERE link IS NOT NULL
)
DELETE FROM posts
WHERE id IN (
    SELECT id
    FROM ranked_duplicates
    WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_posts_link_non_null
ON posts (link)
WHERE link IS NOT NULL;