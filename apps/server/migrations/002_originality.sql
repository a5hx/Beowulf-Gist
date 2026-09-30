CREATE TABLE IF NOT EXISTS fingerprints (
  url_norm     text        NOT NULL,
  hash         bigint      NOT NULL,
  domain       text        NOT NULL,
  published_at timestamptz,
  fetched_at   timestamptz NOT NULL,
  PRIMARY KEY (url_norm, hash)
);
CREATE INDEX IF NOT EXISTS fingerprints_hash_idx ON fingerprints (hash);
CREATE INDEX IF NOT EXISTS fingerprints_fetched_idx ON fingerprints (fetched_at);

CREATE TABLE IF NOT EXISTS originality_memo (
  url_norm       text        NOT NULL,
  layer3_version text        NOT NULL,
  result         jsonb       NOT NULL,
  computed_at    timestamptz NOT NULL,
  PRIMARY KEY (url_norm, layer3_version)
);
