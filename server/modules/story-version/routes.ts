import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import {
  StoryVersionError,
  appendStorySnapshot,
  deriveStoryDraft,
  findProject,
  findStorySnapshot,
  listStorySnapshots,
  parseStoryVersion,
  successfulShotIds,
  validateMarkShotsStale,
  validateNote,
  validateStoryDraft,
} from './workflow.ts';

type DatabaseInstance = Database.Database;

export interface StoryVersionDeps {
  mutateDb: (mutator: (db: any) => void | Promise<void>) => Promise<unknown>;
}

function sendError(res: Response, error: unknown) {
  const known = error instanceof StoryVersionError;
  const status = known ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Unknown story-version error.';
  return res.status(status).json({ error: message, ...(known ? { code: error.code } : {}) });
}

function storyResponse(project: any) {
  const storyVersion = Number(project.storyVersion || 0);
  if (!project.storyDraft || storyVersion < 1) {
    return {
      initialized: false,
      storyVersion: 0,
      storyDraft: deriveStoryDraft(project),
      versions: [],
    };
  }
  return {
    initialized: true,
    storyVersion,
    storyDraft: project.storyDraft,
    versions: [...listStorySnapshots(project)]
      .sort((a, b) => b.version - a.version)
      .map(({ version, savedAt, note }) => ({ version, savedAt, ...(note ? { note } : {}) })),
  };
}

export function registerStoryVersionModule(app: Express, db: DatabaseInstance, deps: StoryVersionDeps): void {
  app.get('/api/generated-scripts/:id/story', (req: Request, res: Response) => {
    try {
      return res.json(storyResponse(findProject(db, String(req.params.id))));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/generated-scripts/:id/story', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const storyDraft = validateStoryDraft(req.body?.storyDraft);
      const note = validateNote(req.body?.note);
      const markShotsStale = validateMarkShotsStale(req.body?.markShotsStale);
      findProject(db, projectId);
      const successfulIds = markShotsStale ? successfulShotIds(db, projectId) : undefined;
      let result = { storyVersion: 0, staleMarked: 0 };
      await deps.mutateDb((store: any) => {
        const project = store.generated_scripts.find((item: any) => String(item.id) === projectId);
        if (!project) throw new StoryVersionError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
        result = appendStorySnapshot(project, storyDraft, {
          savedAt: new Date().toISOString(),
          note,
          successfulIds,
        });
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/generated-scripts/:id/story/versions/:version', (req: Request, res: Response) => {
    try {
      const project = findProject(db, String(req.params.id));
      const version = parseStoryVersion(req.params.version);
      return res.json(findStorySnapshot(project, version));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/generated-scripts/:id/story/rollback', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const version = parseStoryVersion(req.body?.version);
      const markShotsStale = validateMarkShotsStale(req.body?.markShotsStale);
      const currentProject = findProject(db, projectId);
      if (Number(currentProject.storyVersion) === version) {
        throw new StoryVersionError(400, 'The selected version is already current.', 'STORY_VERSION_ALREADY_CURRENT');
      }
      findStorySnapshot(currentProject, version);
      const successfulIds = markShotsStale ? successfulShotIds(db, projectId) : undefined;
      let result = { storyVersion: 0, staleMarked: 0 };
      await deps.mutateDb((store: any) => {
        const project = store.generated_scripts.find((item: any) => String(item.id) === projectId);
        if (!project) throw new StoryVersionError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
        if (Number(project.storyVersion) === version) {
          throw new StoryVersionError(400, 'The selected version is already current.', 'STORY_VERSION_ALREADY_CURRENT');
        }
        const snapshot = findStorySnapshot(project, version);
        result = appendStorySnapshot(project, snapshot.storyDraft, {
          savedAt: new Date().toISOString(),
          successfulIds,
        });
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
