import { GoogleGenAI, VideoGenerationReferenceType, type Image } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';

export type VideoGenerationErrorCode = 'INVALID_API_KEY' | 'NETWORK_TIMEOUT' | 'CONTENT_MODERATION_REJECTED' | 'INVALID_PARAMETERS' | 'UPSTREAM_ERROR';

export class VideoGenerationError extends Error {
  constructor(public readonly code: VideoGenerationErrorCode, message: string, public readonly retryable: boolean, public readonly cause?: unknown) {
    super(message);
    this.name = 'VideoGenerationError';
  }
}

export type VideoReferenceInput = { path: string; role: 'storyboard' | 'character' };
export type GenerateSingleShotVideoInput = { prompt: string; references: VideoReferenceInput[]; outputPath: string; model?: string; timeoutMs?: number; pollIntervalMs?: number };
export type GenerateSingleShotVideoResult = { outputPath: string; model: string; durationMs: number; fileSizeBytes: number; operationName: string | null; referenceCount: number };

function imageMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  throw new VideoGenerationError('INVALID_PARAMETERS', `Unsupported reference image type: ${extension || '(none)'}`, false);
}

function referenceImage(reference: VideoReferenceInput): Image {
  if (!fs.existsSync(reference.path)) throw new VideoGenerationError('INVALID_PARAMETERS', `Reference image not found: ${reference.path}`, false);
  const bytes = fs.readFileSync(reference.path);
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new VideoGenerationError('INVALID_PARAMETERS', `Reference image must be between 1 byte and 20 MB: ${reference.path}`, false);
  return { imageBytes: bytes.toString('base64'), mimeType: imageMimeType(reference.path) };
}

export function classifyVideoGenerationError(error: unknown): VideoGenerationError {
  if (error instanceof VideoGenerationError) return error;
  const source = error as any;
  const status = Number(source?.status || source?.statusCode || source?.response?.status || 0);
  const message = String(source?.message || source?.error?.message || error || 'Unknown video generation error');
  const normalized = message.toLowerCase();
  if (status === 401 || status === 403 || /api key|unauthenticated|permission_denied|invalid credential/.test(normalized)) return new VideoGenerationError('INVALID_API_KEY', 'Video API Key is invalid or does not have access to the selected model.', false, error);
  if (/timeout|timed out|abort|econnreset|etimedout|enotfound|fetch failed|network/.test(normalized)) return new VideoGenerationError('NETWORK_TIMEOUT', 'Video generation request timed out or the network connection failed.', true, error);
  if (/rai|safety|moderation|content policy|blocked|filtered/.test(normalized)) return new VideoGenerationError('CONTENT_MODERATION_REJECTED', 'Video generation was rejected by content moderation.', false, error);
  if (status === 400 || status === 422 || /invalid argument|invalid parameter|bad request/.test(normalized)) return new VideoGenerationError('INVALID_PARAMETERS', `Video generation parameters were rejected: ${message}`, false, error);
  return new VideoGenerationError('UPSTREAM_ERROR', `Video generation service failed: ${message}`, status >= 500 || status === 429, error);
}

export async function generateSingleShotVideo(input: GenerateSingleShotVideoInput): Promise<GenerateSingleShotVideoResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new VideoGenerationError('INVALID_API_KEY', 'GEMINI_API_KEY is not configured.', false);
  const prompt = input.prompt.trim();
  if (!prompt) throw new VideoGenerationError('INVALID_PARAMETERS', 'A video prompt is required.', false);
  if (input.references.length < 2 || input.references.length > 3 || !input.references.some(item => item.role === 'storyboard') || !input.references.some(item => item.role === 'character')) throw new VideoGenerationError('INVALID_PARAMETERS', 'Provide one storyboard image and one or two character reference images.', false);

  const model = input.model || process.env.VIDEO_GENERATION_MODEL?.trim() || 'veo-3.1-fast-generate-preview';
  const timeoutMs = input.timeoutMs || Number(process.env.VIDEO_GENERATION_TIMEOUT_MS) || 15 * 60_000;
  const pollIntervalMs = input.pollIntervalMs || 10_000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const ai = new GoogleGenAI({ apiKey });
  try {
    let operation = await ai.models.generateVideos({
      model,
      prompt,
      config: { numberOfVideos: 1, durationSeconds: 8, resolution: '720p', aspectRatio: '16:9', referenceImages: input.references.map(item => ({ image: referenceImage(item), referenceType: VideoGenerationReferenceType.ASSET })) },
    });
    const operationName = operation.name || null;
    while (!operation.done) {
      if (Date.now() >= deadline) throw new VideoGenerationError('NETWORK_TIMEOUT', `Video generation exceeded ${timeoutMs} ms.`, true);
      await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
      operation = await ai.operations.getVideosOperation({ operation });
    }
    if (operation.error) throw new Error(JSON.stringify(operation.error));
    const response = operation.response;
    if (response?.raiMediaFilteredCount || response?.raiMediaFilteredReasons?.length) throw new VideoGenerationError('CONTENT_MODERATION_REJECTED', `Video generation was rejected by content moderation: ${(response.raiMediaFilteredReasons || []).join('; ')}`, false);
    const video = response?.generatedVideos?.[0]?.video;
    if (!video) throw new VideoGenerationError('UPSTREAM_ERROR', 'Video API completed without a video result.', false);
    fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
    if (video.videoBytes) fs.writeFileSync(input.outputPath, Buffer.from(video.videoBytes, 'base64'));
    else if (video.uri) {
      const download = await fetch(video.uri, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      if (!download.ok) throw Object.assign(new Error(`Video download failed with HTTP ${download.status}`), { status: download.status });
      fs.writeFileSync(input.outputPath, Buffer.from(await download.arrayBuffer()));
    } else throw new VideoGenerationError('UPSTREAM_ERROR', 'Video API returned neither bytes nor a download URI.', false);
    const fileSizeBytes = fs.statSync(input.outputPath).size;
    if (!fileSizeBytes) throw new VideoGenerationError('UPSTREAM_ERROR', 'Downloaded video file is empty.', false);
    return { outputPath: input.outputPath, model, durationMs: Date.now() - startedAt, fileSizeBytes, operationName, referenceCount: input.references.length };
  } catch (error) {
    throw classifyVideoGenerationError(error);
  }
}
