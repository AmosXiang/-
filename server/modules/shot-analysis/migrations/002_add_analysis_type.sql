-- 增加分析类型列。SQLite 的 ADD COLUMN ... DEFAULT 会用默认值回填全部历史行,
-- 因此既有报告自动标记为 narrative(它们确实全部是叙事分析)。
ALTER TABLE shot_analysis_reports ADD COLUMN analysisType TEXT NOT NULL DEFAULT 'narrative';
