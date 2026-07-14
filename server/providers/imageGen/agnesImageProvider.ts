import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { AgnesClient } from '../agnesClient.ts';
import { type ImageGenProvider, type ImageGenRequest, type ImageGenResult, validateImageGenRequest } from './types.ts';

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function imageUrl(raw: unknown): string {
  const payload = record(raw);
  const candidate = payload.data?.[0]?.url
    || payload.images?.[0]?.url
    || payload.output?.url
    || payload.output?.[0]?.url
    || payload.url;
  if (!candidate || typeof candidate !== 'string') throw new Error('Agnes image response did not include a recognized image URL.');
  return candidate;
}

async function referenceDataUrl(localPath: string): Promise<string> {
  const absolute = path.resolve(localPath);
  const bytes = await fs.promises.readFile(absolute);
  const metadata = await sharp(bytes).metadata();
  const mime = metadata.format === 'jpeg' ? 'image/jpeg'
    : metadata.format === 'webp' ? 'image/webp'
      : metadata.format === 'gif' ? 'image/gif'
        : 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export class AgnesImageProvider implements ImageGenProvider {
  readonly name = 'agnes' as const;

  constructor(
    private readonly client: AgnesClient,
    private readonly uploadsDir: string,
  ) {}

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    validateImageGenRequest(req);
    const referenceDataUrls = await Promise.all((req.referenceImages || []).map(referenceDataUrl));
    const model = referenceDataUrls.length ? 'agnes-image-2.0-flash' : 'agnes-image-2.1-flash';
    const created = await this.client.generateImage({
      model,
      prompt: req.prompt,
      width: req.width,
      height: req.height,
      seed: req.seed,
      referenceDataUrls,
    });
    const remoteUrl = imageUrl(created.raw);
    const startedAt = Date.now();
    console.log('[AgnesImageProvider]', JSON.stringify({ timestamp: new Date().toISOString(), event: 'download_request', request_id: created.requestId, url: remoteUrl }));
    const downloadController = new AbortController();
    const downloadTimeout = setTimeout(() => downloadController.abort(), 120_000);
    let bytes: Buffer;
    try {
      const response = await fetch(remoteUrl, { signal: downloadController.signal });
      console.log('[AgnesImageProvider]', JSON.stringify({ timestamp: new Date().toISOString(), event: 'download_response', request_id: created.requestId, status_code: response.status, duration_ms: Date.now() - startedAt, content_type: response.headers.get('content-type'), content_length: response.headers.get('content-length') }));
      if (!response.ok) throw new Error(`Agnes image download failed with HTTP ${response.status}.`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error('Agnes image download timed out after 120000ms.');
      throw error;
    } finally {
      clearTimeout(downloadTimeout);
    }
    if (!bytes.length) throw new Error('Agnes image download returned an empty file.');
    await sharp(bytes).metadata();

    const safeRequestId = created.requestId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
    const relativePath = path.join('images', 'agnes', `shot-${req.shotId}-${safeRequestId}.png`);
    const finalPath = path.join(this.uploadsDir, relativePath);
    const temporaryPath = `${finalPath}.part`;
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await sharp(bytes).png().toFile(temporaryPath);
    await sharp(temporaryPath).metadata();
    const stat = await fs.promises.stat(temporaryPath);
    if (!stat.size) throw new Error('Decoded Agnes image is empty.');
    await fs.promises.rename(temporaryPath, finalPath);
    console.log('[AgnesImageProvider]', JSON.stringify({ timestamp: new Date().toISOString(), event: 'image_saved', request_id: created.requestId, image_path: finalPath, bytes: stat.size, duration_ms: Date.now() - startedAt }));

    return {
      provider: 'agnes',
      requestId: created.requestId,
      imagePath: `/uploads/${relativePath.replace(/\\/g, '/')}`,
      seedUsed: undefined,
      rawMeta: { response: created.raw, remote_url: remoteUrl, seed_requested: req.seed ?? null, seed_forwarded: false },
    };
  }
}
