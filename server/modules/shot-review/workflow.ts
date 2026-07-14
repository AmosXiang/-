import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

type DatabaseInstance = Database.Database;

export class ShotReviewError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ShotReviewError';
  }
}

export interface ShotVersion {
  taskId: string;
  imageUrl: string | null;
  prompt: string;
  negativePrompt: string;
  seed: string;
  model: string;
  status: string;
  createdAt: string;
  isFinal: boolean;
}

export interface StaleShot {
  shotId: string;
  reason: string;
}

export function readGeneratedScripts(db: DatabaseInstance): any[] {
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as
    | { value: string }
    | undefined;
  if (!row) return [];
  try {
    const scripts = JSON.parse(row.value);
    return Array.isArray(scripts) ? scripts : [];
  } catch {
    throw new ShotReviewError(500, 'Stored generated_scripts data is corrupted.', 'GENERATED_SCRIPTS_CORRUPT');
  }
}

export function findProjectShot(db: DatabaseInstance, projectId: string, shotId: string) {
  const project = readGeneratedScripts(db).find(item => String(item.id) === projectId);
  if (!project) {
    throw new ShotReviewError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
  }
  const shot = (project.newShots || []).find((item: any) => String(item.id) === shotId);
  if (!shot) {
    throw new ShotReviewError(404, `Shot '${shotId}' not found in project '${projectId}'.`, 'SHOT_NOT_FOUND');
  }
  return { project, shot };
}

export function listShotVersions(
  db: DatabaseInstance,
  projectId: string,
  shotId: string,
  finalTaskId?: string | null,
): ShotVersion[] {
  const rows = db.prepare(`
    SELECT id, imageUrl, prompt, negativePrompt, seed, model, status, createdAt
    FROM comfyui_tasks
    WHERE projectId = ? AND targetId = ? AND targetType = 'shot' AND viewType = 'main'
    ORDER BY createdAt DESC, rowid DESC
  `).all(projectId, shotId) as any[];

  return rows.map(row => ({
    taskId: String(row.id),
    imageUrl: row.imageUrl ? String(row.imageUrl) : null,
    prompt: String(row.prompt || ''),
    negativePrompt: String(row.negativePrompt || ''),
    seed: String(row.seed ?? ''),
    model: String(row.model || ''),
    status: String(row.status || ''),
    createdAt: String(row.createdAt || ''),
    isFinal: !!finalTaskId && String(row.id) === String(finalTaskId),
  }));
}

export function resolveLocalUploadFile(imageUrl: unknown, uploadsDir: string): string {
  const value = String(imageUrl || '').trim();
  if (!value.startsWith('/uploads/')) {
    throw new ShotReviewError(400, 'Task result image must be a local /uploads/... URL.', 'IMAGE_NOT_LOCAL');
  }

  let relativePath: string;
  try {
    const parsed = new URL(value, 'http://local.invalid');
    if (parsed.origin !== 'http://local.invalid' || !parsed.pathname.startsWith('/uploads/')) throw new Error('invalid');
    relativePath = decodeURIComponent(parsed.pathname.slice('/uploads/'.length));
  } catch {
    throw new ShotReviewError(400, 'Task result image URL is invalid.', 'IMAGE_URL_INVALID');
  }

  if (!relativePath || relativePath.includes('\0')) {
    throw new ShotReviewError(400, 'Task result image path is invalid.', 'IMAGE_PATH_INVALID');
  }

  const root = path.resolve(uploadsDir);
  const candidate = path.resolve(root, relativePath.replace(/[\\/]+/g, path.sep));
  const rootPrefix = `${root}${path.sep}`.toLocaleLowerCase();
  if (!candidate.toLocaleLowerCase().startsWith(rootPrefix)) {
    throw new ShotReviewError(400, 'Task result image resolves outside UPLOADS_DIR.', 'IMAGE_PATH_OUTSIDE_UPLOADS');
  }

  let isFile = false;
  try {
    isFile = fs.statSync(candidate).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw new ShotReviewError(400, `Task result image file does not exist: ${value}`, 'IMAGE_FILE_MISSING');
  }
  return candidate;
}

export function validateFinalTask(
  db: DatabaseInstance,
  projectId: string,
  shotId: string,
  taskId: string,
  uploadsDir: string,
) {
  const task = db.prepare('SELECT * FROM comfyui_tasks WHERE id = ?').get(taskId) as any;
  if (!task) throw new ShotReviewError(400, `Task '${taskId}' does not exist.`, 'TASK_NOT_FOUND');
  if (
    String(task.projectId) !== projectId
    || String(task.targetId) !== shotId
    || String(task.targetType) !== 'shot'
    || String(task.viewType) !== 'main'
  ) {
    throw new ShotReviewError(400, `Task '${taskId}' does not belong to this shot's main image.`, 'TASK_SHOT_MISMATCH');
  }
  if (String(task.status) !== 'succeeded') {
    throw new ShotReviewError(400, `Task '${taskId}' is '${task.status}', not succeeded.`, 'TASK_NOT_SUCCEEDED');
  }
  if (!task.imageUrl) {
    throw new ShotReviewError(400, `Task '${taskId}' has no result image.`, 'TASK_IMAGE_MISSING');
  }
  resolveLocalUploadFile(task.imageUrl, uploadsDir);
  return task;
}

function normalizePrompt(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function removeIdentityPrefix(prompt: string): string {
  if (!prompt.startsWith('IDENTITY PRIORITY:')) return prompt;
  const marker = '. SHOT: ';
  const markerIndex = prompt.indexOf(marker);
  return markerIndex >= 0 ? prompt.slice(markerIndex + marker.length) : prompt;
}

function currentComparablePrompt(shot: any, task: any): string {
  if (String(task.workflowPresetId || '') === '04_qwen_edit_2512_camera_derive' && shot.cameraPromptUsed) {
    return normalizePrompt(shot.cameraPromptUsed);
  }
  return normalizePrompt(shot.optimizedPrompt || shot.description || '');
}

// The schema stores the final task prompt but not a complete structured input fingerprint.
// This is the task brief's documented v1 fallback: compare the latest successful prompt
// snapshot with the shot's current optimizedPrompt (or description), stripping the deterministic
// identity prefix. Camera-derive tasks compare against cameraPromptUsed. Full tracking is P3.
export function findStaleShots(db: DatabaseInstance, project: any): StaleShot[] {
  const rows = db.prepare(`
    SELECT id, targetId, prompt, workflowPresetId, createdAt
    FROM comfyui_tasks
    WHERE projectId = ? AND targetType = 'shot' AND viewType = 'main'
      AND status = 'succeeded' AND imageUrl IS NOT NULL
    ORDER BY createdAt DESC, rowid DESC
  `).all(String(project.id)) as any[];
  const latestByShot = new Map<string, any>();
  for (const row of rows) {
    const shotId = String(row.targetId);
    if (!latestByShot.has(shotId)) latestByShot.set(shotId, row);
  }

  const stale: StaleShot[] = [];
  for (const shot of project.newShots || []) {
    const shotId = String(shot.id || '');
    const task = latestByShot.get(shotId);
    if (!shotId || !task) continue;
    const expected = currentComparablePrompt(shot, task);
    const actual = normalizePrompt(removeIdentityPrefix(String(task.prompt || '')));
    if (expected && actual !== expected) {
      stale.push({
        shotId,
        reason: task.workflowPresetId === '04_qwen_edit_2512_camera_derive'
          ? 'camera_prompt_snapshot_differs'
          : 'prompt_snapshot_differs',
      });
    }
  }
  return stale;
}
