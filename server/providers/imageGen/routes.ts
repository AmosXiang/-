import path from 'path';
import type { Express, NextFunction, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { AgnesClient } from '../agnesClient.ts';
import { AgnesImageProvider } from './agnesImageProvider.ts';
import { ImageGenRouter } from './router.ts';
import {
  appendStyleBundleSummary,
  buildStyleBundle,
  composeAgnesPrompt,
  summarizeStyleBundle,
  type ImageStyleContext,
  type StyleBundle,
  type StyleBundleSummary,
} from './styleBundle.ts';
import { ImageGenValidationError, type ImageGenProvider, type ImageGenProviderName } from './types.ts';

type OptimizePrompt = (prompt: string, isCharacter: boolean, style?: string) => Promise<string>;

// 判定"对已有图片的操作":这类请求(放大、基于源图的重绘)不产生新的分镜构图,
// 前端也依赖原有 ComfyUI 契约,必须无条件绕过 provider 路由。
function isExistingImageOperation(body: any): boolean {
  if (body?.sourceImageUrl) return true;
  if (typeof body?.presetId === 'string' && /upscale/i.test(body.presetId)) return true;
  if (body?.presetRole === 'upscale') return true;
  return false;
}

function rawMeta8k(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(json);
  if (bytes <= 8192) return json;
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return JSON.stringify({
    ...(record.styleBundle === undefined ? {} : { styleBundle: record.styleBundle }),
    providerRawMetaTruncated: true,
    originalBytes: bytes,
  });
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
  options: {
    requestId?: string | null;
    error?: string | null;
    rawMeta?: unknown;
    remoteUrl?: string | null;
    imagePath?: string;
    styleContractVersion?: number | null;
  },
) {
  const located = findShot(db, projectId, targetId, undefined);
  if (located) {
    located.shot.gen_provider = provider;
    located.shot.provider_request_id = options.requestId || null;
    located.shot.provider_route_reason = reason;
    located.shot.provider_error = options.error || null;
    if (options.imagePath) located.shot.imageUrl = options.imagePath;
    if (options.styleContractVersion === null) {
      delete located.shot.gen_style_contract_version;
    } else if (options.styleContractVersion !== undefined) {
      located.shot.gen_style_contract_version = options.styleContractVersion;
    }
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
  resolveStyleContext?: (projectId: string, shotId: string) => ImageStyleContext | null;
  createAgnesProvider?: () => ImageGenProvider;
}) {
  const router = new ImageGenRouter(options.configPath);
  const createAgnesProvider = options.createAgnesProvider
    ?? (() => new AgnesImageProvider(new AgnesClient(String(process.env.AGNES_API_KEY || '')), options.uploadsDir));
  const inFlightAgnes = new Set<string>();

  options.app.use('/api/generate-image', async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST' || req.body?.targetType !== 'shot') return next();
    // 基于已有图片的操作(放大、重绘等)不是"生成新分镜图",必须留在原有 ComfyUI 管线,任何情况下不进入 provider 路由。
    if (isExistingImageOperation(req.body)) return next();
    const forceProvider = req.body?.forceProvider as ImageGenProviderName | undefined;
    // autoRoute 关闭时不接管现有 UI 请求(前端仍按 taskId+轮询契约编写);仅显式 forceProvider 走新路由。
    if (!forceProvider && !router.autoRoute) return next();
    // 没有 prompt 的请求无法用于任何文生图 provider,交回原有管线处理。
    if (!forceProvider && !String(req.body?.prompt || '').trim()) return next();
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

    // 同一 shot 的 Agnes 请求进行中时拒绝重复提交,避免连点重复扣费(对齐 ComfyUI 管线的 409 语义)。
    const inFlightKey = `${projectId}:${targetId}`;
    if (inFlightAgnes.has(inFlightKey)) {
      return res.status(409).json({ error: 'An Agnes image generation for this shot is already in progress.', provider: 'agnes' });
    }
    inFlightAgnes.add(inFlightKey);
    let styleBundle: StyleBundle | null = null;
    let styleBundleSummary: StyleBundleSummary | null = null;
    try {
      try {
        if (!options.resolveStyleContext) {
          console.warn('[ImageGenRouter]', JSON.stringify({
            timestamp: new Date().toISOString(),
            event: 'style_context_unavailable',
            project_id: projectId,
            shot_id: targetId,
            reason: 'resolver_missing',
          }));
        } else {
          const context = options.resolveStyleContext(projectId, targetId);
          if (context) {
            styleBundle = buildStyleBundle(context);
          } else {
            console.warn('[ImageGenRouter]', JSON.stringify({
              timestamp: new Date().toISOString(),
              event: 'style_context_unavailable',
              project_id: projectId,
              shot_id: targetId,
              reason: 'resolver_returned_null',
            }));
          }
        }
      } catch (error: any) {
        console.warn('[ImageGenRouter]', JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'style_context_unavailable',
          project_id: projectId,
          shot_id: targetId,
          reason: 'resolver_failed',
          error: String(error?.message || error),
        }));
      }

      const optimizedPrompt = req.body?.skipTranslation
        ? String(req.body?.prompt || '')
        : await options.optimizePrompt(String(req.body?.prompt || ''), false, req.body?.style);
      const composed = composeAgnesPrompt(optimizedPrompt, styleBundle);
      const width = req.body?.width === undefined ? Number(styleBundle?.width ?? 1024) : Number(req.body.width);
      const height = req.body?.height === undefined ? Number(styleBundle?.height ?? 1024) : Number(req.body.height);
      styleBundleSummary = styleBundle
        ? summarizeStyleBundle(styleBundle, composed.injected, width, height)
        : null;
      const provider = createAgnesProvider();
      const result = await provider.generate({
        shotId: located.index,
        prompt: composed.prompt,
        width,
        height,
        seed: req.body?.seed === undefined ? undefined : Number(req.body.seed),
        referenceImages: Array.isArray(req.body?.referenceImages) ? req.body.referenceImages.map(String) : undefined,
      });
      const meta = result.rawMeta as Record<string, any>;
      saveAudit(options.db, projectId, targetId, result.provider, decision.reason, {
        requestId: result.requestId,
        rawMeta: appendStyleBundleSummary(result.rawMeta, styleBundleSummary),
        remoteUrl: meta?.remote_url,
        imagePath: result.imagePath,
        styleContractVersion: styleBundle?.contractVersion ?? null,
      });
      return res.json({
        success: true,
        provider: result.provider,
        requestId: result.requestId,
        imageUrl: result.imagePath,
        seed: result.seedUsed,
        styleContractVersion: styleBundle?.contractVersion,
      });
    } catch (error: any) {
      const message = String(error?.message || error);
      saveAudit(options.db, projectId, targetId, 'agnes', decision.reason, {
        error: message,
        rawMeta: appendStyleBundleSummary(error?.raw, styleBundleSummary),
      });
      console.error('[ImageGenRouter]', JSON.stringify({ timestamp: new Date().toISOString(), event: 'provider_failed', project_id: projectId, shot_id: targetId, provider: 'agnes', reason: decision.reason, error: message }));
      return res.status(error instanceof ImageGenValidationError ? 400 : 502).json({ error: message, provider: 'agnes' });
    } finally {
      inFlightAgnes.delete(inFlightKey);
    }
  });
}
