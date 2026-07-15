import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import {
  SceneReferenceError,
  findSceneProject,
  findSceneProjectInStore,
  storedSceneReferences,
  validateSceneReferences,
  type ReadDb,
  type SceneReference,
} from './workflow.ts';

export interface SceneReferenceDeps {
  readDb: ReadDb;
  mutateDb: (mutator: (db: any) => void | Promise<void>) => Promise<unknown>;
  uploadsDir: string;
}

function sendError(res: Response, error: unknown) {
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'Scene reference images must be 10MB or smaller.' : error.message,
      code: tooLarge ? 'IMAGE_TOO_LARGE' : 'IMAGE_UPLOAD_INVALID',
    });
  }
  const known = error instanceof SceneReferenceError;
  const status = known ? error.status : 500;
  return res.status(status).json({
    error: error instanceof Error ? error.message : 'Unknown scene-reference error.',
    ...(known ? { code: error.code, ...error.details } : {}),
  });
}

function uploadExtension(file: Express.Multer.File): string {
  const extension = path.extname(file.originalname || '').toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  const subtype = String(file.mimetype || '').split('/')[1]?.split('+')[0]?.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return subtype ? `.${subtype === 'jpeg' ? 'jpg' : subtype}` : '.img';
}

export function registerSceneReferenceModule(app: Express, deps: SceneReferenceDeps): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (!String(file.mimetype || '').startsWith('image/')) {
        callback(new SceneReferenceError(415, 'Only image files are accepted.', 'IMAGE_TYPE_INVALID'));
        return;
      }
      callback(null, true);
    },
  });

  app.get('/api/generated-scripts/:id/scene-references', (req: Request, res: Response) => {
    try {
      const project = findSceneProject(deps.readDb, String(req.params.id));
      return res.json({ scenes: storedSceneReferences(project) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/generated-scripts/:id/scene-references', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      let result: { scenes: SceneReference[]; orphanedShotCount: number } | undefined;
      await deps.mutateDb((store: any) => {
        const project = findSceneProjectInStore(store, projectId);
        const current = storedSceneReferences(project);
        const scenes = validateSceneReferences(req.body?.scenes, current);
        const retainedIds = new Set(scenes.map(scene => scene.id));
        const removedIds = new Set(current.filter(scene => !retainedIds.has(scene.id)).map(scene => scene.id));
        const orphanedShotCount = Array.isArray(project.newShots)
          ? project.newShots.filter((shot: any) => shot?.sceneId && removedIds.has(String(shot.sceneId))).length
          : 0;
        project.sceneReferences = scenes;
        result = { scenes, orphanedShotCount };
      });
      return res.json({ success: true, ...result! });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/generated-scripts/:id/scene-references/:sceneId/image', (req: Request, res: Response) => {
    upload.single('image')(req, res, async uploadError => {
      if (uploadError) return sendError(res, uploadError);
      let absolutePath = '';
      try {
        const projectId = String(req.params.id);
        const sceneId = String(req.params.sceneId);
        findSceneProject(deps.readDb, projectId);
        if (!req.file) throw new SceneReferenceError(400, 'An image file is required.', 'IMAGE_REQUIRED');

        const relativeDirectory = 'scene-refs';
        const targetDirectory = path.join(deps.uploadsDir, relativeDirectory);
        await fs.promises.mkdir(targetDirectory, { recursive: true });
        const filename = `${crypto.randomUUID()}${uploadExtension(req.file)}`;
        absolutePath = path.join(targetDirectory, filename);
        await fs.promises.writeFile(absolutePath, req.file.buffer);
        const imageUrl = `/uploads/${relativeDirectory}/${filename}`;
        let scene: SceneReference | undefined;

        await deps.mutateDb((store: any) => {
          const project = findSceneProjectInStore(store, projectId);
          const scenes = storedSceneReferences(project);
          const index = scenes.findIndex(item => item.id === sceneId);
          if (index < 0) throw new SceneReferenceError(404, 'Scene reference not found.', 'SCENE_NOT_FOUND');
          scenes[index] = { ...scenes[index], imageUrl, updatedAt: new Date().toISOString() };
          project.sceneReferences = scenes;
          scene = scenes[index];
        });

        return res.json({ success: true, scene });
      } catch (error) {
        if (absolutePath) await fs.promises.rm(absolutePath, { force: true }).catch(() => undefined);
        return sendError(res, error);
      }
    });
  });

  app.put('/api/generated-scripts/:id/shots/:shotId/scene', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const shotId = String(req.params.shotId);
      const requestedSceneId = req.body?.sceneId;
      if (requestedSceneId !== null && typeof requestedSceneId !== 'string') {
        throw new SceneReferenceError(400, 'sceneId must be a string or null.', 'SCENE_ID_REQUIRED');
      }
      const sceneId = requestedSceneId === null ? null : requestedSceneId.trim();
      if (sceneId === '') throw new SceneReferenceError(422, 'sceneId must not be empty.', 'SCENE_NOT_FOUND');
      let updatedShot: any = null;

      await deps.mutateDb((store: any) => {
        const project = findSceneProjectInStore(store, projectId);
        const shots = Array.isArray(project.newShots) ? project.newShots : [];
        const shot = shots.find((item: any) => String(item?.id) === shotId);
        if (!shot) throw new SceneReferenceError(404, 'Shot not found.', 'SHOT_NOT_FOUND');
        if (sceneId !== null && !storedSceneReferences(project).some(scene => scene.id === sceneId)) {
          throw new SceneReferenceError(422, 'Scene reference not found.', 'SCENE_NOT_FOUND', { sceneId });
        }
        if (sceneId === null) delete shot.sceneId;
        else shot.sceneId = sceneId;
        updatedShot = shot;
      });

      return res.json({ success: true, shot: updatedShot });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
