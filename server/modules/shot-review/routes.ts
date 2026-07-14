import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import {
  ShotReviewError,
  findProjectShot,
  findStaleShots,
  listShotVersions,
  readGeneratedScripts,
  validateFinalTask,
} from './workflow.ts';

type DatabaseInstance = Database.Database;

export interface ShotReviewDeps {
  mutateDb: (mutator: (db: any) => void | Promise<void>) => Promise<unknown>;
  uploadsDir: string;
}

function sendError(res: Response, error: unknown) {
  const known = error instanceof ShotReviewError;
  const status = known ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Unknown shot-review error.';
  return res.status(status).json({ error: message, ...(known && error.code ? { code: error.code } : {}) });
}

export function registerShotReviewModule(app: Express, db: DatabaseInstance, deps: ShotReviewDeps): void {
  app.get('/api/generated-scripts/:id/shots/:shotId/versions', (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const shotId = String(req.params.shotId);
      const { shot } = findProjectShot(db, projectId, shotId);
      return res.json({ versions: listShotVersions(db, projectId, shotId, shot.finalTaskId) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/generated-scripts/:id/shots/:shotId/final', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const shotId = String(req.params.shotId);
      const taskId = String(req.body?.taskId || '').trim();
      if (!taskId) throw new ShotReviewError(400, 'taskId is required.', 'TASK_ID_REQUIRED');
      findProjectShot(db, projectId, shotId);
      const task = validateFinalTask(db, projectId, shotId, taskId, deps.uploadsDir);

      let updatedShot: any = null;
      await deps.mutateDb((store: any) => {
        const project = store.generated_scripts.find((item: any) => String(item.id) === projectId);
        const shot = project?.newShots?.find((item: any) => String(item.id) === shotId);
        if (!shot) throw new ShotReviewError(404, `Shot '${shotId}' no longer exists.`, 'SHOT_NOT_FOUND');
        shot.finalTaskId = taskId;
        shot.finalizedImageUrl = String(task.imageUrl);
        updatedShot = { ...shot };
      });
      return res.json({ success: true, shot: updatedShot });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete('/api/generated-scripts/:id/shots/:shotId/final', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const shotId = String(req.params.shotId);
      findProjectShot(db, projectId, shotId);
      let updatedShot: any = null;
      await deps.mutateDb((store: any) => {
        const project = store.generated_scripts.find((item: any) => String(item.id) === projectId);
        const shot = project?.newShots?.find((item: any) => String(item.id) === shotId);
        if (!shot) throw new ShotReviewError(404, `Shot '${shotId}' no longer exists.`, 'SHOT_NOT_FOUND');
        delete shot.finalTaskId;
        delete shot.finalizedImageUrl;
        updatedShot = { ...shot };
      });
      return res.json({ success: true, shot: updatedShot });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/generated-scripts/:id/stale-check', (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const project = readGeneratedScripts(db).find(item => String(item.id) === projectId);
      if (!project) throw new ShotReviewError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
      return res.json({ staleShots: findStaleShots(db, project) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/generated-scripts/:id/shots/mark-stale', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      if (!Array.isArray(req.body?.shotIds) || req.body.shotIds.length === 0) {
        throw new ShotReviewError(400, 'shotIds must be a non-empty array.', 'SHOT_IDS_REQUIRED');
      }
      if (typeof req.body?.isStale !== 'boolean') {
        throw new ShotReviewError(400, 'isStale must be boolean.', 'IS_STALE_REQUIRED');
      }
      const shotIds = [...new Set(req.body.shotIds.map((value: unknown) => String(value)))];
      let updatedShots: any[] = [];
      await deps.mutateDb((store: any) => {
        const project = store.generated_scripts.find((item: any) => String(item.id) === projectId);
        if (!project) throw new ShotReviewError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
        const shotsById = new Map((project.newShots || []).map((shot: any) => [String(shot.id), shot]));
        const missing = shotIds.filter(shotId => !shotsById.has(shotId));
        if (missing.length) {
          throw new ShotReviewError(400, `Unknown shotIds: ${missing.join(', ')}`, 'SHOT_IDS_UNKNOWN');
        }
        updatedShots = shotIds.map(shotId => {
          const shot: any = shotsById.get(shotId);
          shot.isStale = req.body.isStale;
          return { id: shotId, isStale: shot.isStale };
        });
      });
      return res.json({ success: true, shots: updatedShots });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
