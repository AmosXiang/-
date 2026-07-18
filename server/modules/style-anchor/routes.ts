import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';

export interface StyleAnchorDeps {
  readDb: () => any;
  mutateDb: (mutator: (db: any) => void | Promise<void>) => Promise<unknown>;
  uploadsDir: string;
}

interface StyleAnchor {
  imageUrl: string;
  version: number;
  note?: string;
  updatedAt: string;
}

class StyleAnchorError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
    this.name = 'StyleAnchorError';
  }
}

function sendError(res: Response, error: unknown) {
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'Style anchor images must be 10MB or smaller.' : error.message,
      code: tooLarge ? 'IMAGE_TOO_LARGE' : 'IMAGE_UPLOAD_INVALID',
    });
  }
  const known = error instanceof StyleAnchorError;
  return res.status(known ? error.status : 500).json({
    error: error instanceof Error ? error.message : 'Unknown style-anchor error.',
    ...(known ? { code: error.code } : {}),
  });
}

function generatedScripts(readDb: () => any): any[] {
  const scripts = readDb()?.generated_scripts;
  if (!Array.isArray(scripts)) throw new StyleAnchorError(500, 'Stored generated_scripts data is corrupted.', 'GENERATED_SCRIPTS_CORRUPT');
  return scripts;
}

function projectFrom(readDb: () => any, projectId: string): any {
  const project = generatedScripts(readDb).find(item => String(item?.id) === projectId);
  if (!project) throw new StyleAnchorError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
  return project;
}

function projectInStore(store: any, projectId: string): any {
  const projects = store?.generated_scripts;
  if (!Array.isArray(projects)) throw new StyleAnchorError(500, 'Stored generated_scripts data is corrupted.', 'GENERATED_SCRIPTS_CORRUPT');
  const project = projects.find((item: any) => String(item?.id) === projectId);
  if (!project) throw new StyleAnchorError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
  return project;
}

function safeProjectId(value: unknown): string {
  const projectId = String(value || '');
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new StyleAnchorError(400, 'Project id is not safe for a local asset path.', 'PROJECT_ID_INVALID');
  }
  return projectId;
}

function storedAnchor(project: any): StyleAnchor | null {
  const value = project?.styleAnchor;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.imageUrl !== 'string' || !Number.isInteger(value.version) || value.version < 1) {
    throw new StyleAnchorError(500, 'Stored style anchor data is corrupted.', 'STYLE_ANCHOR_CORRUPT');
  }
  return {
    imageUrl: value.imageUrl,
    version: value.version,
    ...(typeof value.note === 'string' && value.note ? { note: value.note } : {}),
    updatedAt: String(value.updatedAt || ''),
  };
}

function noteValue(value: unknown, fallback?: string): string | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new StyleAnchorError(400, 'note must be a string.', 'NOTE_INVALID');
  const note = value.trim();
  if (note.length > 1000) throw new StyleAnchorError(422, 'note must be 1000 characters or shorter.', 'NOTE_TOO_LONG');
  return note || undefined;
}

function requiredShotId(value: unknown): string {
  const shotId = typeof value === 'string' ? value.trim() : '';
  if (!shotId || shotId.length > 256) {
    throw new StyleAnchorError(400, 'shotId is required.', 'SHOT_ID_INVALID');
  }
  return shotId;
}

function shotInProject(project: any, shotId: string): any {
  const shots = Array.isArray(project?.newShots) ? project.newShots : [];
  const shot = shots.find((item: any) => String(item?.id) === shotId);
  if (!shot) throw new StyleAnchorError(404, `Shot '${shotId}' not found.`, 'SHOT_NOT_FOUND');
  return shot;
}

function recipeSnapshot(shot: any): any {
  const recipe = shot?.gen_recipe;
  if (!recipe || typeof recipe !== 'object' || typeof recipe.fingerprint !== 'string' || !recipe.fingerprint.trim()) {
    throw new StyleAnchorError(422, 'The selected shot has no generation recipe.', 'RECIPE_MISSING');
  }
  return JSON.parse(JSON.stringify(recipe));
}

function anchorDirectory(uploadsDir: string): string {
  return path.resolve(uploadsDir, 'style-anchors');
}

function storedAbsolutePath(uploadsDir: string, projectId: string, anchor: StyleAnchor): string {
  const prefix = '/uploads/style-anchors/';
  if (!anchor.imageUrl.startsWith(prefix)) {
    throw new StyleAnchorError(422, 'Stored style anchor path is outside style-anchors.', 'IMAGE_PATH_INVALID');
  }
  const filename = anchor.imageUrl.slice(prefix.length);
  const expectedPrefix = `${projectId}-${anchor.version}.`;
  if (!filename.startsWith(expectedPrefix) || path.basename(filename) !== filename) {
    throw new StyleAnchorError(422, 'Stored style anchor path does not match the project and version.', 'IMAGE_PATH_INVALID');
  }
  const root = anchorDirectory(uploadsDir);
  const absolute = path.resolve(root, filename);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StyleAnchorError(422, 'Stored style anchor path escaped the upload directory.', 'IMAGE_PATH_INVALID');
  }
  return absolute;
}

function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function imageExtension(format: string | undefined): string {
  const extensions: Record<string, string> = {
    jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', avif: '.avif', tiff: '.tiff',
  };
  const extension = format ? extensions[format] : undefined;
  if (!extension) throw new StyleAnchorError(415, 'Unsupported or undecodable image format.', 'IMAGE_TYPE_INVALID');
  return extension;
}

export function registerStyleAnchorModule(app: Express, deps: StyleAnchorDeps): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (!String(file.mimetype || '').startsWith('image/')) {
        callback(new StyleAnchorError(415, 'Only image files are accepted.', 'IMAGE_TYPE_INVALID'));
        return;
      }
      callback(null, true);
    },
  });

  app.put('/api/projects/:projectId/approved-recipe', async (req: Request, res: Response) => {
    try {
      const projectId = safeProjectId(req.params.projectId);
      const shotId = requiredShotId(req.body?.shotId);
      let approvedRecipe: any;
      await deps.mutateDb((store: any) => {
        const project = projectInStore(store, projectId);
        const recipe = recipeSnapshot(shotInProject(project, shotId));
        approvedRecipe = {
          fingerprint: recipe.fingerprint,
          recipe,
          setFromShotId: shotId,
          setAt: new Date().toISOString(),
        };
        project.approvedRecipe = approvedRecipe;
      });
      return res.json({ success: true, approvedRecipe });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete('/api/projects/:projectId/approved-recipe', async (req: Request, res: Response) => {
    try {
      const projectId = safeProjectId(req.params.projectId);
      await deps.mutateDb((store: any) => {
        delete projectInStore(store, projectId).approvedRecipe;
      });
      return res.json({ success: true, approvedRecipe: null });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/generated-scripts/:projectId/shots/:shotId/style-approved', async (req: Request, res: Response) => {
    try {
      const projectId = safeProjectId(req.params.projectId);
      const shotId = requiredShotId(req.params.shotId);
      if (typeof req.body?.approved !== 'boolean') {
        throw new StyleAnchorError(400, 'approved must be boolean.', 'APPROVED_STATE_INVALID');
      }
      let styleApproved: any = null;
      await deps.mutateDb((store: any) => {
        const shot = shotInProject(projectInStore(store, projectId), shotId);
        if (req.body.approved) {
          const recipe = recipeSnapshot(shot);
          styleApproved = {
            approvedFingerprint: recipe.fingerprint,
            approvedAt: new Date().toISOString(),
          };
          shot.styleApproved = styleApproved;
        } else {
          delete shot.styleApproved;
        }
      });
      return res.json({ success: true, styleApproved });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/projects/:projectId/style-anchor', (req: Request, res: Response) => {
    try {
      const projectId = safeProjectId(req.params.projectId);
      return res.json({ styleAnchor: storedAnchor(projectFrom(deps.readDb, projectId)) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/projects/:projectId/style-anchor', (req: Request, res: Response) => {
    upload.single('image')(req, res, async uploadError => {
      if (uploadError) return sendError(res, uploadError);
      let writtenPath = '';
      try {
        const projectId = safeProjectId(req.params.projectId);
        const current = storedAnchor(projectFrom(deps.readDb, projectId));
        const note = noteValue(req.body?.note, current?.note);
        if (!req.file && !current) throw new StyleAnchorError(400, 'An image file is required for a new style anchor.', 'IMAGE_REQUIRED');

        let version = current?.version || 0;
        let imageUrl = current?.imageUrl || '';
        let imageChanged = false;
        let previousPath = '';

        if (req.file) {
          const metadata = await sharp(req.file.buffer).metadata().catch(() => null);
          const extension = imageExtension(metadata?.format);
          if (!metadata?.width || !metadata?.height) throw new StyleAnchorError(415, 'The uploaded image could not be decoded.', 'IMAGE_TYPE_INVALID');
          let sameImage = false;
          if (current) {
            previousPath = storedAbsolutePath(deps.uploadsDir, projectId, current);
            const previousBytes = await fs.promises.readFile(previousPath).catch(() => null);
            sameImage = Boolean(previousBytes && digest(previousBytes) === digest(req.file.buffer));
          }
          if (!sameImage) {
            version += 1;
            const directory = anchorDirectory(deps.uploadsDir);
            await fs.promises.mkdir(directory, { recursive: true });
            writtenPath = path.join(directory, `${projectId}-${version}${extension}`);
            await fs.promises.writeFile(writtenPath, req.file.buffer);
            imageUrl = `/uploads/style-anchors/${path.basename(writtenPath)}`;
            imageChanged = true;
          }
        }

        const noteChanged = note !== current?.note;
        const updatedAt = imageChanged || noteChanged || !current
          ? new Date().toISOString()
          : current.updatedAt;
        const styleAnchor: StyleAnchor = { imageUrl, version, ...(note ? { note } : {}), updatedAt };

        await deps.mutateDb((store: any) => {
          projectInStore(store, projectId).styleAnchor = styleAnchor;
        });
        if (imageChanged && previousPath && previousPath !== writtenPath) {
          await fs.promises.rm(previousPath, { force: true }).catch(() => undefined);
        }
        writtenPath = '';
        return res.json({ success: true, styleAnchor });
      } catch (error) {
        if (writtenPath) await fs.promises.rm(writtenPath, { force: true }).catch(() => undefined);
        return sendError(res, error);
      }
    });
  });

  app.delete('/api/projects/:projectId/style-anchor', async (req: Request, res: Response) => {
    try {
      const projectId = safeProjectId(req.params.projectId);
      const current = storedAnchor(projectFrom(deps.readDb, projectId));
      const absolutePath = current ? storedAbsolutePath(deps.uploadsDir, projectId, current) : '';
      await deps.mutateDb((store: any) => {
        delete projectInStore(store, projectId).styleAnchor;
      });
      if (absolutePath) await fs.promises.rm(absolutePath, { force: true });
      return res.json({ success: true, styleAnchor: null });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
