import fs from 'node:fs';
import path from 'node:path';

/**
 * Checks if a file exists, is actually a file, and has read permissions.
 */
export function isReadableFile(filePath: string): boolean {
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
export function getLocalPath(url: string | undefined | null, uploadsDir: string): string | null {
  if (!url) return null;
  const cleanUrl = url.startsWith('/') ? url.slice(1) : url;
  if (!cleanUrl.startsWith('uploads/')) {
    return null;
  }
  const relativePart = cleanUrl.slice('uploads/'.length);
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

/**
 * Sanitizes folder and file names to prevent path traversal and bad characters.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}_\-]/gu, '_');
}

/**
 * Resolves a scene's file export information, returning the target filename
 * and the validated local source path.
 */
export function sceneExportFile(
  scene: any,
  idx: number,
  uploadsDir: string
): { fileName: string | null; localPath: string | null } {
  if (!scene || !scene.imageUrl) {
    return { fileName: null, localPath: null };
  }
  const localPath = getLocalPath(scene.imageUrl, uploadsDir);
  if (localPath && isReadableFile(localPath)) {
    const ext = path.extname(localPath) || '.png';
    const twoDigitIdx = String(idx + 1).padStart(2, '0');
    const sanitizedName = sanitizeFilename(scene.name || 'scene');
    const fileName = `${twoDigitIdx}_${sanitizedName}${ext}`;
    return { fileName, localPath };
  }
  return { fileName: null, localPath: null };
}
