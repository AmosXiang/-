import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';

interface ShotVersion {
  taskId: string;
  imageUrl: string | null;
  seed: string;
  model: string;
  status: string;
  createdAt: string;
  isFinal: boolean;
}

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (HTTP ${response.status})`);
  return data;
}

export default function ShotVersionPanel({
  projectId,
  shotId,
  finalTaskId,
  onShotUpdated,
}: {
  projectId: string;
  shotId: string;
  finalTaskId?: string;
  onShotUpdated: (shot: any) => void;
}) {
  const [versions, setVersions] = useState<ShotVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyTaskId, setBusyTaskId] = useState('');
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  const baseUrl = `/api/generated-scripts/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}`;
  const loadVersions = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const data = await readJson(await apiFetch(`${baseUrl}/versions`, { signal }));
      setVersions(Array.isArray(data.versions) ? data.versions : []);
      setFailedImages(new Set());
    } catch (loadError) {
      if ((loadError as Error).name !== 'AbortError') setError((loadError as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void loadVersions(controller.signal);
    return () => controller.abort();
  }, [loadVersions, finalTaskId]);

  const updateFinal = async (taskId?: string) => {
    const actionId = taskId || 'cancel-final';
    setBusyTaskId(actionId);
    setError('');
    try {
      const data = await readJson(await fetch(`${baseUrl}/final`, taskId ? {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      } : { method: 'DELETE' }));
      onShotUpdated(data.shot);
      await loadVersions();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setBusyTaskId('');
    }
  };

  if (loading) {
    return <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-500">正在加载生成版本…</div>;
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-200">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400">画面版本 / Versions</p>
          <p className="mt-1 text-slate-500">共 {versions.length} 个生成记录</p>
        </div>
        <button type="button" onClick={() => void loadVersions()} className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-400 hover:border-blue-500 hover:text-blue-300">刷新</button>
      </div>

      {error && <div className="mt-3 rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-red-300">{error}</div>}

      {versions.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-slate-800 p-6 text-center text-slate-500">该分镜还没有生成记录</div>
      ) : (
        <div className={`mt-3 grid grid-cols-2 gap-2 ${versions.length > 8 ? 'max-h-[42rem] overflow-y-auto pr-1' : ''}`}>
          {versions.map(version => {
            // The versions endpoint reads the persisted shot and is authoritative.
            // finalTaskId remains a refresh trigger for parent-side shot updates.
            const isFinal = version.isFinal;
            const hasImage = Boolean(version.imageUrl) && !failedImages.has(version.taskId);
            const succeeded = version.status === 'succeeded';
            return (
              <article key={version.taskId} className={`overflow-hidden rounded-xl border bg-slate-900/80 ${isFinal ? 'border-emerald-500 ring-1 ring-emerald-500/30' : 'border-slate-800'}`}>
                <div className="relative aspect-video bg-slate-950">
                  {hasImage ? (
                    <img
                      src={version.imageUrl || undefined}
                      alt={`任务 ${version.taskId} 的生成画面`}
                      className="h-full w-full object-contain"
                      onError={() => setFailedImages(current => new Set(current).add(version.taskId))}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px] text-slate-600">{version.imageUrl ? '图片加载失败' : '暂无结果图片'}</div>
                  )}
                  {isFinal && <span className="absolute left-2 top-2 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-slate-950">已定稿</span>}
                  <span className={`absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-[9px] ${succeeded ? 'bg-emerald-950/90 text-emerald-300' : version.status === 'failed' ? 'bg-red-950/90 text-red-300' : 'bg-slate-950/90 text-slate-400'}`}>{version.status || 'unknown'}</span>
                </div>
                <div className="space-y-1.5 p-2.5">
                  <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10px]">
                    <span className="text-slate-600">模型</span><span className="truncate text-slate-300" title={version.model}>{version.model || '未记录'}</span>
                    <span className="text-slate-600">Seed</span><span className="truncate font-mono text-slate-400">{version.seed || '—'}</span>
                    <span className="text-slate-600">时间</span><span className="text-slate-400">{version.createdAt ? new Date(version.createdAt).toLocaleString('zh-CN') : '未记录'}</span>
                  </div>
                  {isFinal ? (
                    <button type="button" disabled={Boolean(busyTaskId)} onClick={() => void updateFinal()} className="w-full rounded-lg border border-emerald-800 px-2 py-1.5 font-semibold text-emerald-300 hover:bg-emerald-950/40 disabled:opacity-40">{busyTaskId ? '处理中…' : '取消定稿'}</button>
                  ) : succeeded ? (
                    <button type="button" disabled={Boolean(busyTaskId)} onClick={() => void updateFinal(version.taskId)} className="w-full rounded-lg bg-blue-600 px-2 py-1.5 font-semibold text-white hover:bg-blue-500 disabled:opacity-40">{busyTaskId === version.taskId ? '定稿中…' : '设为定稿'}</button>
                  ) : (
                    <div className="rounded-lg border border-slate-800 px-2 py-1.5 text-center text-slate-600">仅成功版本可定稿</div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
