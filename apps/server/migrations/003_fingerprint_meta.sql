-- Final-review fixes: thin pages are never evidence against others; rel=canonical copies are not "copying".
ALTER TABLE fingerprints ADD COLUMN IF NOT EXISTS thin boolean NOT NULL DEFAULT false;
ALTER TABLE fingerprints ADD COLUMN IF NOT EXISTS canonical text;
