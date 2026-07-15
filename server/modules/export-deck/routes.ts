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

      // Generate PPTX slide deck
      const pptxFileName = 'storyboard-deck.pptx';
      const pptxPath = path.join(exportDir, pptxFileName);
      await generatePptx(script, mode, shotsData, pptxPath, uploadsDir);

      // Generate Manifest JSON
      const manifestFileName = 'storyboard-manifest.json';
      const manifestPath = path.join(exportDir, manifestFileName);
      const manifestContent = generateManifest(script, mode, shotsData, exportRelDir, uploadsDir);
      fs.writeFileSync(manifestPath, manifestContent);

      // Create the ZIP package
      const zipFileName = 'storyboard-delivery.zip';
      const zipPath = path.join(exportDir, zipFileName);
      await createExportZip(pptxPath, manifestPath, finalsDir, zipPath);

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
