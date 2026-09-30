ALTER TABLE sessions ADD COLUMN access_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN access_expires_at TEXT;

CREATE UNIQUE INDEX sessions_access_token_hash_idx ON sessions(access_token_hash);
CREATE INDEX sessions_access_active_idx ON sessions(access_expires_at, revoked_at);
