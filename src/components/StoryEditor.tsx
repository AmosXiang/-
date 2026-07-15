import { useCallback, useEffect, useState } from 'react';

interface StoryDraft {
  logline: string;
  beats: Array<{ id: string; title: string; summary: string }>;
  hooks: Array<{ id: string; time: string; label: string }>;
}

interface VersionSummary {
  version: number;
  savedAt: string;
  note?: string;
}

interface VersionSnapshot extends VersionSummary {
  storyDraft: StoryDraft;
}

function localId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
}

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (HTTP ${response.status})`);
  return data;
}

export default function StoryEditor({
  projectId,
  onSaved,
}: {
  projectId: string;
  onSaved?: (info: { storyVersion: number; staleMarked: number }) => void;
}) {
  const [draft, setDraft] = useState<StoryDraft | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [storyVersion, setStoryVersion] = useState(0);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [preview, setPreview] = useState<VersionSnapshot | null>(null);
  const [note, setNote] = useState('');
  const [markShotsStale, setMarkShotsStale] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const endpoint = `/api/generated-scripts/${encodeURIComponent(projectId)}/story`;

  const loadStory = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const data = await readJson(await fetch(endpoint, { signal }));
      setDraft(data.storyDraft);
      setInitialized(Boolean(data.initialized));
      setStoryVersion(Number(data.storyVersion || 0));
      setVersions(Array.isArray(data.versions) ? data.versions : []);
      setSelectedVersion('');
      setPreview(null);
    } catch (loadError) {
      if ((loadError as Error).name !== 'AbortError') setError((loadError as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    void loadStory(controller.signal);
    return () => controller.abort();
  }, [loadStory]);

  const patchBeat = (index: number, patch: Partial<StoryDraft['beats'][number]>) => {
    if (!draft) return;
    setDraft({ ...draft, beats: draft.beats.map((beat, i) => i === index ? { ...beat, ...patch } : beat) });
  };

  const moveBeat = (index: number, offset: number) => {
    if (!draft) return;
    const target = index + offset;
    if (target < 0 || target >= draft.beats.length) return;
    const beats = [...draft.beats];
    [beats[index], beats[target]] = [beats[target], beats[index]];
    setDraft({ ...draft, beats });
  };

  const patchHook = (index: number, patch: Partial<StoryDraft['hooks'][number]>) => {
    if (!draft) return;
    setDraft({ ...draft, hooks: draft.hooks.map((hook, i) => i === index ? { ...hook, ...patch } : hook) });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const data = await readJson(await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyDraft: draft, note: note || undefined, markShotsStale }),
      }));
      const info = { storyVersion: Number(data.storyVersion), staleMarked: Number(data.staleMarked || 0) };
      setMessage(`已保存 v${info.storyVersion}，标记 ${info.staleMarked} 镜`);
      setNote('');
      await loadStory();
      onSaved?.(info);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const chooseVersion = async (value: string) => {
    setSelectedVersion(value);
    setPreview(null);
    setError('');
    if (!value) return;
    setPreviewLoading(true);
    try {
      const url = `${endpoint}/versions/${encodeURIComponent(value)}`;
      setPreview(await readJson(await fetch(url)));
    } catch (previewError) {
      setError((previewError as Error).message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const rollback = async () => {
    if (!preview || preview.version === storyVersion) return;
    if (!window.confirm(`确认把 v${preview.version} 的内容回滚为一个新版本？历史版本不会被覆盖。`)) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const data = await readJson(await fetch(`${endpoint}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: preview.version, markShotsStale }),
      }));
      const info = { storyVersion: Number(data.storyVersion), staleMarked: Number(data.staleMarked || 0) };
      setMessage(`已回滚并保存为 v${info.storyVersion}，标记 ${info.staleMarked} 镜`);
      await loadStory();
      onSaved?.(info);
    } catch (rollbackError) {
      setError((rollbackError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-5 text-xs text-slate-500">正在加载故事版本…</div>;
  }
  if (!draft) {
    return (
      <div className="rounded-xl border border-red-900/60 bg-red-950/20 p-5 text-xs text-red-300">
        <p>{error || '故事数据不可用'}</p>
        <button type="button" onClick={() => void loadStory()} className="mt-3 rounded-lg border border-red-700 px-3 py-1.5 hover:bg-red-900/30">重试</button>
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-200">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-violet-400">故事编辑 / Story</p>
          <h2 className="mt-1 text-sm font-semibold text-white">{initialized ? `故事版本 v${storyVersion}` : '未保存的建议初稿'}</h2>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedVersion}
            onChange={event => void chooseVersion(event.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs outline-none focus:border-violet-500"
          >
            <option value="">版本历史</option>
            {versions.map(version => (
              <option key={version.version} value={version.version}>
                v{version.version} · {new Date(version.savedAt).toLocaleString('zh-CN')}{version.note ? ` · ${version.note}` : ''}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && <div className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-red-300">{error}</div>}
      {message && <div className="rounded-lg border border-emerald-800/70 bg-emerald-950/30 px-3 py-2 text-emerald-300">{message}</div>}

      <label className="block space-y-1.5">
        <span className="font-semibold text-slate-300">一句话故事</span>
        <input
          value={draft.logline}
          onChange={event => setDraft({ ...draft, logline: event.target.value })}
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-violet-500"
          placeholder="用一句话说清主角、目标与冲突"
        />
      </label>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-slate-300">三幕 / Beat 列表</span>
          <button
            type="button"
            onClick={() => setDraft({ ...draft, beats: [...draft.beats, { id: localId('beat'), title: '', summary: '' }] })}
            className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-300 hover:border-violet-500 hover:text-violet-300"
          >+ 添加 Beat</button>
        </div>
        {draft.beats.map((beat, index) => (
          <div key={beat.id} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            <div className="flex gap-2">
              <input
                value={beat.title}
                onChange={event => patchBeat(index, { title: event.target.value })}
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-semibold outline-none focus:border-violet-500"
                placeholder={`Beat ${index + 1} 标题`}
              />
              <button type="button" disabled={index === 0} onClick={() => moveBeat(index, -1)} className="rounded border border-slate-700 px-2 disabled:opacity-30">↑</button>
              <button type="button" disabled={index === draft.beats.length - 1} onClick={() => moveBeat(index, 1)} className="rounded border border-slate-700 px-2 disabled:opacity-30">↓</button>
              <button type="button" onClick={() => setDraft({ ...draft, beats: draft.beats.filter((_, i) => i !== index) })} className="rounded border border-red-900/70 px-2 text-red-400 hover:bg-red-950/40">删除</button>
            </div>
            <textarea
              value={beat.summary}
              onChange={event => patchBeat(index, { summary: event.target.value })}
              rows={3}
              className="mt-2 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 leading-relaxed outline-none focus:border-violet-500"
              placeholder="这个阶段发生什么？"
            />
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-slate-300">爽点时间轴</span>
          <button
            type="button"
            onClick={() => setDraft({ ...draft, hooks: [...draft.hooks, { id: localId('hook'), time: '', label: '' }] })}
            className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-300 hover:border-violet-500 hover:text-violet-300"
          >+ 添加爽点</button>
        </div>
        {draft.hooks.length === 0 && <p className="rounded-lg border border-dashed border-slate-800 p-3 text-slate-500">还没有爽点节点</p>}
        {draft.hooks.map((hook, index) => (
          <div key={hook.id} className="flex gap-2">
            <input value={hook.time} onChange={event => patchHook(index, { time: event.target.value })} className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono outline-none focus:border-violet-500" placeholder="00:20" />
            <input value={hook.label} onChange={event => patchHook(index, { label: event.target.value })} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 outline-none focus:border-violet-500" placeholder="爽点说明" />
            <button type="button" onClick={() => setDraft({ ...draft, hooks: draft.hooks.filter((_, i) => i !== index) })} className="rounded border border-red-900/70 px-2 text-red-400 hover:bg-red-950/40">删除</button>
          </div>
        ))}
      </div>

      <div className="grid gap-3 border-t border-slate-800 pt-3 md:grid-cols-[1fr_auto]">
        <div className="space-y-2">
          <input value={note} maxLength={500} onChange={event => setNote(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 outline-none focus:border-violet-500" placeholder="版本备注（可选，最多 500 字）" />
          <label className="flex items-center gap-2 text-slate-400">
            <input type="checkbox" checked={markShotsStale} onChange={event => setMarkShotsStale(event.target.checked)} className="h-4 w-4 accent-violet-500" />
            将受影响分镜标记为「基于旧输入」
          </label>
        </div>
        <button type="button" disabled={saving} onClick={() => void save()} className="self-start rounded-lg bg-violet-600 px-5 py-2 font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? '保存中…' : '保存新版本'}
        </button>
      </div>

      {(previewLoading || preview) && (
        <aside className="rounded-xl border border-violet-800/50 bg-violet-950/20 p-3">
          {previewLoading ? <p className="text-slate-500">正在加载版本快照…</p> : preview && (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-violet-300">预览 v{preview.version}{preview.version === storyVersion ? '（当前版本）' : ''}</p>
                  <p className="mt-0.5 text-[10px] text-slate-500">{new Date(preview.savedAt).toLocaleString('zh-CN')}{preview.note ? ` · ${preview.note}` : ''}</p>
                </div>
                <button type="button" disabled={saving || preview.version === storyVersion} onClick={() => void rollback()} className="rounded-lg border border-violet-700 px-3 py-1.5 text-violet-300 disabled:cursor-not-allowed disabled:opacity-35">回滚为新版本</button>
              </div>
              <p className="mt-3 text-sm text-white">{preview.storyDraft.logline}</p>
              <ol className="mt-2 space-y-1 text-slate-400">
                {preview.storyDraft.beats.map(beat => <li key={beat.id}><span className="text-slate-200">{beat.title}：</span>{beat.summary}</li>)}
              </ol>
              {preview.storyDraft.hooks.length > 0 && <p className="mt-2 text-slate-400">爽点：{preview.storyDraft.hooks.map(hook => `${hook.time} ${hook.label}`).join(' · ')}</p>}
            </>
          )}
        </aside>
      )}
    </section>
  );
}
