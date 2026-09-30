CREATE TABLE IF NOT EXISTS page_scores (
  url_norm       text        NOT NULL,
  layer1_version text        NOT NULL,
  status         text        NOT NULL CHECK (status IN ('ready', 'failed')),
  result         jsonb,
  fail_reason    text,
  fetched_at     timestamptz NOT NULL,
  PRIMARY KEY (url_norm, layer1_version)
);

CREATE TABLE IF NOT EXISTS fetch_failures (
  day    date    NOT NULL,
  domain text    NOT NULL,
  reason text    NOT NULL,
  count  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, domain, reason)
);

CREATE TABLE IF NOT EXISTS devices (
  key_hash   text        PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flags (
  id         bigserial   PRIMARY KEY,
  key_hash   text        NOT NULL REFERENCES devices (key_hash),
  url_norm   text        NOT NULL,
  domain     text        NOT NULL,
  verdict    text        NOT NULL CHECK (verdict IN ('slop', 'fine')),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flags_domain_idx ON flags (domain);
CREATE INDEX IF NOT EXISTS flags_key_created_idx ON flags (key_hash, created_at);

CREATE TABLE IF NOT EXISTS list_versions (
  version      text        PRIMARY KEY,
  bundle       jsonb       NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  day            date    NOT NULL,
  config_version integer NOT NULL,
  event          text    NOT NULL,
  count          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, config_version, event)
);
