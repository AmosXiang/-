import fs from 'fs';
import { type ImageGenProviderName } from './types.ts';

type RuleCondition = { isMaster?: boolean; hasCharacter?: boolean };
type RoutingRule = { name: string; if: RuleCondition; provider: ImageGenProviderName };
type RoutingConfig = { autoRoute?: boolean; rules: RoutingRule[] };

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
  private config: RoutingConfig | null = null;
  private observedConfigMtimeMs: number | null = null;
  // 自动接管默认关闭:前端仍按 ComfyUI 异步契约(taskId+轮询)编写,启用前必须先完成 UI 适配。
  constructor(
    private readonly configPath: string,
  ) {
    this.refreshConfig();
  }

  get autoRoute(): boolean {
    this.refreshConfig();
    return this.config?.autoRoute === true;
  }

  private validateConfig(config: RoutingConfig): RoutingConfig {
    if (!Array.isArray(config.rules) || !config.rules.length) throw new Error('imageGenRouting.json must contain at least one rule.');
    for (const rule of config.rules) {
      if (!rule.name || !['comfyui_local', 'agnes'].includes(rule.provider)) throw new Error(`Invalid image routing rule '${rule.name || '<unnamed>'}'.`);
    }
    return config;
  }

  private refreshConfig(): void {
    const mtimeMs = fs.statSync(this.configPath).mtimeMs;
    if (this.observedConfigMtimeMs === mtimeMs) return;
    this.observedConfigMtimeMs = mtimeMs;
    try {
      this.config = this.validateConfig(JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as RoutingConfig);
    } catch (error: any) {
      if (!this.config) throw error;
      console.error('[ImageGenRouter]', JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'config_reload_failed',
        config_path: this.configPath,
        error: String(error?.message || error),
        behavior: 'kept_last_valid_config',
      }));
    }
  }

  route(context: ImageRouteContext): ImageRouteDecision {
    this.refreshConfig();
    if (context.forceProvider) {
      if (!['comfyui_local', 'agnes'].includes(context.forceProvider)) throw new Error(`Unsupported forced image provider '${context.forceProvider}'.`);
      return { provider: context.forceProvider, reason: 'forced' };
    }
    if (context.isMaster === undefined && !warnedMissingIsMaster) {
      warnedMissingIsMaster = true;
      console.warn('[ImageGenRouter]', JSON.stringify({ timestamp: new Date().toISOString(), event: 'is_master_unavailable', behavior: 'treated_as_false' }));
    }
    const facts = { isMaster: context.isMaster === true, hasCharacter: context.hasCharacter };
    for (const rule of this.config!.rules) {
      const matches = Object.entries(rule.if || {}).every(([key, expected]) => facts[key as keyof typeof facts] === expected);
      if (matches) return { provider: rule.provider, reason: rule.name };
    }
    throw new Error('No image generation routing rule matched.');
  }
}
