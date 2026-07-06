-- 拉片分析报告表。不改动任何既有表。
CREATE TABLE IF NOT EXISTS shot_analysis_reports (
  id TEXT PRIMARY KEY,
  videoId TEXT,
  sourceType TEXT NOT NULL,
  sourceRef TEXT NOT NULL,
  kbVersion TEXT NOT NULL,
  model TEXT NOT NULL,
  requestId TEXT NOT NULL,
  status TEXT NOT NULL,
  reportJson TEXT,
  error TEXT,
  durationMs INTEGER,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shot_analysis_reports_video_created
  ON shot_analysis_reports (videoId, createdAt);
