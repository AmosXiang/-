export type ImageGenProviderName = 'comfyui_local' | 'agnes';

export interface ImageGenRequest {
  shotId: number;
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  referenceImages?: string[];
}

export interface ImageGenResult {
  provider: ImageGenProviderName;
  requestId: string;
  imagePath: string;
  seedUsed?: number;
  rawMeta: unknown;
}

export interface ImageGenProvider {
  readonly name: ImageGenProviderName;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

export function validateImageGenRequest(req: ImageGenRequest): void {
  if (!Number.isInteger(req.shotId) || req.shotId < 0) throw new Error('shotId must be a non-negative integer.');
  if (!String(req.prompt || '').trim()) throw new Error('prompt is required.');
  if (!Number.isInteger(req.width) || !Number.isInteger(req.height) || req.width <= 0 || req.height <= 0) {
    throw new Error('width and height must be positive integers.');
  }
  if (req.width % 16 !== 0 || req.height % 16 !== 0) {
    throw new Error('width and height must be multiples of 16（必须为 16 的倍数）.');
  }
  if (req.seed !== undefined && !Number.isSafeInteger(req.seed)) throw new Error('seed must be a safe integer.');
}
