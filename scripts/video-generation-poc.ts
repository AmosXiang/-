import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'node:path';
import { generateSingleShotVideo, VideoGenerationError } from '../video-generation.ts';

const root = path.resolve(import.meta.dirname, '..');
const projectId = process.env.VIDEO_POC_PROJECT_ID || '1782930008056';
const shotIndex = Math.max(0, Number(process.env.VIDEO_POC_SHOT_INDEX) || 2);
const db = new Database(path.join(root, 'db.sqlite'), { readonly: true });
try {
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value?: string } | undefined;
  const scripts = JSON.parse(row?.value || '[]');
  const project = scripts.find((item: any) => String(item.id) === projectId);
  const shot = project?.newShots?.[shotIndex];
  if (!project || !shot) throw new Error(`POC shot not found: project=${projectId}, shotIndex=${shotIndex}`);
  const shotImageUrl = String(shot.generatedImageUrl || shot.imageUrl || '');
  const matchedIds = new Set([...(shot.matchedCharacterIds || []), ...(shot.characterIds || [])].map(String));
  const characters = (project.newCharacters || []).filter((character: any) => (character.avatarImageUrl || character.avatarUrl) && (!matchedIds.size || matchedIds.has(String(character.id)))).slice(0, 2);
  if (!shotImageUrl || !characters.length) throw new Error('Selected shot must have a storyboard image and at least one character reference image.');
  const localPath = (url: string) => path.join(root, url.split('?')[0].replace(/^\/+/, ''));
  const outputPath = path.join(root, 'uploads', 'video-poc', `${projectId}-shot-${String(shotIndex + 1).padStart(2, '0')}-${Date.now()}.mp4`);
  const result = await generateSingleShotVideo({
    prompt: String(shot.optimizedPrompt || shot.description || shot.content || '').trim(),
    references: [{ path: localPath(shotImageUrl), role: 'storyboard' }, ...characters.map((character: any) => ({ path: localPath(String(character.avatarImageUrl || character.avatarUrl)), role: 'character' as const }))],
    outputPath,
  });
  console.log(JSON.stringify({ success: true, projectId, shotIndex, shotId: shot.id || null, characterIds: characters.map((item: any) => item.id), ...result }, null, 2));
} catch (error) {
  const failure = error instanceof VideoGenerationError ? { code: error.code, message: error.message, retryable: error.retryable } : { code: 'POC_INPUT_ERROR', message: error instanceof Error ? error.message : String(error), retryable: false };
  console.error(JSON.stringify({ success: false, error: failure }, null, 2));
  process.exitCode = 1;
} finally {
  db.close();
}
