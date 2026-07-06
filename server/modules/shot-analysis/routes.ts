// 拉片模块 HTTP 接口。错误响应结构与 server.ts /api/analyze-image-prompt 保持一致:
// { error: { code, message, retryable }, diagnostics: { requestId, model, ... } }。
// 失败会以 status='failed' 落库留痕;任何路径不静默跳过分析。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';

type DatabaseInstance = Database.Database;

import { classifyGeminiError } from '../../lib/gemini.ts';
import { applyShotAnalysisMigrations } from './migrate.ts';
import { runShotAnalysis, SHOT_ANALYSIS_MODEL, type ShotAnalysisInput } from './analyzer.ts';
import type { ShotAnalysisReportRow } from './schema.ts';

function insertReportRow(db: DatabaseInstance, row: ShotAnalysisReportRow): void {
  db.prepare(`
    INSERT INTO shot_analysis_reports (id, videoId, sourceType, sourceRef, kbVersion, model, requestId, status, reportJson, error, durationMs, createdAt)
    VALUES (@id, @videoId, @sourceType, @sourceRef, @kbVersion, @model, @requestId, @status, @reportJson, @error, @durationMs, @createdAt)
  `).run(row);
}

function findStoredVideo(db: DatabaseInstance, videoId: string): any | null {
  const row = db.prepare("SELECT value FROM store WHERE key = 'videos'").get() as { value: string } | undefined;
  if (!row) return null;
  const videos = JSON.parse(row.value) as any[];
  return videos.find(v => String(v.id) === String(videoId)) || null;
}

async function handleAnalyze(db: DatabaseInstance, req: Request, res: Response): Promise<Response> {
  const { videoId, filename, filepath } = req.body || {};
  const startedAt = Date.now();

  let analysisInput: ShotAnalysisInput;
  let sourceRef: string;
  let boundVideoId: string | null = null;

  if (videoId) {
    const video = findStoredVideo(db, String(videoId));
    if (!video) return res.status(404).json({ error: { code: 'VIDEO_NOT_FOUND', message: `Video ${videoId} not found in library`, retryable: false } });
    const shots = video.analysis?.shots;
    if (!Array.isArray(shots) || !shots.length) {
      return res.status(422).json({ error: { code: 'VIDEO_NOT_ANALYZED', message: `Video ${videoId} has no structured shot analysis. Run /api/analyze first.`, retryable: false } });
    }
    boundVideoId = String(video.id);
    sourceRef = `videoId:${video.id}`;
    analysisInput = {
      sourceType: 'analysis_json',
      videoId: boundVideoId,
      input: {
        title: String(video.title || video.filename || videoId),
        genre: video.genre,
        shots,
        characters: video.analysis?.characters || [],
        narrative: video.analysis?.narrative || {},
      },
    };
  } else if (filename && filepath) {
    const fullFilePath = path.isAbsolute(String(filepath)) ? String(filepath) : path.resolve(process.cwd(), String(filepath));
    if (!fs.existsSync(fullFilePath)) return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: `File not found at: ${fullFilePath}`, retryable: false } });
    sourceRef = `file:${filename}`;
    analysisInput = { sourceType: 'video', filename: String(filename), fullFilePath };
  } else {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Provide either videoId (analyzed library video) or filename+filepath (raw video file).', retryable: false } });
  }

  const reportId = crypto.randomUUID();
  try {
    const result = await runShotAnalysis(analysisInput);
    insertReportRow(db, {
      id: reportId,
      videoId: boundVideoId,
      sourceType: analysisInput.sourceType,
      sourceRef,
      kbVersion: result.kbVersion,
      model: result.model,
      requestId: result.requestId,
      status: 'succeeded',
      reportJson: JSON.stringify(result.report),
      error: null,
      durationMs: result.durationMs,
      createdAt: new Date().toISOString(),
    });
    return res.json({
      id: reportId,
      videoId: boundVideoId,
      sourceType: analysisInput.sourceType,
      sourceRef,
      kbVersion: result.kbVersion,
      report: result.report,
      diagnostics: { requestId: result.requestId, model: result.model, attempts: result.attempts, durationMs: result.durationMs },
    });
  } catch (error: any) {
    const classified = classifyGeminiError(error);
    const requestId = String(error?.requestId || crypto.randomUUID());
    console.error('[ShotAnalysis]', JSON.stringify({ requestId, event: 'analysis_failed', code: classified.code, sourceRef, detail: String(error?.message || error) }));
    insertReportRow(db, {
      id: reportId,
      videoId: boundVideoId,
      sourceType: analysisInput.sourceType,
      sourceRef,
      kbVersion: 'unknown',
      model: SHOT_ANALYSIS_MODEL,
      requestId,
      status: 'failed',
      reportJson: null,
      error: `${classified.code}: ${classified.message}`,
      durationMs: Date.now() - startedAt,
      createdAt: new Date().toISOString(),
    });
    const httpStatus = Number(error?.status) || classified.status;
    return res.status(httpStatus).json({
      error: { code: classified.code, message: classified.message, retryable: classified.retryable },
      diagnostics: { requestId, model: SHOT_ANALYSIS_MODEL, durationMs: Date.now() - startedAt, reportId },
    });
  }
}

export function registerShotAnalysisModule(app: Express, db: DatabaseInstance): void {
  applyShotAnalysisMigrations(db);

  app.post('/api/shot-analysis/analyze', (req, res) => {
    handleAnalyze(db, req, res).catch(err => {
      console.error('[ShotAnalysis] Unhandled route failure:', err);
      if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL', message: String(err?.message || err), retryable: false } });
    });
  });

  app.get('/api/shot-analysis/reports', (req, res) => {
    const videoId = req.query.videoId ? String(req.query.videoId) : null;
    const rows = (videoId
      ? db.prepare('SELECT * FROM shot_analysis_reports WHERE videoId = ? ORDER BY createdAt DESC').all(videoId)
      : db.prepare('SELECT * FROM shot_analysis_reports ORDER BY createdAt DESC').all()) as ShotAnalysisReportRow[];
    res.json(rows.map(row => ({
      id: row.id,
      videoId: row.videoId,
      sourceType: row.sourceType,
      sourceRef: row.sourceRef,
      kbVersion: row.kbVersion,
      model: row.model,
      status: row.status,
      overallScore: row.status === 'succeeded' && row.reportJson ? JSON.parse(row.reportJson).overallScore : null,
      error: row.error,
      durationMs: row.durationMs,
      createdAt: row.createdAt,
    })));
  });

  app.get('/api/shot-analysis/reports/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM shot_analysis_reports WHERE id = ?').get(String(req.params.id)) as ShotAnalysisReportRow | undefined;
    if (!row) return res.status(404).json({ error: { code: 'REPORT_NOT_FOUND', message: `Report ${req.params.id} not found`, retryable: false } });
    return res.json({ ...row, report: row.reportJson ? JSON.parse(row.reportJson) : null, reportJson: undefined });
  });

  console.log('[ShotAnalysis] Module registered: POST /api/shot-analysis/analyze, GET /api/shot-analysis/reports[/:id]');
}
