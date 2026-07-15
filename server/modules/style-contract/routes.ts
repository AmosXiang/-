import type { Express, Request, Response } from 'express';
import {
  STYLE_CONTRACT_FIELD_NAMES,
  StyleContractError,
  deriveStyleContract,
  findStyleContractProject,
  findStyleContractProjectInStore,
  isStyleContractInitialized,
  missingStyleContractFields,
  storedStyleContractFields,
  styleContractFieldsEqual,
  validateStyleContract,
  type ReadDb,
  type StoredStyleContract,
  type StyleContractFields,
} from './workflow.ts';

export interface StyleContractDeps {
  readDb: ReadDb;
  mutateDb: (mutator: (db: any) => void | Promise<void>) => Promise<unknown>;
}

function sendError(res: Response, error: unknown) {
  const known = error instanceof StyleContractError;
  const status = known ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Unknown style-contract error.';
  return res.status(status).json({
    error: message,
    ...(known ? { code: error.code, ...error.details } : {}),
  });
}

function validateOptionalLock(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new StyleContractError(400, 'lock must be boolean when provided.', 'LOCK_STATE_INVALID');
  }
  return value;
}

function validateLocked(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new StyleContractError(400, 'locked must be boolean.', 'LOCK_STATE_INVALID');
  }
  return value;
}

function contractResponse(project: any) {
  if (!isStyleContractInitialized(project)) {
    return {
      initialized: false,
      version: 0,
      locked: false,
      contract: deriveStyleContract(project),
    };
  }
  return {
    initialized: true,
    version: Number(project.styleContract.version),
    locked: project.styleContract.locked === true,
    updatedAt: String(project.styleContract.updatedAt || ''),
    contract: storedStyleContractFields(project.styleContract),
  };
}

function writeThrough(project: any, contract: StyleContractFields, updatedAt?: string) {
  project.comfyuiPreferences = {
    ...(project.comfyuiPreferences && typeof project.comfyuiPreferences === 'object' ? project.comfyuiPreferences : {}),
    shotPresetId: contract.storyboardPresetId,
  };
  project.artDirection = {
    ...(project.artDirection && typeof project.artDirection === 'object' ? project.artDirection : {}),
    overlay: contract.styleOverlay,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function registerStyleContractModule(app: Express, deps: StyleContractDeps): void {
  app.get('/api/generated-scripts/:id/style-contract', (req: Request, res: Response) => {
    try {
      return res.json(contractResponse(findStyleContractProject(deps.readDb, String(req.params.id))));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/generated-scripts/:id/style-contract', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const contract = validateStyleContract(req.body?.contract);
      const requestedLock = validateOptionalLock(req.body?.lock);
      let result: { version: number; locked: boolean; contract: StyleContractFields } | undefined;

      await deps.mutateDb((store: any) => {
        const project = findStyleContractProjectInStore(store, projectId);
        const initialized = isStyleContractInitialized(project);
        if (initialized && project.styleContract.locked === true) {
          throw new StyleContractError(409, 'Unlock the style contract before editing it.', 'CONTRACT_LOCKED');
        }

        const current = initialized ? storedStyleContractFields(project.styleContract) : undefined;
        const changed = !current || !styleContractFieldsEqual(current, contract);
        const now = new Date().toISOString();
        const version = changed ? Number(project.styleContract?.version || 0) + 1 : Number(project.styleContract.version);
        const locked = requestedLock ?? (initialized ? project.styleContract.locked === true : false);
        const updatedAt = changed ? now : String(project.styleContract.updatedAt || now);
        const stored: StoredStyleContract = { version, locked, updatedAt, ...contract };

        project.styleContract = stored;
        writeThrough(project, contract, changed ? now : undefined);
        result = { version, locked, contract: storedStyleContractFields(stored) };
      });

      return res.json({ success: true, ...result! });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/generated-scripts/:id/style-contract/lock', async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.id);
      const locked = validateLocked(req.body?.locked);
      let result = { version: 0, locked: false };

      await deps.mutateDb((store: any) => {
        const project = findStyleContractProjectInStore(store, projectId);
        if (!isStyleContractInitialized(project)) {
          if (locked) {
            throw new StyleContractError(422, 'The style contract is incomplete.', 'CONTRACT_INCOMPLETE', {
              missing: [...STYLE_CONTRACT_FIELD_NAMES],
            });
          }
          result = { version: 0, locked: false };
          return;
        }

        const missing = missingStyleContractFields(project.styleContract);
        if (locked && missing.length > 0) {
          throw new StyleContractError(422, 'The style contract is incomplete.', 'CONTRACT_INCOMPLETE', { missing });
        }
        project.styleContract.locked = locked;
        result = { version: Number(project.styleContract.version), locked };
      });

      return res.json({ success: true, ...result });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/generated-scripts/:id/style-contract/preflight', (req: Request, res: Response) => {
    try {
      const project = findStyleContractProject(deps.readDb, String(req.params.id));
      const initialized = isStyleContractInitialized(project);
      const missing = initialized
        ? missingStyleContractFields(project.styleContract)
        : [...STYLE_CONTRACT_FIELD_NAMES];
      const locked = initialized && project.styleContract.locked === true;
      return res.json({ ready: locked && missing.length === 0, locked, missing });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
