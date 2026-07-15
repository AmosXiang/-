export interface StyleContractFields {
  storyboardPresetId: string;
  styleOverlay: string;
  width: number;
  height: number;
  loraStrength: number;
}

export interface StoredStyleContract extends StyleContractFields {
  version: number;
  locked: boolean;
  updatedAt: string;
}

export interface EffectiveStyleContract extends StyleContractFields {
  version: number;
  locked: boolean;
}

export type ReadDb = () => any;

export const STYLE_CONTRACT_FIELD_NAMES: Array<keyof StyleContractFields> = [
  'storyboardPresetId',
  'styleOverlay',
  'width',
  'height',
  'loraStrength',
];

export class StyleContractError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StyleContractError';
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function generatedScripts(readDb: ReadDb): any[] {
  const scripts = readDb()?.generated_scripts;
  if (!Array.isArray(scripts)) {
    throw new StyleContractError(500, 'Stored generated_scripts data is corrupted.', 'GENERATED_SCRIPTS_CORRUPT');
  }
  return scripts;
}

export function findStyleContractProject(readDb: ReadDb, projectId: string): any {
  const project = generatedScripts(readDb).find(item => String(item?.id) === projectId);
  if (!project) {
    throw new StyleContractError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
  }
  return project;
}

export function findStyleContractProjectInStore(store: any, projectId: string): any {
  const scripts = store?.generated_scripts;
  if (!Array.isArray(scripts)) {
    throw new StyleContractError(500, 'Stored generated_scripts data is corrupted.', 'GENERATED_SCRIPTS_CORRUPT');
  }
  const project = scripts.find((item: any) => String(item?.id) === projectId);
  if (!project) {
    throw new StyleContractError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
  }
  return project;
}

export function isStyleContractInitialized(project: any): project is { styleContract: StoredStyleContract } {
  const contract = project?.styleContract;
  return isObject(contract) && Number.isInteger(contract.version) && contract.version >= 1;
}

export function deriveStyleContract(project: any): StyleContractFields {
  return {
    storyboardPresetId: typeof project?.comfyuiPreferences?.shotPresetId === 'string'
      ? project.comfyuiPreferences.shotPresetId
      : '',
    styleOverlay: typeof project?.artDirection?.overlay === 'string'
      ? project.artDirection.overlay
      : '',
    width: 1024,
    height: 1024,
    loraStrength: 1,
  };
}

export function storedStyleContractFields(contract: any): StyleContractFields {
  return {
    storyboardPresetId: contract.storyboardPresetId,
    styleOverlay: contract.styleOverlay,
    width: contract.width,
    height: contract.height,
    loraStrength: contract.loraStrength,
  };
}

function invalidField(field: keyof StyleContractFields, message: string, status = 422): never {
  throw new StyleContractError(status, message, 'STYLE_CONTRACT_INVALID', { field });
}

export function validateStyleContract(value: unknown): StyleContractFields {
  if (!isObject(value)) {
    throw new StyleContractError(400, 'contract must be an object.', 'STYLE_CONTRACT_REQUIRED');
  }

  if (typeof value.storyboardPresetId !== 'string') {
    invalidField('storyboardPresetId', 'storyboardPresetId must be a string.', 400);
  }
  const storyboardPresetId = value.storyboardPresetId.trim();
  if (!storyboardPresetId) {
    invalidField('storyboardPresetId', 'storyboardPresetId must not be empty.');
  }
  if (typeof value.styleOverlay !== 'string') {
    invalidField('styleOverlay', 'styleOverlay must be a string.', 400);
  }

  for (const field of ['width', 'height'] as const) {
    const dimension = value[field];
    if (typeof dimension !== 'number' || !Number.isFinite(dimension) || !Number.isInteger(dimension)) {
      invalidField(field, `${field} must be a finite integer.`, 400);
    }
    if (dimension < 256 || dimension > 2048 || dimension % 8 !== 0) {
      invalidField(field, `${field} must be between 256 and 2048 and divisible by 8.`);
    }
  }

  if (typeof value.loraStrength !== 'number' || !Number.isFinite(value.loraStrength)) {
    invalidField('loraStrength', 'loraStrength must be a finite number.', 400);
  }
  if (value.loraStrength < 0 || value.loraStrength > 2) {
    invalidField('loraStrength', 'loraStrength must be between 0 and 2.');
  }

  return {
    storyboardPresetId,
    styleOverlay: value.styleOverlay,
    width: value.width,
    height: value.height,
    loraStrength: value.loraStrength,
  };
}

export function missingStyleContractFields(value: unknown): string[] {
  if (!isObject(value)) return [...STYLE_CONTRACT_FIELD_NAMES];
  const missing: string[] = [];
  if (typeof value.storyboardPresetId !== 'string' || !value.storyboardPresetId.trim()) missing.push('storyboardPresetId');
  if (typeof value.styleOverlay !== 'string') missing.push('styleOverlay');
  for (const field of ['width', 'height'] as const) {
    const dimension = value[field];
    if (
      typeof dimension !== 'number'
      || !Number.isFinite(dimension)
      || !Number.isInteger(dimension)
      || dimension < 256
      || dimension > 2048
      || dimension % 8 !== 0
    ) missing.push(field);
  }
  if (
    typeof value.loraStrength !== 'number'
    || !Number.isFinite(value.loraStrength)
    || value.loraStrength < 0
    || value.loraStrength > 2
  ) missing.push('loraStrength');
  return missing;
}

export function styleContractFieldsEqual(left: StyleContractFields, right: StyleContractFields): boolean {
  return STYLE_CONTRACT_FIELD_NAMES.every(field => left[field] === right[field]);
}

export function resolveEffectiveStyleContract(readDb: ReadDb, projectId: string): EffectiveStyleContract {
  const project = findStyleContractProject(readDb, String(projectId));
  if (!isStyleContractInitialized(project)) {
    return { version: 0, locked: false, ...deriveStyleContract(project) };
  }

  const fallback = deriveStyleContract(project);
  const contract = project.styleContract;
  return {
    version: Number(contract.version),
    locked: contract.locked === true,
    storyboardPresetId: typeof contract.storyboardPresetId === 'string' && contract.storyboardPresetId.trim()
      ? contract.storyboardPresetId.trim()
      : fallback.storyboardPresetId,
    styleOverlay: typeof contract.styleOverlay === 'string' ? contract.styleOverlay : fallback.styleOverlay,
    width: typeof contract.width === 'number' && Number.isFinite(contract.width) ? contract.width : fallback.width,
    height: typeof contract.height === 'number' && Number.isFinite(contract.height) ? contract.height : fallback.height,
    loraStrength: typeof contract.loraStrength === 'number' && Number.isFinite(contract.loraStrength)
      ? contract.loraStrength
      : fallback.loraStrength,
  };
}
