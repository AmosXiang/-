import crypto from 'node:crypto';

export interface SceneReference {
  id: string;
  name: string;
  imageUrl?: string;
  overlay?: string;
  updatedAt: string;
}

export type ReadDb = () => { generated_scripts?: any[] };

export class SceneReferenceError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SceneReferenceError';
  }
}

export function findSceneProject(readDb: ReadDb, projectId: string): any {
  const project = readDb().generated_scripts?.find(item => String(item.id) === String(projectId));
  if (!project) throw new SceneReferenceError(404, 'Project not found.', 'PROJECT_NOT_FOUND');
  return project;
}

export function findSceneProjectInStore(store: any, projectId: string): any {
  const project = store?.generated_scripts?.find((item: any) => String(item.id) === String(projectId));
  if (!project) throw new SceneReferenceError(404, 'Project not found.', 'PROJECT_NOT_FOUND');
  return project;
}

export function storedSceneReferences(project: any): SceneReference[] {
  if (!Array.isArray(project?.sceneReferences)) return [];
  return project.sceneReferences
    .filter((scene: any) => scene && typeof scene === 'object')
    .map((scene: any) => ({
      id: String(scene.id || ''),
      name: String(scene.name || ''),
      ...(typeof scene.imageUrl === 'string' && scene.imageUrl ? { imageUrl: scene.imageUrl } : {}),
      ...(typeof scene.overlay === 'string' ? { overlay: scene.overlay } : {}),
      updatedAt: String(scene.updatedAt || ''),
    }));
}

function invalid(message: string, code = 'SCENE_REFERENCE_INVALID', details: Record<string, unknown> = {}): never {
  throw new SceneReferenceError(422, message, code, details);
}

export function validateSceneReferences(value: unknown, currentScenes: SceneReference[], now = new Date().toISOString()): SceneReference[] {
  if (!Array.isArray(value)) {
    throw new SceneReferenceError(400, 'scenes must be an array.', 'SCENES_REQUIRED');
  }
  if (value.length > 20) invalid('A project may contain at most 20 scene references.', 'SCENE_LIMIT_EXCEEDED', { limit: 20 });

  const currentById = new Map(currentScenes.map(scene => [scene.id, scene]));
  const ids = new Set<string>();
  return value.map((raw: any, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Each scene must be an object.', 'SCENE_REFERENCE_INVALID', { index });
    const id = raw.id === undefined || raw.id === null || raw.id === '' ? crypto.randomUUID() : String(raw.id).trim();
    if (!id) invalid('Scene id must not be empty.', 'SCENE_REFERENCE_INVALID', { index, field: 'id' });
    if (ids.has(id)) invalid('Scene ids must be unique.', 'SCENE_ID_DUPLICATE', { index, id });
    ids.add(id);

    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      invalid('Scene name must be a non-empty string.', 'SCENE_REFERENCE_INVALID', { index, field: 'name' });
    }
    if (raw.overlay !== undefined && typeof raw.overlay !== 'string') {
      invalid('Scene overlay must be a string when provided.', 'SCENE_REFERENCE_INVALID', { index, field: 'overlay' });
    }
    if (typeof raw.overlay === 'string' && raw.overlay.length > 2000) {
      invalid('Scene overlay must contain at most 2000 characters.', 'SCENE_OVERLAY_TOO_LONG', { index, field: 'overlay', limit: 2000 });
    }

    const existing = currentById.get(id);
    if (Object.prototype.hasOwnProperty.call(raw, 'imageUrl')) {
      if (!existing || raw.imageUrl !== existing.imageUrl) {
        invalid('imageUrl is read-only and may only be changed through the image upload endpoint.', 'IMAGE_URL_READ_ONLY', { index, field: 'imageUrl' });
      }
    }

    return {
      id,
      name: raw.name.trim(),
      ...(existing?.imageUrl ? { imageUrl: existing.imageUrl } : {}),
      ...(raw.overlay === undefined ? {} : { overlay: raw.overlay }),
      updatedAt: now,
    };
  });
}

export function sceneForShot(project: any, shotId: string): { id: string; overlay: string } | null {
  const shot = Array.isArray(project?.newShots)
    ? project.newShots.find((item: any) => String(item?.id) === String(shotId))
    : undefined;
  if (!shot?.sceneId) return null;
  const scene = storedSceneReferences(project).find(item => item.id === String(shot.sceneId));
  if (!scene) return null;
  return { id: scene.id, overlay: String(scene.overlay || '') };
}
