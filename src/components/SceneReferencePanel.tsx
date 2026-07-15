import { useCallback, useEffect, useState } from 'react';
import { ImagePlus, Loader2, Plus, Save, Trash2, Upload } from 'lucide-react';
import type { SceneReference } from '../types';

type SceneDraft = Omit<SceneReference, 'id' | 'updatedAt'> & { id?: string; updatedAt?: string };

function SceneThumbnail({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div className="flex h-24 w-full items-center justify-center rounded-lg border border-dashed border-slate-700 bg-slate-950/60 text-[10px] text-slate-500">
        <ImagePlus className="mr-1.5 h-4 w-4" />{failed ? '参考图加载失败' : '暂无场景参考图'}
      </div>
    );
  }
  return <img src={src} alt={`${name || '场景'}参考图`} onError={() => setFailed(true)} className="h-24 w-full rounded-lg border border-slate-800 object-cover" />;
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (HTTP ${response.status})`);
  return data;
}

export default function SceneReferencePanel({
  projectId,
  onScenesChange,
}: {
  projectId: string;
  onScenesChange?: (scenes: SceneReference[]) => void;
}) {
  const [scenes, setScenes] = useState<SceneDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingId, setUploadingId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const endpoint = `/api/generated-scripts/${encodeURIComponent(projectId)}/scene-references`;

  const applyScenes = useCallback((nextScenes: SceneReference[]) => {
    setScenes(nextScenes);
    onScenesChange?.(nextScenes);
  }, [onScenesChange]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const data = await readJson(await fetch(endpoint, { signal }));
      applyScenes(Array.isArray(data.scenes) ? data.scenes : []);
    } catch (loadError) {
      if ((loadError as Error).name !== 'AbortError') setError((loadError as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [applyScenes, endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const persist = async (nextScenes: SceneDraft[], successMessage: string) => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const data = await readJson(await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenes: nextScenes.map(scene => ({
            ...(scene.id ? { id: scene.id } : {}),
            name: scene.name,
            ...(scene.imageUrl ? { imageUrl: scene.imageUrl } : {}),
            ...(scene.overlay === undefined ? {} : { overlay: scene.overlay }),
            ...(scene.updatedAt ? { updatedAt: scene.updatedAt } : {}),
          })),
        }),
      }));
      applyScenes(data.scenes || []);
      setMessage(data.orphanedShotCount > 0
        ? `${successMessage}；${data.orphanedShotCount} 个分镜保留了已删除场景标签`
        : successMessage);
      return true;
    } catch (saveError) {
      setError((saveError as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const uploadImage = async (scene: SceneDraft, file: File) => {
    if (!scene.id) return;
    setUploadingId(scene.id);
    setError('');
    setMessage('');
    try {
      const form = new FormData();
      form.append('image', file);
      const data = await readJson(await fetch(`${endpoint}/${encodeURIComponent(scene.id)}/image`, { method: 'POST', body: form }));
      const next = scenes.map(item => item.id === scene.id ? data.scene : item) as SceneReference[];
      setScenes(next);
      onScenesChange?.(next.filter(item => item.id && item.updatedAt));
      setMessage(`已更新「${data.scene.name}」参考图`);
    } catch (uploadError) {
      setError((uploadError as Error).message);
    } finally {
      setUploadingId('');
    }
  };

  if (loading) return <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-xs text-slate-400">正在加载场景参考…</div>;

  return (
    <section className="space-y-4 rounded-xl border border-indigo-900/60 bg-indigo-950/15 p-4 text-xs text-slate-200">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-300">场景参考 / Scene References</p>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">最多 20 个场景。当前轻量版仅把场景 Overlay 注入分镜提示词，参考图不参与 conditioning。</p>
        </div>
        <button type="button" disabled={saving || scenes.length >= 20} onClick={() => setScenes(current => [...current, { name: '', overlay: '' }])} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-indigo-700 px-3 py-2 font-semibold text-indigo-200 hover:bg-indigo-900/30 disabled:opacity-40">
          <Plus className="h-3.5 w-3.5" />新增场景
        </button>
      </header>

      {error && <div className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-red-200" role="alert">{error}</div>}
      {message && <div className="rounded-lg border border-emerald-900/70 bg-emerald-950/30 px-3 py-2 text-emerald-200" role="status">{message}</div>}
      {scenes.length === 0 && <div className="rounded-xl border border-dashed border-slate-700 p-5 text-center text-slate-500">尚未添加场景参考</div>}

      <div className="grid gap-3 lg:grid-cols-2">
        {scenes.map((scene, index) => (
          <article key={scene.id || `new-${index}`} className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <SceneThumbnail src={scene.imageUrl} name={scene.name} />
            <label className="block space-y-1.5">
              <span className="font-semibold text-slate-400">场景名</span>
              <input value={scene.name} onChange={event => setScenes(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} placeholder="例如：豪宅客厅" className="min-h-9 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-indigo-500" />
            </label>
            <label className="block space-y-1.5">
              <span className="font-semibold text-slate-400">场景 Overlay</span>
              <textarea rows={3} maxLength={2000} value={scene.overlay || ''} onChange={event => setScenes(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, overlay: event.target.value } : item))} placeholder="Environment-only English prompt…" className="w-full resize-y rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 leading-relaxed text-slate-100 outline-none focus:border-indigo-500" />
            </label>
            <div className="flex flex-wrap justify-between gap-2">
              <label className={`flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 font-semibold ${scene.id && uploadingId !== scene.id ? 'cursor-pointer hover:border-indigo-600 hover:text-indigo-200' : 'cursor-not-allowed opacity-40'}`}>
                {uploadingId === scene.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {scene.id ? '上传参考图' : '保存后可上传'}
                <input type="file" accept="image/*" disabled={!scene.id || Boolean(uploadingId)} className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadImage(scene, file); event.currentTarget.value = ''; }} />
              </label>
              <button type="button" disabled={saving || Boolean(uploadingId)} onClick={() => { const next = scenes.filter((_, itemIndex) => itemIndex !== index); if (scene.id) void persist(next, `已删除「${scene.name}」`); else setScenes(next); }} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-red-900/70 px-3 py-2 text-red-300 hover:bg-red-950/30 disabled:opacity-40">
                <Trash2 className="h-3.5 w-3.5" />删除
              </button>
            </div>
          </article>
        ))}
      </div>

      <footer className="flex justify-end border-t border-slate-800 pt-3">
        <button type="button" disabled={saving || Boolean(uploadingId)} onClick={() => void persist(scenes, '场景参考已保存')} className="flex min-h-10 items-center gap-2 rounded-lg bg-indigo-500 px-4 py-2 font-semibold text-white hover:bg-indigo-400 disabled:opacity-40">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存场景列表
        </button>
      </footer>
    </section>
  );
}
