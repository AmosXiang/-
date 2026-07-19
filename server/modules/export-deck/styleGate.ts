import sharp from 'sharp';

const COLOR_HISTOGRAM_BINS = 4;
export const COLOR_OUTLIER_THRESHOLD = 0.55;

export interface StyleGateDetail {
  shotId: string;
  index: number;
  fingerprint: string | null;
  contractCurrent: boolean;
  anchorCurrent: boolean;
  recipeMatches: boolean | null;
  imageDecodable: boolean;
  styleApprovedValid: boolean;
  colorOutlier: boolean | null;
  needsAttention: boolean;
  reasons: string[];
  warnings: string[];
}

export interface StyleGateSummary {
  total: number;
  contractStale: number;
  anchorStale: number;
  recipeDrift: number;
  undecodable: number;
  unapproved: number;
  colorOutliers: number;
  needsAttention: number;
  approvedRecipeMissing: boolean;
  approvedRecipe: {
    fingerprint: string;
    setFromShotId: string;
    setAt: string;
  } | null;
  details: StyleGateDetail[];
}

type ImageInspection = {
  decodable: boolean;
  histogram: number[] | null;
};

function fingerprintOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const fingerprint = (value as any).fingerprint;
  return typeof fingerprint === 'string' && fingerprint.trim() ? fingerprint.trim() : null;
}

async function inspectImage(localPath: string | null): Promise<ImageInspection> {
  if (!localPath) return { decodable: false, histogram: null };
  try {
    const metadata = await sharp(localPath).metadata();
    if (!metadata.width || !metadata.height || metadata.width <= 0 || metadata.height <= 0) {
      return { decodable: false, histogram: null };
    }
    const { data, info } = await sharp(localPath)
      .rotate()
      .resize(32, 32, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const histogram = Array(COLOR_HISTOGRAM_BINS ** 3).fill(0) as number[];
    const channels = Math.max(1, info.channels);
    const pixels = Math.max(1, info.width * info.height);
    for (let offset = 0; offset < data.length; offset += channels) {
      const red = data[offset];
      const green = channels >= 3 ? data[offset + 1] : red;
      const blue = channels >= 3 ? data[offset + 2] : red;
      const redBin = Math.min(COLOR_HISTOGRAM_BINS - 1, Math.floor(red * COLOR_HISTOGRAM_BINS / 256));
      const greenBin = Math.min(COLOR_HISTOGRAM_BINS - 1, Math.floor(green * COLOR_HISTOGRAM_BINS / 256));
      const blueBin = Math.min(COLOR_HISTOGRAM_BINS - 1, Math.floor(blue * COLOR_HISTOGRAM_BINS / 256));
      histogram[(redBin * COLOR_HISTOGRAM_BINS + greenBin) * COLOR_HISTOGRAM_BINS + blueBin] += 1 / pixels;
    }
    return { decodable: true, histogram };
  } catch {
    return { decodable: false, histogram: null };
  }
}

function histogramDistance(left: number[], right: number[]): number {
  let distance = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    distance += Math.abs(left[index] - right[index]);
  }
  return distance / 2;
}

export async function buildStyleGate(
  script: any,
  shots: any[],
  localImagePaths: Array<string | null>,
): Promise<StyleGateSummary> {
  const contractVersion = Number.isInteger(script?.styleContract?.version)
    ? Number(script.styleContract.version)
    : 0;
  const anchorVersion = Number.isInteger(script?.styleAnchor?.version)
    ? Number(script.styleAnchor.version)
    : null;
  const approvedFingerprint = fingerprintOf(script?.approvedRecipe);
  const approvedShotId = approvedFingerprint && script?.approvedRecipe?.setFromShotId !== undefined
    ? String(script.approvedRecipe.setFromShotId)
    : null;
  const approvedRecipe = approvedFingerprint && approvedShotId
    ? {
        fingerprint: approvedFingerprint,
        setFromShotId: approvedShotId,
        setAt: String(script.approvedRecipe.setAt || ''),
      }
    : null;

  const inspections = await Promise.all(localImagePaths.map(localPath => inspectImage(localPath)));
  const approvedIndex = approvedShotId === null
    ? -1
    : shots.findIndex(shot => String(shot?.id) === approvedShotId);
  const approvedHistogram = approvedIndex >= 0 ? inspections[approvedIndex]?.histogram || null : null;

  let contractStale = 0;
  let anchorStale = 0;
  let recipeDrift = 0;
  let undecodable = 0;
  let unapproved = 0;
  let colorOutliers = 0;
  let needsAttention = 0;

  const details = shots.map((shot, index): StyleGateDetail => {
    const fingerprint = fingerprintOf(shot?.gen_recipe);
    const contractCurrent = Number.isInteger(shot?.gen_style_contract_version)
      && Number(shot.gen_style_contract_version) === contractVersion;
    const anchorCurrent = anchorVersion === null
      ? true
      : Number.isInteger(shot?.gen_style_anchor_version)
        && Number(shot.gen_style_anchor_version) === anchorVersion;
    const recipeMatches = approvedFingerprint === null ? null : fingerprint === approvedFingerprint;
    const imageDecodable = inspections[index]?.decodable === true;
    const styleApprovedValid = Boolean(
      fingerprint
      && typeof shot?.styleApproved?.approvedFingerprint === 'string'
      && shot.styleApproved.approvedFingerprint === fingerprint,
    );
    const histogram = inspections[index]?.histogram || null;
    const colorOutlier = approvedHistogram && histogram
      ? histogramDistance(approvedHistogram, histogram) > COLOR_OUTLIER_THRESHOLD
      : null;
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (!contractCurrent) {
      contractStale += 1;
      reasons.push('contract_stale');
    }
    if (!anchorCurrent) {
      anchorStale += 1;
      reasons.push('anchor_stale');
    }
    if (recipeMatches === false) {
      recipeDrift += 1;
      reasons.push('recipe_drift');
    }
    if (!imageDecodable) {
      undecodable += 1;
      reasons.push('image_undecodable');
    }
    if (!styleApprovedValid) {
      unapproved += 1;
      reasons.push('style_unapproved');
    }
    if (colorOutlier === true) {
      colorOutliers += 1;
      warnings.push('color_outlier');
    }
    const detailNeedsAttention = reasons.length > 0;
    if (detailNeedsAttention) needsAttention += 1;
    return {
      shotId: String(shot?.id),
      index,
      fingerprint,
      contractCurrent,
      anchorCurrent,
      recipeMatches,
      imageDecodable,
      styleApprovedValid,
      colorOutlier,
      needsAttention: detailNeedsAttention,
      reasons,
      warnings,
    };
  });

  return {
    total: shots.length,
    contractStale,
    anchorStale,
    recipeDrift,
    undecodable,
    unapproved,
    colorOutliers,
    needsAttention,
    approvedRecipeMissing: approvedRecipe === null,
    approvedRecipe,
    details,
  };
}
