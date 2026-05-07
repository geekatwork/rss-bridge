CREATE TABLE groups (
    id SERIAL PRIMARY KEY,
    source_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    source_post_id TEXT NOT NULL UNIQUE,
    author_name TEXT,
    content_text TEXT,
    content_html TEXT,
    link TEXT,
    image_urls JSONB DEFAULT '[]'::jsonb,
    posted_at TIMESTAMPTZ NOT NULL,
    scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_posts_posted_at ON posts (posted_at DESC);
CREATE INDEX idx_posts_group_id ON posts (group_id);
CREATE UNIQUE INDEX uq_posts_link_non_null ON posts (link) WHERE link IS NOT NULL;
