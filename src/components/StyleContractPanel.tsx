import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  available?: boolean;
  reason?: string | null;
  sampler?: string;
  steps?: number;
  cfg?: number;
  defaultParameters?: { sampler?: string; steps?: number; cfg?: number };
}

class ApiRequestError extends Error {
  constructor(message: string, public status: number, public data: any) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function errorMessage(data: any, status: number): string {
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.error?.message === 'string') return data.error.message;
  return `请求失败 (HTTP ${status})`;
}

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiRequestError(errorMessage(data, response.status), response.status, data);
  return data;
}

function sameContract(left: StyleContractFields | null, right: StyleContractFields | null): boolean {
  if (!left || !right) return false;
  return left.storyboardPresetId === right.storyboardPresetId
    && left.styleOverlay === right.styleOverlay
    && left.width === right.width
    && left.height === right.height
    && left.loraStrength === right.loraStrength;
}

function presetValue(value: unknown): string {
  return value === undefined || value === null || value === '' ? '由预设决定' : String(value);
}

export default function StyleContractPanel({
  projectId,
  onLockedChange,
}: {
  projectId: string;
  onLockedChange?: (locked: boolean) => void;
}) {
  const [contract, setContract] = useState<StyleContractFields | null>(null);
  const [savedContract, setSavedContract] = useState<StyleContractFields | null>(null);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [version, setVersion] = useState(0);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'save-lock' | 'lock' | 'unlock' | ''>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const onLockedChangeRef = useRef(onLockedChange);

  const endpoint = `/api/generated-scripts/${encodeURIComponent(projectId)}/style-contract`;
  const dirty = Boolean(contract && (!initialized || !sameContract(contract, savedContract)));
  const selectedPreset = useMemo(
    () => presets.find(preset => preset.presetId === contract?.storyboardPresetId),
    [contract?.storyboardPresetId, presets],
  );

  useEffect(() => {
    onLockedChangeRef.current = onLockedChange;
  }, [onLockedChange]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const [contractData, presetData] = await Promise.all([
        readJson(await fetch(endpoint, { signal })),
        readJson(await fetch('/api/comfyui/presets?purpose=storyboard', { signal })),
      ]);
      const nextContract = contractData.contract as StyleContractFields;
      const nextLocked = Boolean(contractData.locked);
      setContract(nextContract);
      setSavedContract(nextContract);
      setInitialized(Boolean(contractData.initialized));
      setVersion(Number(contractData.version || 0));
      setLocked(nextLocked);
      setPresets(Array.isArray(presetData.presets) ? presetData.presets : []);
      setMissing(new Set());
      onLockedChangeRef.current?.(nextLocked);
    } catch (loadError) {
      if ((loadError as Error).name !== 'AbortError') setError((loadError as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const patchContract = <Key extends keyof StyleContractFields>(key: Key, value: StyleContractFields[Key]) => {
    setContract(current => current ? { ...current, [key]: value } : current);
    setMissing(current => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setMessage('');
  };

  const captureApiError = (actionError: unknown) => {
    const apiError = actionError as ApiRequestError;
    setError(apiError.message || '操作失败');
    const fields = Array.isArray(apiError.data?.missing)
      ? apiError.data.missing
      : typeof apiError.data?.field === 'string' ? [apiError.data.field] : [];
    setMissing(new Set(fields));
  };

  const save = async (lockAfterSave = false) => {
    if (!contract || locked) return;
    setBusy(lockAfterSave ? 'save-lock' : 'save');
    setError('');
    setMessage('');
    setMissing(new Set());
    try {
      const data = await readJson(await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract, ...(lockAfterSave ? { lock: true } : {}) }),
      }));
      const nextContract = data.contract as StyleContractFields;
      const nextLocked = Boolean(data.locked);
      setContract(nextContract);
      setSavedContract(nextContract);
      setInitialized(true);
      setVersion(Number(data.version || 0));
      setLocked(nextLocked);
      setMessage(lockAfterSave ? `已保存并锁定 v${data.version}` : `已保存 v${data.version}`);
      onLockedChangeRef.current?.(nextLocked);
    } catch (saveError) {
      captureApiError(saveError);
    } finally {
      setBusy('');
    }
  };

  const toggleLock = async () => {
    if (!initialized || (dirty && !locked)) return;
    const nextLocked = !locked;
    setBusy(nextLocked ? 'lock' : 'unlock');
    setError('');
    setMessage('');
    setMissing(new Set());
    try {
      const data = await readJson(await fetch(`${endpoint}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: nextLocked }),
      }));
      setLocked(Boolean(data.locked));
      setVersion(Number(data.version || 0));
      setMessage(nextLocked ? `已锁定 v${data.version}` : `已解锁 v${data.version}`);
      onLockedChangeRef.current?.(nextLocked);
    } catch (lockError) {
      captureApiError(lockError);
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-5 text-xs text-slate-400" role="status">正在加载风格契约…</div>;
  }
  if (!contract) {
    return (
      <div className="rounded-xl border border-red-900/70 bg-red-950/25 p-5 text-xs text-red-200" role="alert">
        <p>{error || '风格契约数据不可用'}</p>
        <button type="button" onClick={() => void load()} className="mt-3 min-h-10 rounded-lg border border-red-700 px-4 py-2 hover:bg-red-900/30">重试</button>
      </div>
    );
  }

  const sampler = selectedPreset?.sampler ?? selectedPreset?.defaultParameters?.sampler;
  const steps = selectedPreset?.steps ?? selectedPreset?.defaultParameters?.steps;
  const cfg = selectedPreset?.cfg ?? selectedPreset?.defaultParameters?.cfg;
  const fieldBorder = (field: string) => missing.has(field) ? 'border-red-500 focus:border-red-400' : 'border-slate-700 focus:border-cyan-500';

  return (
    <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-200">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-400">项目风格 / Style Contract</p>
          <h2 className="mt-1 text-sm font-semibold text-white">{initialized ? `风格契约 v${version}` : '未锁定的建议初稿'}</h2>
        </div>
        <span className={`rounded-lg border px-2.5 py-1 font-semibold ${locked ? 'border-emerald-700 bg-emerald-950/40 text-emerald-300' : 'border-amber-800 bg-amber-950/30 text-amber-300'}`}>
          {locked ? '已锁定' : '未锁定'}
        </span>
      </header>

      {error && <div className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-red-200" role="alert">{error}</div>}
      {message && <div className="rounded-lg border border-emerald-800/70 bg-emerald-950/30 px-3 py-2 text-emerald-200" role="status">{message}</div>}

      <fieldset disabled={locked || Boolean(busy)} className="space-y-4 disabled:opacity-60">
        <label className="block space-y-1.5">
          <span className="font-semibold text-slate-300">分镜工作流预设</span>
          <select
            value={contract.storyboardPresetId}
            onChange={event => patchContract('storyboardPresetId', event.target.value)}
            aria-invalid={missing.has('storyboardPresetId')}
            className={`min-h-10 w-full rounded-lg border bg-slate-900 px-3 py-2 text-slate-100 outline-none ${fieldBorder('storyboardPresetId')}`}
          >
            {presets.length === 0 && <option value={contract.storyboardPresetId}>{contract.storyboardPresetId || '没有可用预设'}</option>}
            {presets.map(preset => (
              <option key={preset.presetId} value={preset.presetId} disabled={preset.available === false}>
                {preset.displayName || preset.presetId}{preset.available === false ? `（不可用：${preset.reason || '环境不完整'}）` : ''}
              </option>
            ))}
          </select>
          <p className="text-[10px] leading-relaxed text-slate-500">预设决定 checkpoint、sampler、steps 与 CFG；契约不提供无法真实生效的伪调节项。</p>
        </label>

        <label className="block space-y-1.5">
          <span className="font-semibold text-slate-300">风格 Overlay</span>
          <textarea
            value={contract.styleOverlay}
            onChange={event => patchContract('styleOverlay', event.target.value)}
            rows={4}
            aria-invalid={missing.has('styleOverlay')}
            className={`w-full resize-y rounded-lg border bg-slate-900 px-3 py-2 leading-relaxed text-slate-100 outline-none ${fieldBorder('styleOverlay')}`}
            placeholder="全项目统一的色彩、光影、材质与氛围描述"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          {(['width', 'height'] as const).map(field => (
            <label key={field} className="space-y-1.5">
              <span className="block font-semibold text-slate-300">{field === 'width' ? '宽度' : '高度'}</span>
              <input
                type="number"
                min={256}
                max={2048}
                step={8}
                value={contract[field]}
                onChange={event => patchContract(field, Number(event.target.value))}
                aria-invalid={missing.has(field)}
                className={`min-h-10 w-full rounded-lg border bg-slate-900 px-3 py-2 text-slate-100 outline-none ${fieldBorder(field)}`}
              />
            </label>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={`style-lora-strength-${projectId}`} className="font-semibold text-slate-300">LoRA 强度</label>
            <input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={contract.loraStrength}
              onChange={event => patchContract('loraStrength', Number(event.target.value))}
              aria-invalid={missing.has('loraStrength')}
              className={`min-h-10 w-24 rounded-lg border bg-slate-900 px-2 py-1.5 text-right outline-none ${fieldBorder('loraStrength')}`}
            />
          </div>
          <input
            id={`style-lora-strength-${projectId}`}
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={contract.loraStrength}
            onChange={event => patchContract('loraStrength', Number(event.target.value))}
            className="h-10 w-full accent-cyan-500"
          />
          {!selectedPreset && <p className="text-[10px] text-amber-300">当前预设元数据不可用；LoRA 强度会保留在契约中，是否生效由预设能力决定。</p>}
        </div>
      </fieldset>

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
        <p className="font-semibold text-slate-300">预设派生参数（只读）</p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[11px]">
          <dt className="text-slate-500">Checkpoint</dt><dd className="truncate text-right text-slate-200" title={selectedPreset?.modelName}>{presetValue(selectedPreset?.modelName)}</dd>
          <dt className="text-slate-500">Sampler</dt><dd className="text-right text-slate-200">{presetValue(sampler)}</dd>
          <dt className="text-slate-500">Steps</dt><dd className="text-right text-slate-200">{presetValue(steps)}</dd>
          <dt className="text-slate-500">CFG</dt><dd className="text-right text-slate-200">{presetValue(cfg)}</dd>
        </dl>
      </div>

      <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-3">
        {!locked && (
          <button type="button" disabled={!dirty || Boolean(busy)} onClick={() => void save(false)} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 font-semibold text-slate-200 hover:border-cyan-600 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40">
            {busy === 'save' ? '保存中…' : dirty ? '保存' : '已保存'}
          </button>
        )}
        {!locked && dirty && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void save(true)} className="min-h-10 rounded-lg bg-cyan-600 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40">
            {busy === 'save-lock' ? '保存并锁定中…' : '保存并锁定'}
          </button>
        )}
        {(locked || (!dirty && initialized)) && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void toggleLock()} className={`min-h-10 rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${locked ? 'border border-amber-700 text-amber-200 hover:bg-amber-950/30' : 'bg-emerald-600 text-white hover:bg-emerald-500'}`}>
            {busy ? (locked ? '解锁中…' : '锁定中…') : locked ? '解锁契约' : '锁定契约'}
          </button>
        )}
      </footer>
    </section>
  );
}
