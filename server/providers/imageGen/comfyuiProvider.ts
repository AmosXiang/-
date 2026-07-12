import { type ImageGenProvider, type ImageGenRequest, type ImageGenResult, validateImageGenRequest } from './types.ts';

export type ExistingComfyImageGenerator = (req: ImageGenRequest) => Promise<ImageGenResult>;

export class ComfyUIProvider implements ImageGenProvider {
  readonly name = 'comfyui_local' as const;

  constructor(private readonly existingGenerator: ExistingComfyImageGenerator) {}

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    validateImageGenRequest(req);
    // Thin delegation only: ComfyUI submission, polling, PuLID injection and
    // output handling stay owned by the existing generator.
    const result = await this.existingGenerator(req);
    if (result.provider !== this.name) throw new Error(`ComfyUI adapter returned unexpected provider '${result.provider}'.`);
    return result;
  }
}
