export interface ImageStyleContext {
  contractVersion: number;
  styleOverlay: string;
  sceneId: string | null;
  sceneOverlay: string;
  width: number;
  height: number;
  presetId: string | null;
  loraStrength: number | null;
}

export type StyleBundle = ImageStyleContext;

export interface StyleBundleInjection {
  style: boolean;
  scene: boolean;
}

export interface StyleBundleSummary {
  contractVersion: number;
  sceneId: string | null;
  styleOverlayLen: number;
  sceneOverlayLen: number;
  width: number;
  height: number;
  presetId: string | null;
  loraStrength: number | null;
  injected: StyleBundleInjection;
}

const PROJECT_STYLE_PREFIX = 'Project art direction style overlay (style only; preserve shot content and composition):';
const SCENE_STYLE_PREFIX = 'Scene reference (environment only; preserve shot content, composition and characters):';

export function buildStyleBundle(context: ImageStyleContext): StyleBundle {
  return {
    contractVersion: context.contractVersion,
    styleOverlay: String(context.styleOverlay || '').trim(),
    sceneId: context.sceneId === null ? null : String(context.sceneId),
    sceneOverlay: String(context.sceneOverlay || '').trim(),
    width: context.width,
    height: context.height,
    presetId: context.presetId === null ? null : String(context.presetId),
    loraStrength: context.loraStrength,
  };
}

export function composeAgnesPrompt(
  optimizedPrompt: string,
  bundle: StyleBundle | null,
): { prompt: string; injected: StyleBundleInjection } {
  let prompt = optimizedPrompt;
  const injected: StyleBundleInjection = { style: false, scene: false };
  if (!bundle) return { prompt, injected };

  if (bundle.styleOverlay && !prompt.includes(bundle.styleOverlay)) {
    prompt = [
      prompt,
      `${PROJECT_STYLE_PREFIX} ${bundle.styleOverlay}`,
    ].filter(Boolean).join('\n\n');
    injected.style = true;
  }

  if (bundle.sceneOverlay && !prompt.includes(bundle.sceneOverlay)) {
    prompt = [
      prompt,
      `${SCENE_STYLE_PREFIX} ${bundle.sceneOverlay}`,
    ].filter(Boolean).join('\n\n');
    injected.scene = true;
  }

  return { prompt, injected };
}

export function summarizeStyleBundle(
  bundle: StyleBundle,
  injected: StyleBundleInjection,
  width = bundle.width,
  height = bundle.height,
): StyleBundleSummary {
  return {
    contractVersion: bundle.contractVersion,
    sceneId: bundle.sceneId,
    styleOverlayLen: bundle.styleOverlay.length,
    sceneOverlayLen: bundle.sceneOverlay.length,
    width,
    height,
    presetId: bundle.presetId,
    loraStrength: bundle.loraStrength,
    injected: { ...injected },
  };
}

export function appendStyleBundleSummary(rawMeta: unknown, summary: StyleBundleSummary | null): unknown {
  if (!summary) return rawMeta;
  if (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
    return { ...(rawMeta as Record<string, unknown>), styleBundle: summary };
  }
  return { providerRawMeta: rawMeta ?? null, styleBundle: summary };
}
