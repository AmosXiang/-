CREATE TABLE IF NOT EXISTS shot_image_provider_audit (
  project_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  gen_provider TEXT,
  provider_request_id TEXT,
  provider_route_reason TEXT,
  provider_error TEXT,
  raw_meta TEXT,
  remote_url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, shot_id)
);

CREATE INDEX IF NOT EXISTS idx_shot_image_provider_audit_provider
ON shot_image_provider_audit (gen_provider, updated_at);
