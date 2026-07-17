import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { generatePptx, generateManifest, createExportZip } from './generator.ts';
import { isReadableFile, getLocalPath, sanitizeFilename, sceneExportFile } from './naming.ts';

type DatabaseInstance = Database.Database;

export type ExportDeckPhase =
  | 'started'
  | 'directory-ready'
  | 'assets-ready'
  | 'pptx-started'
  | 'pptx-written'
  | 'manifest-started'
  | 'manifest-written'
  | 'zip-started'
  | 'zip-written'
  | 'completed'
  | 'failed';

export type ExportDeckPhaseEvent = {
  phase: ExportDeckPhase;
  projectId: string;
  exportRelDir: string | null;
  elapsedMs: number;
  failedPhase?: Exclude<ExportDeckPhase, 'failed'>;
  errorCode?: string;
};

export interface ExportDeckConfig {
  uploadsDir: string;
  onExportPhase?: (event: ExportDeckPhaseEvent) => void;
  videoDelivery?: {
    getVideoTask: (taskId: string) => VideoTaskRow | undefined;
    probeVideo: (absPath: string) => VideoProbe | null;
  };
}

type VideoTaskRow = {
  id: string;
  shot_id?: string | null;
  provider?: string | null;
  seed?: number | null;
  status?: string | null;
  local_path?: string | null;
  generation_snapshot_json?: string | null;
  [key: string]: unknown;
};

type VideoProbe = {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
};

type FinalVideoReason =
  | 'TAKE_NOT_FOUND'
  | 'TAKE_SHOT_MISMATCH'
  | 'TAKE_NOT_COMPLETED'
  | 'TAKE_NOT_DOWNLOADED'
  | 'TAKE_FILE_MISSING';

type FinalVideoDelivery = {
  taskId: string;
  provider: string | null;
  seed: number | null;
  status: 'ok' | 'missing';
  reason: FinalVideoReason | null;
  sourcePath: string | null;
  sourceLocalPath: string | null;
  file: string | null;
  fileBytes: number;
  requested: { durationSec: number; fps: number; resolution: string } | null;
  actual: VideoProbe | null;
};

function createExportDirectory(uploadsDir: string, projectId: string): { exportRelDir: string; exportDir: string } {
  const projectRelDir = `exports/${projectId}`;
  fs.mkdirSync(path.join(uploadsDir, projectRelDir), { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const directoryName = suffix === 0 ? timestamp : `${timestamp}-${suffix}`;
    const exportRelDir = `${projectRelDir}/${directoryName}`;
    const exportDir = path.join(uploadsDir, exportRelDir);
    try {
      fs.mkdirSync(exportDir);
      return { exportRelDir, exportDir };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Unable to reserve a unique export directory.');
}

function readScripts(db: DatabaseInstance): any[] {
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function registerExportDeckModule(
  app: Express,
  db: DatabaseInstance,
  config: ExportDeckConfig
): void {
  const uploadsDir = config.uploadsDir;
  const videoDelivery = config.videoDelivery;

  function requestedVideoParameters(row: VideoTaskRow | undefined): FinalVideoDelivery['requested'] {
    if (!row || typeof row.generation_snapshot_json !== 'string') return null;
    try {
      const parameters = JSON.parse(row.generation_snapshot_json)?.parameters;
      if (!parameters || typeof parameters !== 'object') return null;
      const durationSec = Number(parameters.durationSec);
      const fps = Number(parameters.fps);
      const resolution = typeof parameters.resolution === 'string' ? parameters.resolution : '';
      if (!Number.isFinite(durationSec) || !Number.isFinite(fps) || !resolution) return null;
      return { durationSec, fps, resolution };
    } catch {
      return null;
    }
  }

  function inspectFinalVideo(shot: any): FinalVideoDelivery | undefined {
    if (!videoDelivery || !shot?.finalVideoTaskId) return undefined;
    const taskId = String(shot.finalVideoTaskId);
    const row = videoDelivery.getVideoTask(taskId);
    const base = {
      taskId,
      provider: typeof row?.provider === 'string' ? row.provider : null,
      seed: typeof row?.seed === 'number' ? row.seed : null,
      sourcePath: typeof row?.local_path === 'string' && row.local_path.trim() ? row.local_path.trim() : null,
      sourceLocalPath: null,
      file: null,
      fileBytes: 0,
      requested: requestedVideoParameters(row),
      actual: null,
    } satisfies Omit<FinalVideoDelivery, 'status' | 'reason'>;
    const missing = (reason: FinalVideoReason): FinalVideoDelivery => ({ ...base, status: 'missing', reason });

    if (!row) return missing('TAKE_NOT_FOUND');
    if (String(row.shot_id || '') !== String(shot.id)) return missing('TAKE_SHOT_MISMATCH');
    if (row.status !== 'completed') return missing('TAKE_NOT_COMPLETED');
    if (!base.sourcePath) return missing('TAKE_NOT_DOWNLOADED');
    const sourceLocalPath = getLocalPath(base.sourcePath, uploadsDir);
    if (!sourceLocalPath || !isReadableFile(sourceLocalPath)) return missing('TAKE_FILE_MISSING');

    try {
      const fileBytes = fs.statSync(sourceLocalPath).size;
      let actual: VideoProbe | null = null;
      try {
        actual = videoDelivery.probeVideo(sourceLocalPath);
      } catch {
        actual = null;
      }
      return {
        ...base,
        status: 'ok',
        reason: null,
        sourceLocalPath,
        fileBytes,
        actual,
        file: null,
      };
    } catch {
      return missing('TAKE_FILE_MISSING');
    }
  }

  // Check function reused by both endpoints
  function performDeliveryCheck(projectId: string, script: any) {
    const shots = script.newShots || [];
    const total = shots.length;
    const details: any[] = [];
    let finalizedCount = 0;
    let missingImageCount = 0;
    let failedCount = 0;
    let missingParamsCount = 0;
    let staleCount = 0;
    let finalVideoCount = 0;
    let finalVideoBytes = 0;

    const shotsData = shots.map((shot: any, idx: number) => {
      const index = idx + 1; // 1-based index
      const issues: string[] = [];

      // Query latest task in comfyui_tasks for this main view, filtering strictly by targetType = 'shot'
      const latestTask = db
        .prepare(
          "SELECT status FROM comfyui_tasks WHERE projectId = ? AND targetId = ? AND targetType = 'shot' AND viewType = 'main' ORDER BY createdAt DESC LIMIT 1"
        )
        .get(projectId, shot.id) as { status: string } | undefined;

      // 1. Check finalized status
      const hasFinalizedRecord = !!(shot.finalTaskId && shot.finalizedImageUrl);
      const finalizedLocalPath = hasFinalizedRecord ? getLocalPath(shot.finalizedImageUrl, uploadsDir) : null;
      const finalizedFileExists = finalizedLocalPath ? isReadableFile(finalizedLocalPath) : false;
      const isFinalized = hasFinalizedRecord && !!finalizedLocalPath && finalizedFileExists;

      if (isFinalized) {
        finalizedCount++;
      } else {
        issues.push('not_finalized');
      }

      // 2. Check fallback image prioritizing the latest successful task image on database,
      // and checking file existence & readability to strictly pick the latest valid local main image.
      const latestSucceededTask = db
        .prepare(
          "SELECT imageUrl FROM comfyui_tasks WHERE projectId = ? AND targetId = ? AND targetType = 'shot' AND viewType = 'main' AND status = 'succeeded' ORDER BY createdAt DESC LIMIT 1"
        )
        .get(projectId, shot.id) as { imageUrl?: string } | undefined;

      const fallbackCandidates = [
        latestSucceededTask?.imageUrl,
        shot.generatedImageUrl,
        shot.imageUrl
      ].filter(Boolean);

      let fallbackUrl: string | null = null;
      let resolvedFallbackPath: string | null = null;

      for (const candidate of fallbackCandidates) {
        const localPath = getLocalPath(candidate, uploadsDir);
        if (localPath && isReadableFile(localPath)) {
          resolvedFallbackPath = localPath;
          fallbackUrl = candidate;
          break;
        }
      }

      // If we couldn't find any valid local readable fallback image,
      // but there were candidates, we pick the first candidate as the fallbackUrl for reporting / image_not_local checks.
      if (!resolvedFallbackPath && fallbackCandidates.length > 0) {
        fallbackUrl = fallbackCandidates[0];
      }

      const hasLocalFinalized = isFinalized;
      const hasLocalFallback = !!resolvedFallbackPath;

      // 3. Missing image status
      // A shot is missing_image if NEITHER the finalized image exists locally NOR the fallback image exists locally
      if (!hasLocalFinalized && !hasLocalFallback) {
        issues.push('missing_image');
        missingImageCount++;
      }

      // 4. Non-local image check
      // If there's a finalizedImageUrl but it's not local
      const isFinalizedNonLocal = shot.finalizedImageUrl && !getLocalPath(shot.finalizedImageUrl, uploadsDir);
      // If there's no finalized image but fallback exists and is not local
      const isFallbackNonLocal = !shot.finalizedImageUrl && fallbackUrl && !getLocalPath(fallbackUrl, uploadsDir);
      if (isFinalizedNonLocal || isFallbackNonLocal) {
        issues.push('image_not_local');
      }

      // 5. Missing params check
      let missingParamFlag = false;
      if (!shot.camera || !shot.camera.move || !shot.camera.speed) {
        issues.push('missing_camera');
        missingParamFlag = true;
      }
      if (!shot.framing || !shot.framing.shotSize || !shot.framing.angle) {
        issues.push('missing_framing');
        missingParamFlag = true;
      }
      if (
        shot.durationSec === undefined ||
        shot.durationSec === null ||
        typeof shot.durationSec !== 'number' ||
        shot.durationSec <= 0
      ) {
        issues.push('missing_duration');
        missingParamFlag = true;
      }
      if (missingParamFlag) {
        missingParamsCount++;
      }

      // 6. Stale status
      if (shot.isStale === true) {
        issues.push('stale_input');
        staleCount++;
      }

      // 7. Latest task failed check
      const latestFailed = latestTask && ['failed', 'cancelled'].includes(latestTask.status);
      if (latestFailed) {
        issues.push('latest_task_failed');
        failedCount++;
      }

      if (issues.length > 0) {
        details.push({
          shotId: String(shot.id),
          index: idx, // 0-based index for details
          issues,
        });
      }

      // Determine which local image path to use for PPTX generation
      let resolvedLocalPath: string | null = null;
      let resolvedExt: string | null = null;

      if (isFinalized && finalizedLocalPath) {
        resolvedLocalPath = finalizedLocalPath;
      } else if (hasLocalFallback && resolvedFallbackPath) {
        resolvedLocalPath = resolvedFallbackPath;
      }

      if (resolvedLocalPath) {
        resolvedExt = path.extname(resolvedLocalPath) || '.png';
      }

      const finalVideo = inspectFinalVideo(shot);
      if (finalVideo?.status === 'ok') {
        finalVideoCount++;
        finalVideoBytes += finalVideo.fileBytes;
      }

      return {
        id: String(shot.id),
        index,
        timestamp: shot.timestamp || '',
        durationSec: Number(shot.durationSec || 0),
        description: shot.description || '',
        optimizedPrompt: shot.optimizedPrompt || '',
        camera: {
          move: shot.camera?.move || '',
          speed: shot.camera?.speed || '',
          note: shot.camera?.note || '',
        },
        framing: {
          shotSize: shot.framing?.shotSize || '',
          angle: shot.framing?.angle || '',
        },
        cameraH: shot.cameraH || null,
        cameraV: shot.cameraV || null,
        cameraZoom: shot.cameraZoom || null,
        derivedFromShotId: shot.derivedFromShotId || null,
        isMaster: !!shot.isMaster,
        finalized: isFinalized,
        isStale: !!shot.isStale,
        localImagePath: resolvedLocalPath,
        imageExt: resolvedExt,
        sceneId: shot.sceneId || null,
        ...(finalVideo ? { finalVideo } : {}),
      };
    });

    const summary = {
      total,
      finalized: finalizedCount,
      notFinalized: total - finalizedCount,
      missingImage: missingImageCount,
      failed: failedCount,
      missingParams: missingParamsCount,
      stale: staleCount,
      details,
      ...(videoDelivery ? { finalVideos: { count: finalVideoCount, totalBytes: finalVideoBytes } } : {}),
    };

    return { summary, shotsData };
  }

  // 1. Delivery Check API
  app.get('/api/generated-scripts/:id/delivery-check', (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const scripts = readScripts(db);
    const script = scripts.find(s => String(s.id) === projectId);

    if (!script) {
      return res.status(404).json({ error: `Project ${projectId} not found` });
    }

    const { summary } = performDeliveryCheck(projectId, script);
    return res.json(summary);
  });

  // 2. Export Deck API
  app.post('/api/generated-scripts/:id/export-deck', async (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const mode = req.body?.mode;
    const includeFinalVideos = req.body?.includeFinalVideos === true;

    if (mode !== 'final' && mode !== 'review') {
      return res.status(400).json({ error: "mode field is required and must be either 'final' or 'review'" });
    }

    const scripts = readScripts(db);
    const script = scripts.find(s => String(s.id) === projectId);

    if (!script) {
      return res.status(404).json({ error: `Project ${projectId} not found` });
    }

    const { summary, shotsData } = performDeliveryCheck(projectId, script);
    let exportSummary: Record<string, unknown> = summary;

    // If final mode, require all shots to be finalized
    if (mode === 'final' && summary.notFinalized > 0) {
      return res.status(409).json({
        error: `Cannot export in final mode: ${summary.notFinalized} shots are not finalized.`,
        missing: summary.details,
        details: summary.details,
      });
    }

    const startedAt = Date.now();
    let exportRelDir: string | null = null;
    let activePhase: Exclude<ExportDeckPhase, 'failed'> = 'started';
    const emitPhase = (
      phase: ExportDeckPhase,
      failure?: { failedPhase: Exclude<ExportDeckPhase, 'failed'>; errorCode: string },
    ) => {
      if (phase !== 'failed') activePhase = phase;
      const event: ExportDeckPhaseEvent = {
        phase,
        projectId,
        exportRelDir,
        elapsedMs: Date.now() - startedAt,
        ...failure,
      };
      try {
        config.onExportPhase?.(event);
      } catch (diagnosticsError: any) {
        console.error('[Export Deck Diagnostics Error]', diagnosticsError?.message || diagnosticsError);
      }
    };
    emitPhase('started');

    try {
      // Atomically reserve a filesystem-safe directory so same-millisecond exports never overwrite each other.
      const reservedExport = createExportDirectory(uploadsDir, projectId);
      exportRelDir = reservedExport.exportRelDir;
      const exportDir = reservedExport.exportDir;
      const finalsDir = path.join(exportDir, 'finals');

      // Create directories
      fs.mkdirSync(finalsDir, { recursive: true });
      emitPhase('directory-ready');

      // Process and copy images for each shot checking strictly for readability
      for (const shot of shotsData) {
        // Copy only if the localImagePath exists and is readable
        if (shot.localImagePath && isReadableFile(shot.localImagePath)) {
          const twoDigitIdx = String(shot.index).padStart(2, '0');
          const destFileName = `shot-${twoDigitIdx}${shot.imageExt}`;
          const destPath = path.join(finalsDir, destFileName);
          fs.copyFileSync(shot.localImagePath, destPath);
        } else {
          // Explicitly clear localImagePath so PPTX doesn't crash trying to read missing file
          shot.localImagePath = null;
        }
      }

      if (videoDelivery) {
        const videosDir = path.join(exportDir, 'videos');
        if (includeFinalVideos) fs.mkdirSync(videosDir, { recursive: true });

        for (const shot of shotsData) {
          if (!shot.finalVideo) continue;
          const refreshed = inspectFinalVideo(
            (script.newShots || []).find((item: any) => String(item?.id) === shot.id),
          );
          shot.finalVideo = refreshed;
          if (!refreshed || refreshed.status !== 'ok' || !includeFinalVideos || !refreshed.sourceLocalPath) continue;

          const file = `videos/shot-${String(shot.index).padStart(2, '0')}.mp4`;
          const destPath = path.join(exportDir, file);
          try {
            fs.copyFileSync(refreshed.sourceLocalPath, destPath);
            refreshed.file = file;
          } catch {
            fs.rmSync(destPath, { force: true });
            refreshed.status = 'missing';
            refreshed.reason = 'TAKE_FILE_MISSING';
            refreshed.file = null;
            refreshed.fileBytes = 0;
            refreshed.actual = null;
          }
        }

        const finalVideos = shotsData
          .map(shot => shot.finalVideo)
          .filter((video): video is FinalVideoDelivery => Boolean(video));
        exportSummary = {
          ...summary,
          finalVideos: {
            present: finalVideos.filter(video => video.status === 'ok').length,
            missing: finalVideos.filter(video => video.status === 'missing').length,
            totalBytes: finalVideos.reduce((total, video) => total + (video.status === 'ok' ? video.fileBytes : 0), 0),
          },
        };
      }

      // Process characters directory and copy views (Objective 1)
      const charactersDir = path.join(exportDir, 'characters');
      fs.mkdirSync(charactersDir, { recursive: true });

      const characters = script.newCharacters || [];
      const characterStatuses: Array<{
        name: string;
        id: string;
        avatar: 'exported' | 'missing';
        front: 'exported' | 'missing';
        side: 'exported' | 'missing';
        back: 'exported' | 'missing';
      }> = [];

      characters.forEach((char: any, charIdx: number) => {
        const charFolder = `${String(charIdx + 1).padStart(2, '0')}_${sanitizeFilename(char.name || 'character')}`;
        const charDestDir = path.join(charactersDir, charFolder);
        fs.mkdirSync(charDestDir, { recursive: true });

        const charViews = {
          avatar: char.avatarImageUrl || char.avatarUrl || char.avatarGeneration?.imageUrl || null,
          front: char.views?.front || char.viewGenerations?.front?.imageUrl || null,
          side: char.views?.side || char.viewGenerations?.side?.imageUrl || null,
          back: char.views?.back || char.viewGenerations?.back?.imageUrl || null,
        };

        const status: {
          name: string;
          id: string;
          avatar: 'exported' | 'missing';
          front: 'exported' | 'missing';
          side: 'exported' | 'missing';
          back: 'exported' | 'missing';
        } = {
          name: char.name || 'Unnamed',
          id: char.id || `char-${charIdx + 1}`,
          avatar: 'missing',
          front: 'missing',
          side: 'missing',
          back: 'missing',
        };

        for (const [viewName, viewUrl] of Object.entries(charViews)) {
          if (viewUrl) {
            const localPath = getLocalPath(viewUrl, uploadsDir);
            if (localPath && isReadableFile(localPath)) {
              const ext = path.extname(localPath) || '.png';
              const destFileName = `${viewName}${ext}`;
              const destPath = path.join(charDestDir, destFileName);
              fs.copyFileSync(localPath, destPath);
              status[viewName as 'avatar' | 'front' | 'side' | 'back'] = 'exported';
            }
          }
        }
        characterStatuses.push(status);
      });

      // Process scenes directory and copy references if present (Objective 1 under P4b)
      const sceneRefs = (script as any).sceneReferences;
      const hasScenes = Array.isArray(sceneRefs) && sceneRefs.length > 0;
      let scenesReadmeSection = '3.5 场景参考清单\n本项目未使用场景参考\n';
      let scenesDirReadmeDesc = '';

      if (hasScenes) {
        const scenesDir = path.join(exportDir, 'scenes');
        fs.mkdirSync(scenesDir, { recursive: true });

        scenesDirReadmeDesc = '   - scenes/:\n     存放该剧本中所有场景的参考图，文件命名格式为 NN_名称.png，用于辅助三维空间重建或构图参考。\n';
        scenesReadmeSection = '3.5 场景参考清单\n';

        sceneRefs.forEach((scene: any, idx: number) => {
          const { fileName, localPath } = sceneExportFile(scene, idx, uploadsDir);
          const hasLocal = fileName !== null && localPath !== null;

          if (hasLocal) {
            const destPath = path.join(scenesDir, fileName);
            fs.copyFileSync(localPath, destPath);
          }

          const overlaySnippet = scene.overlay ? scene.overlay.slice(0, 60) : '无';
          const fileStatus = hasLocal ? `scenes/${fileName}` : '无参考图';
          scenesReadmeSection += `- 场景: ${scene.name || '未命名'} (ID: ${scene.id})\n`;
          scenesReadmeSection += `  * 导出状态: ${fileStatus}\n`;
          scenesReadmeSection += `  * 描述/Overlay: ${overlaySnippet}\n`;
        });
      }

      // Generate README.txt (Objective 2)
      const readmeFileName = 'README.txt';
      const readmePath = path.join(exportDir, readmeFileName);

      let characterViewsLog = '';
      characterStatuses.forEach((status) => {
        const missingViews: string[] = [];
        if (status.avatar === 'missing') missingViews.push('avatar');
        if (status.front === 'missing') missingViews.push('front');
        if (status.side === 'missing') missingViews.push('side');
        if (status.back === 'missing') missingViews.push('back');

        characterViewsLog += `- 角色: ${status.name} (ID: ${status.id})\n`;
        characterViewsLog += `  * 导出状态: avatar(${status.avatar}), front(${status.front}), side(${status.side}), back(${status.back})\n`;
        if (missingViews.length > 0) {
          characterViewsLog += `  * 缺失视图: ${missingViews.join(', ')}\n`;
        } else {
          characterViewsLog += `  * 缺失视图: 无\n`;
        }
      });

      const generationTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

      const finalVideos = shotsData
        .map(shot => ({ index: shot.index, finalVideo: shot.finalVideo as FinalVideoDelivery | undefined }))
        .filter((item): item is { index: number; finalVideo: FinalVideoDelivery } => Boolean(item.finalVideo));
      const videosDirReadmeDesc = includeFinalVideos && finalVideos.some(item => item.finalVideo.file)
        ? '   - videos/:\n     存放已通过导出时落盘复核的定稿视频，文件命名格式为 shot-xx.mp4。\n'
        : '';
      let finalVideosReadmeSection = '';
      if (finalVideos.length > 0) {
        finalVideosReadmeSection = '\n3.6 定稿视频清单\n';
        for (const { index, finalVideo } of finalVideos) {
          const actual = finalVideo.actual
            ? `${finalVideo.actual.width}x${finalVideo.actual.height} @ ${finalVideo.actual.fps} FPS, ${finalVideo.actual.durationSec}s`
            : 'ffprobe 实测不可用';
          finalVideosReadmeSection += `- 镜头 #${String(index).padStart(2, '0')} (Task: ${finalVideo.taskId})\n`;
          finalVideosReadmeSection += `  * 状态: ${finalVideo.status}${finalVideo.reason ? ` (${finalVideo.reason})` : ''}\n`;
          finalVideosReadmeSection += `  * 实测: ${actual}\n`;
          finalVideosReadmeSection += `  * 文件: ${finalVideo.file || finalVideo.sourcePath || '无'}\n`;
        }
      }

      const readmeContent = `项目交付包说明文档 (README.txt)
================================

1. 项目基本信息
   - 项目名称: ${script.newTitle || '未命名项目'}
   - 导出模式: ${mode === 'review' ? '审阅稿 (Review Mode)' : '正式交付包 (Final Mode)'}
   - 生成时间: ${generationTime} (中国标准时间)

2. 目录与文件用途说明
   - storyboard-deck.pptx:
     可视化分镜幻灯片，采用 13.33 x 7.5 英寸 (LAYOUT_WIDE) 画布比例设计，适合向导演和团队展示，支持在 PowerPoint 中直接播放。
   - storyboard-manifest.json:
     机器可读的交付包清单，包含项目元数据、叙事三要素、角色列表及所有分镜的完整结构化参数与图片相对路径。
   - finals/:
     存放导出的所有分镜对应的高清大图或降级图，文件命名格式为 shot-xx.png。
   - characters/:
     存放该剧本中所包含的角色的三视图（avatar、front、side、back），用于保持角色的一致性（Role Identity）。
${scenesDirReadmeDesc}${videosDirReadmeDesc}
3. 角色文件清单及缺失视图说明
${characterViewsLog}
${scenesReadmeSection}${finalVideosReadmeSection}
4. 正式交付包与审阅稿的区别
   - 审阅稿 (Review Mode):
     允许包含未完全定稿的分镜（标注有红色 DRAFT 警示角标），用于前中期对剧本、角色与画面布局的快速迭代与意见反馈。
   - 正式交付包 (Final Mode):
     必须要求所有分镜全部完成 ComfyUI 定稿生成，无 DRAFT 分镜，属于可直接投产的最终版本。

5. 后续 Video Lab 如何读取 storyboard-manifest.json
   - Video Lab（视频生成实验室）可以通过读取交付包根目录下的 storyboard-manifest.json 获取最新的分镜结构。
   - shots 数组中每个 shot 的 imageFile 字段记录了分镜大图在交付包中的相对路径（如 finals/shot-01.png）。
   - Video Lab 可以读取各镜头的 'camera'、'framing'、'durationSec' 以及 'optimizedPrompt' 作为视频生成任务的输入控制条件，并读取 'derivedFromShotId' 维护主帧与派生镜头的关联。

6. Windows 下打开路径和注意事项
   - 建议在解压后再打开 PowerPoint 幻灯片，避免由于临时目录权限问题导致多媒体资源或关联文件读取失败。
   - 导出的相对 URL 均基于标准规范设计，解压时请保持 storyboard-manifest.json、storyboard-deck.pptx 以及 finals/、characters/ 的相对层级结构不变。
`;

      fs.writeFileSync(readmePath, readmeContent, 'utf8');
      emitPhase('assets-ready');

      // Generate PPTX slide deck
      const pptxFileName = 'storyboard-deck.pptx';
      const pptxPath = path.join(exportDir, pptxFileName);
      emitPhase('pptx-started');
      await generatePptx(script, mode, shotsData, pptxPath, uploadsDir);
      emitPhase('pptx-written');

      // Generate Manifest JSON
      const manifestFileName = 'storyboard-manifest.json';
      const manifestPath = path.join(exportDir, manifestFileName);
      emitPhase('manifest-started');
      const manifestContent = generateManifest(script, mode, shotsData, exportRelDir, uploadsDir);
      fs.writeFileSync(manifestPath, manifestContent);
      emitPhase('manifest-written');

      // Create the ZIP package recursively scanning the exportDir (excluding the zip file itself)
      const zipFileName = 'storyboard-delivery.zip';
      const zipPath = path.join(exportDir, zipFileName);
      emitPhase('zip-started');
      await createExportZip(exportDir, zipPath);
      emitPhase('zip-written');

      // Format response returning browser accessible URL paths
      const responseData = {
        success: true,
        mode,
        exportDir,
        files: {
          pptxUrl: `/uploads/${exportRelDir}/${pptxFileName}`,
          manifestUrl: `/uploads/${exportRelDir}/${manifestFileName}`,
          zipUrl: `/uploads/${exportRelDir}/${zipFileName}`,
        },
        summary: exportSummary,
      };

      emitPhase('completed');
      return res.json(responseData);
    } catch (err: any) {
      emitPhase('failed', {
        failedPhase: activePhase,
        errorCode: String(err?.code || err?.name || 'Error'),
      });
      console.error('[Export Deck Error]', err);
      return res.status(500).json({ error: `Failed to export deck: ${err.message}` });
    }
  });
}
