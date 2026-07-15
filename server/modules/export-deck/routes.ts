import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { generatePptx, generateManifest, createExportZip } from './generator.ts';

type DatabaseInstance = Database.Database;

export interface ExportDeckConfig {
  uploadsDir: string;
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

/**
 * Checks if a file exists, is actually a file, and has read permissions.
 */
function isReadableFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitizes folder and file names to prevent path traversal and bad characters.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_\-]/g, '_');
}

/**
 * Resolves a URL of the format /uploads/... to a local absolute path,
 * checking that it lies within the uploadsDir to prevent directory traversal.
 */
function getLocalPath(url: string | undefined | null, uploadsDir: string): string | null {
  if (!url) return null;
  const cleanUrl = url.startsWith('/') ? url.slice(1) : url;
  if (!cleanUrl.startsWith('uploads/')) {
    return null;
  }
  const relativePart = cleanUrl.slice('uploads/'.length);
  // Ensure we resolve against the exact absolute path of uploadsDir
  const absoluteUploadsDir = path.resolve(uploadsDir);
  const absolutePath = path.resolve(absoluteUploadsDir, relativePart);

  // Prevent path traversal
  const relative = path.relative(absoluteUploadsDir, absolutePath);
  const isInside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!isInside) {
    return null;
  }
  return absolutePath;
}

export function registerExportDeckModule(
  app: Express,
  db: DatabaseInstance,
  config: ExportDeckConfig
): void {
  const uploadsDir = config.uploadsDir;

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

    if (mode !== 'final' && mode !== 'review') {
      return res.status(400).json({ error: "mode field is required and must be either 'final' or 'review'" });
    }

    const scripts = readScripts(db);
    const script = scripts.find(s => String(s.id) === projectId);

    if (!script) {
      return res.status(404).json({ error: `Project ${projectId} not found` });
    }

    const { summary, shotsData } = performDeliveryCheck(projectId, script);

    // If final mode, require all shots to be finalized
    if (mode === 'final' && summary.notFinalized > 0) {
      return res.status(409).json({
        error: `Cannot export in final mode: ${summary.notFinalized} shots are not finalized.`,
        missing: summary.details,
        details: summary.details,
      });
    }

    try {
      // Setup filesystem safe timestamp directory name
      // replacing all : and . with -
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
      const exportRelDir = `exports/${projectId}/${timestamp}`;
      const exportDir = path.join(uploadsDir, exportRelDir);
      const finalsDir = path.join(exportDir, 'finals');

      // Create directories
      fs.mkdirSync(exportDir, { recursive: true });
      fs.mkdirSync(finalsDir, { recursive: true });

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

3. 角色文件清单及缺失视图说明
${characterViewsLog}

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

      // Generate PPTX slide deck
      const pptxFileName = 'storyboard-deck.pptx';
      const pptxPath = path.join(exportDir, pptxFileName);
      await generatePptx(script, mode, shotsData, pptxPath, uploadsDir);

      // Generate Manifest JSON
      const manifestFileName = 'storyboard-manifest.json';
      const manifestPath = path.join(exportDir, manifestFileName);
      const manifestContent = generateManifest(script, mode, shotsData, exportRelDir, uploadsDir);
      fs.writeFileSync(manifestPath, manifestContent);

      // Create the ZIP package recursively scanning the exportDir (excluding the zip file itself)
      const zipFileName = 'storyboard-delivery.zip';
      const zipPath = path.join(exportDir, zipFileName);
      await createExportZip(exportDir, zipPath);

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
        summary,
      };

      return res.json(responseData);
    } catch (err: any) {
      console.error('[Export Deck Error]', err);
      return res.status(500).json({ error: `Failed to export deck: ${err.message}` });
    }
  });
}
