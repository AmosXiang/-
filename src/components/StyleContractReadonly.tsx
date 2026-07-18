import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api';

interface StyleContractFields {
  storyboardPresetId: string;
  styleOverlay: string;
  width: number;
  height: number;
  loraStrength: number;
}

interface PresetInfo {
  presetId: string;
  displayName?: string;
  modelName?: string;
  sampler?: string;
  steps?: number;
  cfg?: number;
  defaultParameters?: { sampler?: string; steps?: number; cfg?: number };
}

interface GenRecipe {
  fingerprint: string;
  provider: string;
  model: string;
  workflowPresetId: string | null;
  styleContractVersion: number;
  styleAnchorVersion: number | null;
  params: Record<string, number | string>;
}

function errorMessage(data: any, status: number): string {
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.error?.message === 'string') return data.error.message;
  return `请求失败 (HTTP ${status})`;
}

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(data, response.status));
  return data;
}

function presetValue(value: unknown): string {
  return value === undefined || value === null || value === '' ? '由预设决定' : String(value);
}

export default function StyleContractReadonly({
  projectId,
  recipe,
  generatedContractVersion,
  generatedAnchorVersion,
}: {
  projectId: string;
  recipe?: GenRecipe;
  generatedContractVersion?: number;
  generatedAnchorVersion?: number;
}) {
  const [contract, setContract] = useState<StyleContractFields | null>(null);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [version, setVersion] = useState(0);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [presetWarning, setPresetWarning] = useState('');
  const [anchorVersion, setAnchorVersion] = useState<number | null>(null);

  const endpoint = `/api/generated-scripts/${encodeURIComponent(projectId)}/style-contract`;
  const selectedPreset = useMemo(
    () => presets.find(preset => preset.presetId === contract?.storyboardPresetId),
    [contract?.storyboardPresetId, presets],
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    setPresetWarning('');
    try {
      const [contractData, anchorData] = await Promise.all([
        readJson(await apiFetch(endpoint, { signal })),
        readJson(await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/style-anchor`, { signal })),
      ]);
      setContract(contractData.contract as StyleContractFields);
      setInitialized(Boolean(contractData.initialized));
      setVersion(Number(contractData.version || 0));
      setLocked(Boolean(contractData.locked));
      const nextAnchorVersion = Number(anchorData.styleAnchor?.version);
      setAnchorVersion(Number.isInteger(nextAnchorVersion) && nextAnchorVersion >= 1 ? nextAnchorVersion : null);
      try {
        const presetData = await readJson(await apiFetch('/api/comfyui/presets?purpose=storyboard', { signal }));
        setPresets(Array.isArray(presetData.presets) ? presetData.presets : []);
      } catch (presetError) {
        if ((presetError as Error).name !== 'AbortError') setPresetWarning((presetError as Error).message);
      }
    } catch (loadError) {
      if ((loadError as Error).name !== 'AbortError') setError((loadError as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [endpoint, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) {
    return <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400" role="status">正在读取项目风格契约…</div>;
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-900/70 bg-red-950/25 p-4 text-xs text-red-200" role="alert">
        <p>{error}</p>
        <button type="button" onClick={() => void load()} className="mt-3 min-h-10 rounded-lg border border-red-700 px-4 py-2 hover:bg-red-900/30">重试</button>
      </div>
    );
  }
  const recipeContractVersion = generatedContractVersion ?? recipe?.styleContractVersion;
  const recipeAnchorVersion = generatedAnchorVersion ?? recipe?.styleAnchorVersion ?? null;
  const contractCurrent = recipeContractVersion !== undefined && recipeContractVersion === version;
  const anchorCurrent = anchorVersion === null ? recipeAnchorVersion === null : recipeAnchorVersion === anchorVersion;
  const badge = (matches: boolean, current: number | null, generated: number | null | undefined, label: string) => (
    <span className={`rounded-lg border px-2 py-1 text-[10px] font-semibold ${matches ? 'border-emerald-800 bg-emerald-950/30 text-emerald-300' : 'border-amber-800 bg-amber-950/30 text-amber-300'}`}>
      {label} {matches ? `匹配${current === null ? '（未设置）' : ` v${current}`}` : `落后当前${current === null ? '（已清除）' : ` v${current}`} · 生成 ${generated === null || generated === undefined ? '未记录' : `v${generated}`}`}
    </span>
  );
  const recipePanel = (
    <section className="rounded-xl border border-indigo-900/70 bg-indigo-950/15 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-indigo-200">生成配方指纹（只读）</p>
        {recipe && <code className="rounded bg-slate-950 px-2 py-1 text-[10px] text-indigo-300">{recipe.fingerprint}</code>}
      </div>
      {recipe ? (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            {badge(contractCurrent, version, recipeContractVersion, '契约版本')}
            {badge(anchorCurrent, anchorVersion, recipeAnchorVersion, '锚图版本')}
          </div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[11px]">
            <dt className="text-slate-500">Provider</dt><dd className="text-right text-slate-200">{recipe.provider}</dd>
            <dt className="text-slate-500">Model</dt><dd className="truncate text-right text-slate-200" title={recipe.model}>{recipe.model}</dd>
            <dt className="text-slate-500">工作流预设</dt><dd className="text-right text-slate-200">{recipe.workflowPresetId || '不适用'}</dd>
            {Object.entries(recipe.params || {}).map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-slate-500">{key}</dt>
                <dd className="text-right font-mono text-slate-200">{String(value)}</dd>
              </Fragment>
            ))}
          </dl>
          <p className="mt-3 text-[10px] leading-relaxed text-slate-500">仅展示生成时配方与版本状态，不拦截生成、定稿或导出。</p>
        </>
      ) : <p className="mt-2 text-[10px] text-slate-500">该镜头尚无配方指纹（旧镜头或尚未生成）。</p>}
    </section>
  );

  if (!initialized || !contract) {
    return (
      <div className="space-y-3">
        <section className="rounded-xl border border-dashed border-slate-700 bg-slate-950/50 p-4 text-xs">
          <p className="font-semibold text-slate-300">项目尚未设定风格契约</p>
          <p className="mt-1 leading-relaxed text-slate-500">请先在「风格设定」步骤保存并锁定项目风格，再进行批量分镜生成。</p>
        </section>
        {recipePanel}
      </div>
    );
  }

  const sampler = selectedPreset?.sampler ?? selectedPreset?.defaultParameters?.sampler;
  const steps = selectedPreset?.steps ?? selectedPreset?.defaultParameters?.steps;
  const cfg = selectedPreset?.cfg ?? selectedPreset?.defaultParameters?.cfg;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-200">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-400">项目风格契约</p>
          <p className="mt-1 leading-relaxed text-slate-400">风格由项目契约统一控制，分镜仅可调结构参数。</p>
        </div>
        <span className={`rounded-lg border px-2.5 py-1 font-semibold ${locked ? 'border-emerald-700 bg-emerald-950/40 text-emerald-300' : 'border-amber-800 bg-amber-950/30 text-amber-300'}`}>
          v{version} · {locked ? '已锁定' : '未锁定'}
        </span>
      </header>

      {presetWarning && <p className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/25 px-3 py-2 text-amber-200" role="status">预设详情读取失败：{presetWarning}</p>}

      <dl className="mt-3 grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-xl border border-slate-800 bg-slate-900/55 p-3">
        <dt className="text-slate-500">工作流预设</dt><dd className="text-right font-semibold text-slate-100">{selectedPreset?.displayName || contract.storyboardPresetId}</dd>
        <dt className="text-slate-500">Checkpoint</dt><dd className="truncate text-right text-slate-200" title={selectedPreset?.modelName}>{presetValue(selectedPreset?.modelName)}</dd>
        <dt className="text-slate-500">Sampler</dt><dd className="text-right text-slate-200">{presetValue(sampler)}</dd>
        <dt className="text-slate-500">Steps / CFG</dt><dd className="text-right text-slate-200">{presetValue(steps)} / {presetValue(cfg)}</dd>
        <dt className="text-slate-500">分辨率</dt><dd className="text-right font-mono text-slate-200">{contract.width} × {contract.height}</dd>
        <dt className="text-slate-500">LoRA 强度</dt><dd className="text-right font-mono text-slate-200">{contract.loraStrength}</dd>
        <dt className="self-start text-slate-500">风格 Overlay</dt><dd className="whitespace-pre-wrap break-words text-right leading-relaxed text-slate-300">{contract.styleOverlay || '未设置额外 Overlay'}</dd>
      </dl>
      <div className="mt-3">{recipePanel}</div>
    </section>
  );
}
