import fs from 'fs';
import { type ImageGenProviderName } from './types.ts';

type RuleCondition = { isMaster?: boolean; hasCharacter?: boolean };
type RoutingRule = { name: string; if: RuleCondition; provider: ImageGenProviderName };
type RoutingConfig = { rules: RoutingRule[] };

export interface ImageRouteContext {
  isMaster?: boolean;
  hasCharacter: boolean;
  forceProvider?: ImageGenProviderName;
}

export interface ImageRouteDecision {
  provider: ImageGenProviderName;
  reason: string;
}

let warnedMissingIsMaster = false;

export class ImageGenRouter {
  private readonly config: RoutingConfig;

  constructor(
    configPath: string,
  ) {
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RoutingConfig;
    if (!Array.isArray(this.config.rules) || !this.config.rules.length) throw new Error('imageGenRouting.json must contain at least one rule.');
    for (const rule of this.config.rules) {
      if (!rule.name || !['comfyui_local', 'agnes'].includes(rule.provider)) throw new Error(`Invalid image routing rule '${rule.name || '<unnamed>'}'.`);
    }
  }

  route(context: ImageRouteContext): ImageRouteDecision {
    if (context.forceProvider) {
      if (!['comfyui_local', 'agnes'].includes(context.forceProvider)) throw new Error(`Unsupported forced image provider '${context.forceProvider}'.`);
      return { provider: context.forceProvider, reason: 'forced' };
    }
    if (context.isMaster === undefined && !warnedMissingIsMaster) {
      warnedMissingIsMaster = true;
      console.warn('[ImageGenRouter]', JSON.stringify({ timestamp: new Date().toISOString(), event: 'is_master_unavailable', behavior: 'treated_as_false' }));
    }
    const facts = { isMaster: context.isMaster === true, hasCharacter: context.hasCharacter };
    for (const rule of this.config.rules) {
      const matches = Object.entries(rule.if || {}).every(([key, expected]) => facts[key as keyof typeof facts] === expected);
      if (matches) return { provider: rule.provider, reason: rule.name };
    }
    throw new Error('No image generation routing rule matched.');
  }
}
