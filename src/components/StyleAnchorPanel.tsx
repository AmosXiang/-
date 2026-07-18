import { useCallback, useEffect, useState } from 'react';

export interface StyleAnchorRecord {
  imageUrl: string;
  version: number;
  note?: string;
  updatedAt: string;
}

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.error || `请求失败 (HTTP ${response.status})`));
  return data;
}

export default function StyleAnchorPanel({
  projectId,
  onChange,
}: {
  projectId: string;
  onChange?: (styleAnchor: StyleAnchorRecord | null) => void;
}) {
  const [styleAnchor, setStyleAnchor] = useState<StyleAnchorRecord | null>(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'upload' | 'note' | 'clear' | ''>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/style-anchor`;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const data = await readJson(await fetch(endpoint, { signal }));
      const next = data.styleAnchor as StyleAnchorRecord | null;
      setStyleAnchor(next);
      setNote(next?.note || '');
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

  const save = async (file?: File) => {
    if (!file && !styleAnchor) return;
    setBusy(file ? 'upload' : 'note');
    setError('');
    setMessage('');
    try {
      const form = new FormData();
      if (file) form.append('image', file);
      form.append('note', note);
      const data = await readJson(await fetch(endpoint, { method: 'PUT', body: form }));
      const next = data.styleAnchor as StyleAnchorRecord;
      setStyleAnchor(next);
      setNote(next.note || '');
      setMessage(file ? `复核基准已保存为 v${next.version}` : `说明已保存（锚图 v${next.version} 不变）`);
      onChange?.(next);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy('');
    }
  };

  const clear = async () => {
    setBusy('clear');
    setError('');
    setMessage('');
    try {
      await readJson(await fetch(endpoint, { method: 'DELETE' }));
      setStyleAnchor(null);
      setNote('');
      setMessage('风格锚图已清除');
      onChange?.(null);
    } catch (clearError) {
      setError((clearError as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="space-y-4 rounded-xl border border-indigo-800/70 bg-indigo-950/15 p-4 text-xs text-slate-200">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-indigo-900/60 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-300">风格锚图 / Reference of Record</p>
          <h2 className="mt-1 text-sm font-semibold text-white">{styleAnchor ? `人工复核基准 v${styleAnchor.version}` : '尚未设置人工复核基准'}</h2>
        </div>
        <span className="rounded-lg border border-indigo-700 bg-indigo-950/50 px-2.5 py-1 font-semibold text-indigo-200">不参与生成</span>
      </header>

      <p className="rounded-lg border border-amber-800/60 bg-amber-950/25 px-3 py-2 leading-relaxed text-amber-100">
        人工复核基准：用于比对分镜是否贴合目标风格；当前技术栈下不作图像注入（见风格调研结论）。
      </p>
      {error && <p className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-red-200" role="alert">{error}</p>}
      {message && <p className="rounded-lg border border-emerald-900/70 bg-emerald-950/30 px-3 py-2 text-emerald-200" role="status">{message}</p>}

      {loading ? (
        <div className="flex aspect-video items-center justify-center rounded-xl border border-slate-800 bg-slate-950/60 text-slate-500">正在读取锚图…</div>
      ) : styleAnchor ? (
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
          <img src={`${styleAnchor.imageUrl}?v=${styleAnchor.version}`} alt="风格人工复核基准" className="aspect-video w-full object-contain" />
        </div>
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-950/50 text-slate-500">上传一张仅供人工比对的目标风格图</div>
      )}

      <label className="block space-y-1.5">
        <span className="font-semibold text-slate-300">目标风格说明（人工复核用）</span>
        <textarea value={note} onChange={event => { setNote(event.target.value); setMessage(''); }} maxLength={1000} rows={3} disabled={Boolean(busy)} className="w-full resize-y rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 leading-relaxed text-slate-100 outline-none focus:border-indigo-500 disabled:opacity-60" placeholder="例如：冷青墨色、低饱和、柔和颗粒与窄轮廓光" />
      </label>

      <footer className="flex flex-wrap justify-end gap-2 border-t border-indigo-900/50 pt-3">
        {styleAnchor && <button type="button" disabled={Boolean(busy)} onClick={() => void save()} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 font-semibold text-slate-200 hover:border-indigo-600 disabled:opacity-40">{busy === 'note' ? '保存中…' : '保存说明'}</button>}
        {styleAnchor && <button type="button" disabled={Boolean(busy)} onClick={() => void clear()} className="min-h-10 rounded-lg border border-red-800 px-4 py-2 font-semibold text-red-200 hover:bg-red-950/30 disabled:opacity-40">{busy === 'clear' ? '清除中…' : '清除锚图'}</button>}
        <label className={`min-h-10 rounded-lg bg-indigo-600 px-4 py-2.5 font-semibold text-white ${busy ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-indigo-500'}`}>
          {busy === 'upload' ? '上传中…' : styleAnchor ? '更换锚图' : '上传锚图'}
          <input type="file" accept="image/*" disabled={Boolean(busy)} className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void save(file); event.currentTarget.value = ''; }} />
        </label>
      </footer>
    </section>
  );
}
