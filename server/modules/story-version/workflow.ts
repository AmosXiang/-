import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

type DatabaseInstance = Database.Database;

export interface StoryDraft {
  logline: string;
  beats: Array<{ id: string; title: string; summary: string }>;
  hooks: Array<{ id: string; time: string; label: string }>;
}

export interface StorySnapshot {
  version: number;
  savedAt: string;
  note?: string;
  storyDraft: StoryDraft;
}

export class StoryVersionError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
    this.name = 'StoryVersionError';
  }
}

export function readGeneratedScripts(db: DatabaseInstance): any[] {
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as
    | { value: string }
    | undefined;
  if (!row) return [];
  try {
    const scripts = JSON.parse(row.value);
    if (!Array.isArray(scripts)) throw new Error('not an array');
    return scripts;
  } catch {
    throw new StoryVersionError(500, 'Stored generated_scripts data is corrupted.', 'GENERATED_SCRIPTS_CORRUPT');
  }
}

export function findProject(db: DatabaseInstance, projectId: string): any {
  const project = readGeneratedScripts(db).find(item => String(item.id) === projectId);
  if (!project) {
    throw new StoryVersionError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
  }
  return project;
}

export function deriveStoryDraft(project: any): StoryDraft {
  const narrative = project?.newNarrative || {};
  const climax = String(narrative.climaxDesign || '');
  const times = [...new Set(climax.match(/\b\d{2}:\d{2}\b/g) || [])];
  return {
    logline: String(project?.newTitle || ''),
    beats: [
      { id: 'derived-structure', title: '三幕结构', summary: String(narrative.structure || '') },
      { id: 'derived-rhythm', title: '节奏', summary: String(narrative.rhythm || '') },
      { id: 'derived-climax', title: '高潮设计', summary: climax },
    ],
    hooks: times.map((time, index) => ({
      id: `derived-hook-${index + 1}`,
      time,
      label: `爽点 ${time}`,
    })),
  };
}

function ensureObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoryVersionError(400, `${field} must be an object.`, 'STORY_DRAFT_INVALID');
  }
  return value as Record<string, unknown>;
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new StoryVersionError(400, `${field} must be a string.`, 'STORY_DRAFT_INVALID');
  }
  return value;
}

function normalizeId(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return crypto.randomUUID();
  if (typeof value !== 'string') {
    throw new StoryVersionError(400, `${field} must be a string when provided.`, 'STORY_DRAFT_INVALID');
  }
  return value;
}

export function validateStoryDraft(value: unknown): StoryDraft {
  const draft = ensureObject(value, 'storyDraft');
  if (!Array.isArray(draft.beats) || !Array.isArray(draft.hooks)) {
    throw new StoryVersionError(400, 'storyDraft.beats and storyDraft.hooks must be arrays.', 'STORY_DRAFT_INVALID');
  }
  return {
    logline: ensureString(draft.logline, 'storyDraft.logline'),
    beats: draft.beats.map((raw, index) => {
      const beat = ensureObject(raw, `storyDraft.beats[${index}]`);
      return {
        id: normalizeId(beat.id, `storyDraft.beats[${index}].id`),
        title: ensureString(beat.title, `storyDraft.beats[${index}].title`),
        summary: ensureString(beat.summary, `storyDraft.beats[${index}].summary`),
      };
    }),
    hooks: draft.hooks.map((raw, index) => {
      const hook = ensureObject(raw, `storyDraft.hooks[${index}]`);
      return {
        id: normalizeId(hook.id, `storyDraft.hooks[${index}].id`),
        time: ensureString(hook.time, `storyDraft.hooks[${index}].time`),
        label: ensureString(hook.label, `storyDraft.hooks[${index}].label`),
      };
    }),
  };
}

export function validateNote(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new StoryVersionError(400, 'note must be a string.', 'STORY_NOTE_INVALID');
  }
  if (value.length > 500) {
    throw new StoryVersionError(400, 'note must be 500 characters or fewer.', 'STORY_NOTE_TOO_LONG');
  }
  return value || undefined;
}

export function validateMarkShotsStale(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new StoryVersionError(400, 'markShotsStale must be boolean.', 'MARK_SHOTS_STALE_INVALID');
  }
  return value;
}

export function listStorySnapshots(project: any): StorySnapshot[] {
  return Array.isArray(project?.storyVersions) ? project.storyVersions : [];
}

export function findStorySnapshot(project: any, version: number): StorySnapshot {
  const snapshot = listStorySnapshots(project).find(item => Number(item?.version) === version);
  if (!snapshot) {
    throw new StoryVersionError(404, `Story version v${version} not found.`, 'STORY_VERSION_NOT_FOUND');
  }
  return snapshot;
}

export function parseStoryVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new StoryVersionError(400, 'version must be a positive integer.', 'STORY_VERSION_INVALID');
  }
  return version;
}

export function successfulShotIds(db: DatabaseInstance, projectId: string): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT targetId
    FROM comfyui_tasks
    WHERE projectId = ?
      AND targetType = 'shot'
      AND viewType = 'main'
      AND status = 'succeeded'
      AND imageUrl IS NOT NULL
  `).all(projectId) as Array<{ targetId: unknown }>;
  return new Set(rows.map(row => String(row.targetId)));
}

export function appendStorySnapshot(
  project: any,
  storyDraft: StoryDraft,
  options: { savedAt: string; note?: string; successfulIds?: Set<string> },
): { storyVersion: number; staleMarked: number } {
  const currentVersion = Number.isInteger(project.storyVersion) && project.storyVersion > 0
    ? Number(project.storyVersion)
    : 0;
  const storyVersion = currentVersion + 1;
  const normalizedDraft = structuredClone(storyDraft);
  const snapshot: StorySnapshot = {
    version: storyVersion,
    savedAt: options.savedAt,
    ...(options.note ? { note: options.note } : {}),
    storyDraft: structuredClone(normalizedDraft),
  };
  project.storyDraft = normalizedDraft;
  project.storyVersion = storyVersion;
  project.storyVersions = [...listStorySnapshots(project), snapshot].slice(-10);

  let staleMarked = 0;
  if (options.successfulIds) {
    for (const shot of project.newShots || []) {
      if (options.successfulIds.has(String(shot?.id))) {
        shot.isStale = true;
        staleMarked += 1;
      }
    }
  }
  return { storyVersion, staleMarked };
}
