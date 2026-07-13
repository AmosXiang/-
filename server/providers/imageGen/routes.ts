import path from 'path';
import type { Express, NextFunction, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { AgnesClient } from '../agnesClient.ts';
import { AgnesImageProvider } from './agnesImageProvider.ts';
import { ImageGenRouter } from './router.ts';
import { ImageGenValidationError, type ImageGenProviderName } from './types.ts';

type OptimizePrompt = (prompt: string, isCharacter: boolean, style?: string) => Promise<string>;

function rawMeta8k(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return Buffer.from(json).subarray(0, 8192).toString('utf8');
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const body = value as Record<string, any>;
    return String(body.error?.message || body.error || body.message || JSON.stringify(value));
  }
  return String(value || 'Unknown image provider error');
}

function findShot(db: Database.Database, projectId: string, targetId: string, shotIndex: number | undefined) {
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string } | undefined;
  if (!row) return null;
  const scripts = JSON.parse(row.value);
  const script = scripts.find((item: any) => String(item.id) === projectId);
  if (!script) return null;
  const index = Number.isInteger(shotIndex)
    ? Number(shotIndex)
    : script.newShots?.findIndex((shot: any) => String(shot.id) === targetId);
  const shot = index >= 0 ? script.newShots?.[index] : null;
  return shot ? { scripts, script, shot, index } : null;
}

function saveAudit(
  db: Database.Database,
  projectId: string,
  targetId: string,
  provider: ImageGenProviderName,
  reason: string,
  options: { requestId?: string | null; error?: string | null; rawMeta?: unknown; remoteUrl?: string | null; imagePath?: string },
) {
  const located = findShot(db, projectId, targetId, undefined);
  if (located) {
    located.shot.gen_provider = provider;
    located.shot.provider_request_id = options.requestId || null;
    located.shot.provider_route_reason = reason;
    located.shot.provider_error = options.error || null;
    if (options.imagePath) located.shot.imageUrl = options.imagePath;
    db.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify(located.scripts));
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO shot_image_provider_audit (
      project_id, shot_id, gen_provider, provider_request_id, provider_route_reason,
      provider_error, raw_meta, remote_url, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, shot_id) DO UPDATE SET
      gen_provider=excluded.gen_provider,
      provider_request_id=excluded.provider_request_id,
      provider_route_reason=excluded.provider_route_reason,
      provider_error=excluded.provider_error,
      raw_meta=excluded.raw_meta,
      remote_url=excluded.remote_url,
      updated_at=excluded.updated_at
  `).run(projectId, targetId, provider, options.requestId || null, reason, options.error || null, rawMeta8k(options.rawMeta), options.remoteUrl || null, now);
}

export function registerImageGenRouting(options: {
  app: Express;
  db: Database.Database;
  uploadsDir: string;
  configPath: string;
  optimizePrompt: OptimizePrompt;
}) {
  const router = new ImageGenRouter(options.configPath);

  options.app.use('/api/generate-image', async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST' || req.body?.targetType !== 'shot') return next();
    const projectId = String(req.body?.projectId || '');
    const shotIndex = Number.isInteger(req.body?.shotIndex) ? Number(req.body.shotIndex) : undefined;
    const requestedTargetId = String(req.body?.targetId || (shotIndex === undefined ? '' : `shot_${shotIndex}`));
    const located = findShot(options.db, projectId, requestedTargetId, shotIndex);
    if (!located) return res.status(404).json({ error: 'Shot not found for image provider routing.' });
    const targetId = String(located.shot.id || requestedTargetId);
    const hasCharacter = [
      ...(located.shot.matchedCharacterIds || []),
      ...(located.shot.characterIds || []),
      ...(located.shot.characters || []),
      ...(located.shot.characterNames || []),
    ].some(Boolean);
    const forceProvider = req.body?.forceProvider as ImageGenProviderName | undefined;
    let decision;
    try {
      decision = router.route({ isMaster: located.shot.isMaster ?? located.shot.is_master, hasCharacter, forceProvider });
    } catch (error: any) {
      return res.status(400).json({ error: String(error?.message || error) });
    }
    console.log('[ImageGenRouter]', JSON.stringify({ timestamp: new Date().toISOString(), event: 'route_selected', project_id: projectId, shot_id: targetId, shot_index: located.index, provider: decision.provider, reason: decision.reason, forced: !!forceProvider, has_character: hasCharacter, is_master: located.shot.isMaster ?? located.shot.is_master ?? null }));

    if (decision.provider === 'comfyui_local') {
      saveAudit(options.db, projectId, targetId, decision.provider, decision.reason, {});
      const originalJson = res.json.bind(res);
      res.json = ((body: any) => {
        if (res.statusCode >= 400) saveAudit(options.db, projectId, targetId, decision.provider, decision.reason, { error: errorText(body) });
        return originalJson(body);
      }) as typeof res.json;
      req.body.platform = 'comfyui';
      return next();
    }

    try {
      const prompt = req.body?.skipTranslation
        ? String(req.body?.prompt || '')
        : await options.optimizePrompt(String(req.body?.prompt || ''), false, req.body?.style);
      const provider = new AgnesImageProvider(new AgnesClient(String(process.env.AGNES_API_KEY || '')), options.uploadsDir);
      const result = await provider.generate({
        shotId: located.index,
        prompt,
        width: Number(req.body?.width || 1024),
        height: Number(req.body?.height || 1024),
        seed: req.body?.seed === undefined ? undefined : Number(req.body.seed),
        referenceImages: Array.isArray(req.body?.referenceImages) ? req.body.referenceImages.map(String) : undefined,
      });
      const meta = result.rawMeta as Record<string, any>;
      saveAudit(options.db, projectId, targetId, result.provider, decision.reason, { requestId: result.requestId, rawMeta: result.rawMeta, remoteUrl: meta?.remote_url, imagePath: result.imagePath });
      return res.json({ success: true, provider: result.provider, requestId: result.requestId, imageUrl: result.imagePath, seed: result.seedUsed });
    } catch (error: any) {
      const message = String(error?.message || error);
      saveAudit(options.db, projectId, targetId, 'agnes', decision.reason, { error: message, rawMeta: error?.raw });
      console.error('[ImageGenRouter]', JSON.stringify({ timestamp: new Date().toISOString(), event: 'provider_failed', project_id: projectId, shot_id: targetId, provider: 'agnes', reason: decision.reason, error: message }));
      return res.status(error instanceof ImageGenValidationError ? 400 : 502).json({ error: message, provider: 'agnes' });
    }
  });
}
