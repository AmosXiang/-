import crypto from 'node:crypto';

export type RecipeParamValue = number | string;

export interface GenRecipe {
  fingerprint: string;
  provider: string;
  model: string;
  workflowPresetId: string | null;
  styleContractVersion: number;
  styleAnchorVersion: number | null;
  params: Record<string, RecipeParamValue>;
}

export interface RecipeFingerprintInput {
  provider: unknown;
  model: unknown;
  workflowPresetId?: unknown;
  styleContractVersion?: unknown;
  styleAnchorVersion?: unknown;
  params?: Record<string, unknown>;
  // Intentionally accepted and ignored. Content, randomness and request timing
  // do not decide the reusable visual recipe and must never create false drift.
  prompt?: unknown;
  seed?: unknown;
  requestId?: unknown;
  timestamp?: unknown;
}

export interface ShotRecipeRecord {
  shotId: string;
  recipe: GenRecipe;
  styleAnchorVersion: number | null;
}

const INTEGER_PARAM_NAMES = new Set(['width', 'height', 'steps']);

function normalizedString(value: unknown, field: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${field} must not be empty.`);
  return normalized;
}

function normalizedVersion(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return number;
}

function normalizedOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) throw new Error('workflowPresetId must not be empty when provided.');
  return normalized;
}

function normalizedOptionalVersion(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 1) {
    throw new Error('styleAnchorVersion must be a positive integer when provided.');
  }
  return number;
}

function normalizedNumber(key: string, value: number): number {
  if (!Number.isFinite(value)) throw new Error(`Recipe param '${key}' must be finite.`);
  const normalized = INTEGER_PARAM_NAMES.has(key)
    ? Math.round(value)
    : Number(value.toFixed(2));
  return Object.is(normalized, -0) ? 0 : normalized;
}

function normalizedParams(value: Record<string, unknown> | undefined): Record<string, RecipeParamValue> {
  const output: Record<string, RecipeParamValue> = {};
  for (const key of Object.keys(value || {}).sort()) {
    const item = value![key];
    // Missing/unavailable strengths are omitted instead of receiving a fake
    // placeholder. Only parameters that actually affect the request are facts.
    if (item === undefined || item === null) continue;
    if (typeof item === 'number') output[key] = normalizedNumber(key, item);
    else if (typeof item === 'string') output[key] = item.trim();
    else throw new Error(`Recipe param '${key}' must be a number or string.`);
  }
  return output;
}

function optionalCanonical(value: unknown, normalized: string | number | null): unknown[] {
  if (value === undefined) return ['missing'];
  if (value === null) return ['null'];
  return ['value', normalized];
}

/**
 * Stable recipe facts, in canonical hash order:
 * provider, model, workflow preset, style-contract version, style-anchor
 * version, then sorted visual parameters. Prompt, seed, request id and time are
 * deliberately excluded: changing content or randomness is not recipe drift.
 */
export function buildRecipeFingerprint(input: RecipeFingerprintInput): GenRecipe {
  const provider = normalizedString(input.provider, 'provider');
  const model = normalizedString(input.model, 'model');
  const workflowPresetId = normalizedOptionalString(input.workflowPresetId);
  const styleContractVersion = input.styleContractVersion === undefined
    ? 0
    : normalizedVersion(input.styleContractVersion, 'styleContractVersion');
  const styleAnchorVersion = normalizedOptionalVersion(input.styleAnchorVersion);
  const params = normalizedParams(input.params);

  // Arrays make the serialized order explicit across processes and JS runtimes.
  // Tagged optional values keep `undefined` (missing) distinct from explicit null.
  const canonical = [
    ['provider', provider],
    ['model', model],
    ['workflowPresetId', optionalCanonical(input.workflowPresetId, workflowPresetId)],
    ['styleContractVersion', optionalCanonical(input.styleContractVersion, styleContractVersion)],
    ['styleAnchorVersion', optionalCanonical(input.styleAnchorVersion, styleAnchorVersion)],
    ['params', Object.entries(params).map(([key, value]) => [key, typeof value, value])],
  ];
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);

  return {
    fingerprint,
    provider,
    model,
    workflowPresetId,
    styleContractVersion,
    styleAnchorVersion,
    params,
  };
}

export function applyShotRecipeRecords(store: any, projectId: string, records: ShotRecipeRecord[]): number {
  const project = Array.isArray(store?.generated_scripts)
    ? store.generated_scripts.find((item: any) => String(item?.id) === String(projectId))
    : null;
  if (!project || !Array.isArray(project.newShots)) return 0;
  const byShotId = new Map(records.map(record => [String(record.shotId), record]));
  let updated = 0;
  for (const shot of project.newShots) {
    const record = byShotId.get(String(shot?.id));
    if (!record) continue;
    shot.gen_recipe = { ...record.recipe, params: { ...record.recipe.params } };
    if (record.styleAnchorVersion === null) delete shot.gen_style_anchor_version;
    else shot.gen_style_anchor_version = record.styleAnchorVersion;
    updated += 1;
  }
  return updated;
}
