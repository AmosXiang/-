import { useEffect, useMemo, useState } from 'react';

import type { Shot } from '../types.ts';
import AnimaticPlayer from './AnimaticPlayer.tsx';

type GenerationMode = 'textToVideo' | 'imageToVideo' | 'firstLastFrame';
type MotionStrength = 'static' | 'natural' | 'extreme';
type AdaptMode = 'crop' | 'letterbox';

type ProviderCapability = {
  id: string;
  label: string;
  supportedModes: Record<GenerationMode, boolean>;
  durations: number[];
  resolutions: string[];
  aspectRatios: string[];
  fpsOptions: number[];
  supportsAudio: boolean;
  supportsNativeCameraControl: boolean;
  configured: boolean;
};

type MotionPrompt = {
  subjectScene: string;
  action: string;
  cameraMove: string;
  environment: string;
  continuity: string;
  prohibitions: string;
};

type VideoTaskRecord = {
  id?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress?: number | null;
  error?: string | null;
  local_path?: string | null;
  download_error?: string | null;
};

type AspectIssue = {
  projectAspect: string;
  supportedAspectRatios: string[];
};

const MODES: Array<{ id: GenerationMode; label: string }> = [
  { id: 'textToVideo', label: '文生视频' },
  { id: 'imageToVideo', label: '图生视频' },
  { id: 'firstLastFrame', label: '首尾帧' },
];

const STRENGTHS: Array<{ id: MotionStrength; label: string }> = [
  { id: 'static', label: '静止' },
  { id: 'natural', label: '自然' },
  { id: 'extreme', label: '极端' },
];

const PROMPT_FIELDS: Array<{ id: keyof MotionPrompt; label: string; placeholder: string }> = [
  { id: 'subjectScene', label: '画面主体与场景 *', placeholder: '描述画面主体、场景与构图。' },
  { id: 'action', label: '角色动作', placeholder: '描述人物或主体的动作。' },
  { id: 'cameraMove', label: '镜头运动', placeholder: '描述推、拉、摇、移等运镜。' },
  { id: 'environment', label: '环境动态', placeholder: '描述风、雨、烟雾、灯光等环境变化。' },
  { id: 'continuity', label: '连续性约束', placeholder: '描述必须保持一致的人物、服装、空间关系。' },
  { id: 'prohibitions', label: '禁止变化项', placeholder: '例如：不要增加人物，不要切换镜头。' },
];

const EMPTY_MOTION_PROMPT: MotionPrompt = {
  subjectScene: '',
  action: '',
  cameraMove: '',
  environment: '',
  continuity: '',
  prohibitions: '',
};

const LOCAL_PATH_WAIT_TIMEOUT_MS = 60_000;

class ApiRequestError extends Error {
  constructor(message: string, public status: number, public data: any) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function apiErrorMessage(data: any, status: number): string {
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.error?.message === 'string') return data.error.message;
  return `请求失败 (HTTP ${status})`;
}

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiRequestError(apiErrorMessage(data, response.status), response.status, data);
  return data;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b > 0) [a, b] = [b, a % b];
  return a || 1;
}

function aspectFromContract(contract: any): string {
  const width = Number(contract?.width);
  const height = Number(contract?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return '未知';
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function ChoiceButtons<T extends string | number>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T | undefined;
  choices: T[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {choices.map(choice => (
          <button
            key={String(choice)}
            type="button"
            aria-pressed={value === choice}
            onClick={() => onChange(choice)}
            className={`min-h-9 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
              value === choice
                ? 'border-violet-400 bg-violet-500/20 text-violet-200'
                : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500 hover:text-slate-200'
            }`}
          >
            {String(choice)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export default function VideoLabPanel({ projectId, shots }: { projectId: string; shots: Shot[] }) {
  const selectableShots = useMemo(() => shots.filter(shot => Boolean(shot.id)), [shots]);
  const [selectedShotId, setSelectedShotId] = useState(() => selectableShots[0]?.id || '');
  const [providers, setProviders] = useState<ProviderCapability[]>([]);
  const [providerId, setProviderId] = useState('');
  const [mode, setMode] = useState<GenerationMode>('textToVideo');
  const [durationSec, setDurationSec] = useState<number>();
  const [resolution, setResolution] = useState<string>();
  const [fps, setFps] = useState<number>();
  const [motionStrength, setMotionStrength] = useState<MotionStrength>('natural');
  const [motionPrompt, setMotionPrompt] = useState<MotionPrompt>(EMPTY_MOTION_PROMPT);
  const [seed, setSeed] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [projectAspect, setProjectAspect] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [taskId, setTaskId] = useState('');
  const [task, setTask] = useState<VideoTaskRecord | null>(null);
  const [snapshot, setSnapshot] = useState<Record<string, any> | null>(null);
  const [submittedShotId, setSubmittedShotId] = useState('');
  const [pollError, setPollError] = useState('');
  const [pollNonce, setPollNonce] = useState(0);
  const [aspectIssue, setAspectIssue] = useState<AspectIssue | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const selectedShot = useMemo(
    () => selectableShots.find(shot => shot.id === selectedShotId),
    [selectableShots, selectedShotId],
  );
  const selectedCapability = useMemo(
    () => providers.find(provider => provider.id === providerId),
    [providerId, providers],
  );
  const supportedModes = useMemo(
    () => MODES.filter(option => selectedCapability?.supportedModes[option.id]),
    [selectedCapability],
  );
  const alternativeProvider = useMemo(
    () => aspectIssue
      ? providers.find(provider => (
        provider.id !== providerId
        && provider.configured
        && provider.aspectRatios.includes(aspectIssue.projectAspect)
      ))
      : undefined,
    [aspectIssue, providerId, providers],
  );
  const previewItems = useMemo(() => {
    if (!task?.local_path || !submittedShotId) return [];
    const snapshotDuration = Number(snapshot?.parameters?.durationSec);
    return [{
      shotId: submittedShotId,
      durationSec: Number.isFinite(snapshotDuration) && snapshotDuration > 0 ? snapshotDuration : 3,
      videoUrl: task.local_path,
    }];
  }, [snapshot?.parameters?.durationSec, submittedShotId, task?.local_path]);

  useEffect(() => {
    if (selectableShots.some(shot => shot.id === selectedShotId)) return;
    setSelectedShotId(selectableShots[0]?.id || '');
  }, [selectableShots, selectedShotId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void Promise.all([
      fetch('/api/video-lab/providers', { signal: controller.signal }).then(readJson),
      fetch(`/api/generated-scripts/${encodeURIComponent(projectId)}/style-contract`, { signal: controller.signal }).then(readJson),
    ]).then(([providerData, contractData]) => {
      const nextProviders = Array.isArray(providerData.providers) ? providerData.providers as ProviderCapability[] : [];
      setProviders(nextProviders);
      setProviderId(current => nextProviders.some(provider => provider.id === current)
        ? current
        : nextProviders.find(provider => provider.configured)?.id || nextProviders[0]?.id || '');
      setProjectAspect(aspectFromContract(contractData.contract));
    }).catch(loadError => {
      if ((loadError as Error).name !== 'AbortError') setError((loadError as Error).message || 'Video Lab 初始化失败');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    if (!selectedCapability) return;
    const firstMode = MODES.find(option => selectedCapability.supportedModes[option.id])?.id;
    setMode(current => selectedCapability.supportedModes[current] ? current : firstMode || 'textToVideo');
    setDurationSec(current => selectedCapability.durations.includes(current as number)
      ? current
      : selectedCapability.durations[0]);
    setResolution(current => selectedCapability.resolutions.includes(current || '')
      ? current
      : selectedCapability.resolutions[0]);
    setFps(current => selectedCapability.fpsOptions.includes(current as number)
      ? current
      : selectedCapability.fpsOptions[0]);
  }, [selectedCapability]);

  useEffect(() => {
    if (!taskId) return;
    let stopped = false;
    let timerId: number | undefined;
    let localPathWaitStartedAt: number | null = null;
    setPollError('');

    const poll = async () => {
      try {
        const nextTask = await readJson(await fetch(`/api/video-tasks/${encodeURIComponent(taskId)}`)) as VideoTaskRecord;
        if (stopped) return;
        setTask(nextTask);

        if (nextTask.status === 'failed') return;
        if (nextTask.status === 'completed') {
          if (nextTask.local_path) return;
          if (nextTask.download_error) return;
          if (localPathWaitStartedAt === null) localPathWaitStartedAt = Date.now();
          if (Date.now() - localPathWaitStartedAt >= LOCAL_PATH_WAIT_TIMEOUT_MS) {
            setPollError('视频已生成，但 60 秒内未完成本地落盘。落盘异常，请检查服务端日志。');
            return;
          }
        } else {
          localPathWaitStartedAt = null;
        }
        timerId = window.setTimeout(() => void poll(), 5_000);
      } catch (pollingError) {
        if (!stopped) setPollError((pollingError as Error).message || '任务状态查询失败');
      }
    };

    void poll();
    return () => {
      stopped = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [pollNonce, taskId]);

  const updateMotionPrompt = (field: keyof MotionPrompt, value: string) => {
    setMotionPrompt(current => ({ ...current, [field]: value }));
  };

  const submit = async (aspectDecision?: { aspectRatio: string; adaptMode: AdaptMode }) => {
    if (!selectedShot?.id || !selectedCapability || durationSec === undefined || resolution === undefined || fps === undefined) return;
    setSubmitting(true);
    setError('');
    setPollError('');
    try {
      const data = await readJson(await fetch('/api/video-lab/shot-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          shotId: selectedShot.id,
          provider: selectedCapability.id,
          mode,
          durationSec,
          fps,
          resolution,
          motionPrompt,
          motionStrength,
          ...(negativePrompt.trim() ? { negativePrompt: negativePrompt.trim() } : {}),
          ...(seed.trim() ? { seed: Number(seed) } : {}),
          ...(aspectDecision ? { aspectDecision } : {}),
        }),
      }));
      setTaskId(String(data.taskId));
      setTask({ id: String(data.taskId), status: 'pending', progress: 0 });
      setSnapshot(data.snapshot as Record<string, any>);
      setSubmittedShotId(selectedShot.id);
      setAspectIssue(null);
      setShowPreview(false);
    } catch (submitError) {
      const apiError = submitError as ApiRequestError;
      if (apiError.status === 409 && apiError.data?.code === 'ASPECT_UNSUPPORTED') {
        setAspectIssue({
          projectAspect: String(apiError.data.projectAspect || projectAspect),
          supportedAspectRatios: Array.isArray(apiError.data.supportedAspectRatios)
            ? apiError.data.supportedAspectRatios.map(String)
            : selectedCapability.aspectRatios,
        });
      } else {
        setError(apiError.message || '视频生成提交失败');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-6 text-sm text-slate-400" role="status">正在加载 Video Lab…</div>;
  }

  const canSubmit = Boolean(
    selectedShot?.id
    && selectedCapability?.configured
    && supportedModes.length
    && durationSec !== undefined
    && resolution
    && fps !== undefined
    && motionPrompt.subjectScene.trim(),
  );
  const targetAspect = aspectIssue?.supportedAspectRatios[0];
  const progress = typeof task?.progress === 'number' && Number.isFinite(task.progress)
    ? Math.max(0, Math.min(100, task.progress))
    : null;

  return (
    <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-slate-200 shadow-xl sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-violet-400">Video Lab · M1</p>
          <h2 className="mt-1 text-base font-bold text-white">单镜头视频生成</h2>
          <p className="mt-1 text-xs text-slate-500">参数按 Provider 能力展示；视频只有本地落盘后才可预览。</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-right">
          <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">项目画幅</p>
          <p className="mt-0.5 font-mono text-sm text-white">{projectAspect || '未知'}</p>
          <p className="text-[9px] text-slate-500">继承风格契约</p>
        </div>
      </header>

      {error && <div className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200" role="alert">{error}</div>}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">镜头</span>
          <select
            value={selectedShotId}
            onChange={event => setSelectedShotId(event.target.value)}
            className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200 outline-none focus:border-violet-500"
          >
            {selectableShots.length === 0 && <option value="">暂无带 ID 的镜头</option>}
            {selectableShots.map((shot, index) => (
              <option key={shot.id} value={shot.id}>
                #{index + 1} {(shot.description || '未命名镜头').slice(0, 52)}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1.5">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Provider</span>
          <select
            value={providerId}
            onChange={event => setProviderId(event.target.value)}
            className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200 outline-none focus:border-violet-500"
          >
            {providers.length === 0 && <option value="">暂无 Provider</option>}
            {providers.map(provider => (
              <option key={provider.id} value={provider.id} disabled={!provider.configured}>
                {provider.label}{provider.configured ? '' : '（未配置）'}
              </option>
            ))}
          </select>
          {selectedCapability && !selectedCapability.configured && (
            <p className="text-[10px] text-amber-400">该 Provider 未配置，暂不可提交。</p>
          )}
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[10px] font-bold uppercase tracking-widest text-slate-500">生成模式</legend>
        <div className="flex flex-wrap gap-2">
          {supportedModes.map(option => (
            <button
              key={option.id}
              type="button"
              aria-pressed={mode === option.id}
              onClick={() => setMode(option.id)}
              className={`min-h-9 rounded-full border px-4 py-1.5 text-xs font-semibold ${
                mode === option.id
                  ? 'border-violet-400 bg-violet-500/20 text-violet-200'
                  : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500'
              }`}
            >
              {option.label}
            </button>
          ))}
          {supportedModes.length === 0 && <p className="text-xs text-amber-400">当前 Provider 未声明可用生成模式。</p>}
        </div>
      </fieldset>

      {selectedCapability && (
        <div className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/45 p-4 lg:grid-cols-3">
          <ChoiceButtons label="时长（秒）" value={durationSec} choices={selectedCapability.durations} onChange={setDurationSec} />
          <ChoiceButtons label="分辨率" value={resolution} choices={selectedCapability.resolutions} onChange={setResolution} />
          <ChoiceButtons label="FPS" value={fps} choices={selectedCapability.fpsOptions} onChange={setFps} />
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-[10px] font-bold uppercase tracking-widest text-slate-500">运动强度</legend>
        <div className="grid grid-cols-3 gap-2 sm:max-w-md">
          {STRENGTHS.map(option => (
            <button
              key={option.id}
              type="button"
              aria-pressed={motionStrength === option.id}
              onClick={() => setMotionStrength(option.id)}
              className={`min-h-10 rounded-lg border text-xs font-semibold ${
                motionStrength === option.id
                  ? 'border-violet-400 bg-violet-500/20 text-violet-200'
                  : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="space-y-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Motion Prompt · 六段式</p>
          <p className="mt-1 text-[10px] text-slate-600">独立于图片提示词；预填只是起点，提交前可继续编辑。</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {PROMPT_FIELDS.map(field => (
            <label key={field.id} className="space-y-1.5">
              <span className="flex min-h-6 items-center justify-between gap-2 text-[10px] font-semibold text-slate-400">
                {field.label}
                {field.id === 'subjectScene' && (
                  <button
                    type="button"
                    onClick={() => updateMotionPrompt('subjectScene', selectedShot?.optimizedPrompt || '')}
                    disabled={!selectedShot?.optimizedPrompt}
                    className="rounded border border-slate-700 px-2 py-1 text-[9px] text-violet-300 hover:border-violet-500 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    从 optimizedPrompt 预填
                  </button>
                )}
                {field.id === 'cameraMove' && (
                  <button
                    type="button"
                    onClick={() => updateMotionPrompt('cameraMove', selectedShot?.cameraPromptUsed || '')}
                    disabled={!selectedShot?.cameraPromptUsed}
                    className="rounded border border-slate-700 px-2 py-1 text-[9px] text-violet-300 hover:border-violet-500 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    从机位指令预填
                  </button>
                )}
              </span>
              <textarea
                value={motionPrompt[field.id]}
                onChange={event => updateMotionPrompt(field.id, event.target.value)}
                rows={3}
                placeholder={field.placeholder}
                className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs leading-relaxed text-slate-200 outline-none placeholder:text-slate-700 focus:border-violet-500"
              />
            </label>
          ))}
        </div>
      </div>

      <details className="rounded-xl border border-slate-800 bg-slate-900/40">
        <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-300">高级设置</summary>
        <div className="grid gap-4 border-t border-slate-800 p-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Seed（留空随机）</span>
            <input
              type="number"
              min="0"
              step="1"
              value={seed}
              onChange={event => setSeed(event.target.value)}
              className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 outline-none focus:border-violet-500"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Negative Prompt</span>
            <textarea
              value={negativePrompt}
              onChange={event => setNegativePrompt(event.target.value)}
              rows={3}
              placeholder="不希望出现的内容或变化。"
              className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-700 focus:border-violet-500"
            />
          </label>
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div>
          <p className="text-xs font-semibold text-white">项目画幅 {projectAspect || '未知'}（继承风格契约）</p>
          <p className="mt-1 text-[10px] text-slate-500">若当前模型不支持，将要求你明确选择裁切、留边或更换模型。</p>
        </div>
        <button
          type="button"
          disabled={!canSubmit || submitting}
          onClick={() => void submit()}
          className="min-h-11 rounded-lg bg-violet-600 px-6 py-2 text-xs font-bold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-600"
        >
          {submitting ? '正在提交…' : '生成当前镜头'}
        </button>
      </div>

      {task && (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/55 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">当前任务</p>
              <p className="mt-1 font-mono text-xs text-slate-300">{taskId}</p>
            </div>
            <span className={`rounded-full border px-3 py-1 text-[10px] font-bold ${
              task.status === 'completed' && task.local_path
                ? 'border-emerald-700 bg-emerald-950/40 text-emerald-300'
                : task.status === 'failed' || task.download_error
                  ? 'border-red-800 bg-red-950/40 text-red-300'
                  : 'border-amber-700 bg-amber-950/35 text-amber-300'
            }`}>
              {task.status === 'completed' && task.local_path
                ? '已落盘'
                : task.status === 'completed' && task.download_error
                  ? '下载失败'
                  : task.status === 'completed'
                    ? '等待本地落盘'
                    : task.status === 'in_progress'
                      ? '生成中'
                      : task.status === 'failed' ? '失败' : '排队中'}
            </span>
          </div>

          {progress !== null && !task.local_path && !task.download_error && task.status !== 'failed' && (
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full rounded-full bg-violet-500 transition-[width]" style={{ width: `${progress}%` }} />
              </div>
              <p className="mt-1 text-right font-mono text-[9px] text-slate-600">{Math.round(progress)}%</p>
            </div>
          )}

          {task.status === 'completed' && !task.local_path && !task.download_error && !pollError && (
            <p className="text-xs text-amber-300" role="status">Provider 已完成，正在等待服务端下载到本地…</p>
          )}
          {task.status === 'failed' && (
            <p className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200" role="alert">{task.error || '视频生成失败'}</p>
          )}
          {task.status === 'completed' && task.download_error && (
            <div className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200" role="alert">
              <p className="font-semibold">视频生成完成，但下载到本地失败。</p>
              <p className="mt-1 break-words font-mono text-[10px] text-red-300/90">{task.download_error}</p>
            </div>
          )}
          {pollError && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200" role="alert">
              <span>{pollError}</span>
              <button
                type="button"
                onClick={() => setPollNonce(value => value + 1)}
                className="rounded border border-red-700 px-2 py-1 text-[10px] hover:bg-red-900/40"
              >
                重新检查
              </button>
            </div>
          )}
          {task.status === 'completed' && task.local_path && (
            <button
              type="button"
              onClick={() => setShowPreview(true)}
              className="min-h-10 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500"
            >
              ▶ 用 AnimaticPlayer 预览
            </button>
          )}

          {snapshot && (
            <details className="rounded-lg border border-slate-800 bg-slate-950/60">
              <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold text-slate-400">本次生成参数快照</summary>
              <pre className="max-h-80 overflow-auto border-t border-slate-800 p-3 text-[10px] leading-relaxed text-slate-400">{JSON.stringify(snapshot, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      {aspectIssue && (
        <div className="fixed inset-0 z-[135] flex items-center justify-center bg-black/85 p-4" role="dialog" aria-modal="true" aria-label="画幅不兼容">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400">画幅不兼容</p>
              <h3 className="mt-1 text-base font-bold text-white">当前模型不支持项目画幅</h3>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-300">
              <p>项目画幅：<b className="font-mono text-white">{aspectIssue.projectAspect}</b></p>
              <p className="mt-1">当前模型仅支持：<b className="font-mono text-white">{aspectIssue.supportedAspectRatios.join(' / ') || '无'}</b></p>
            </div>
            <div className="space-y-2">
              <button
                type="button"
                disabled={!alternativeProvider}
                onClick={() => {
                  if (!alternativeProvider) return;
                  setProviderId(alternativeProvider.id);
                  setAspectIssue(null);
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-left text-xs font-semibold text-slate-200 hover:border-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                更换模型
                <span className="mt-1 block text-[10px] font-normal text-slate-500">
                  {alternativeProvider ? `切换到 ${alternativeProvider.label}` : `当前无支持 ${aspectIssue.projectAspect} 的模型`}
                </span>
              </button>
              <button
                type="button"
                disabled={!targetAspect || submitting}
                onClick={() => targetAspect && void submit({ aspectRatio: targetAspect, adaptMode: 'crop' })}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-left text-xs font-semibold text-slate-200 hover:border-violet-500 disabled:opacity-40"
              >
                使用裁切适配
                <span className="mt-1 block text-[10px] font-normal text-slate-500">明确裁切到 {targetAspect || '可用画幅'}</span>
              </button>
              <button
                type="button"
                disabled={!targetAspect || submitting}
                onClick={() => targetAspect && void submit({ aspectRatio: targetAspect, adaptMode: 'letterbox' })}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-left text-xs font-semibold text-slate-200 hover:border-violet-500 disabled:opacity-40"
              >
                使用留边适配
                <span className="mt-1 block text-[10px] font-normal text-slate-500">保留完整画面并适配到 {targetAspect || '可用画幅'}</span>
              </button>
            </div>
            <button type="button" onClick={() => setAspectIssue(null)} className="w-full rounded-lg border border-slate-700 py-2 text-xs text-slate-400 hover:bg-slate-800">取消</button>
          </div>
        </div>
      )}

      {showPreview && previewItems.length > 0 && (
        <AnimaticPlayer items={previewItems} activeShotId={submittedShotId} onClose={() => setShowPreview(false)} />
      )}
    </section>
  );
}
