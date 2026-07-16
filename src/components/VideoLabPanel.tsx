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
  id: string;
  shot_id?: string | null;
  provider?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress?: number | null;
  error?: string | null;
  local_path?: string | null;
  download_error?: string | null;
  seed?: number | null;
  num_frames?: number | null;
  frame_rate?: number | null;
  normalized_seconds?: number | null;
  generation_snapshot_json?: string | null;
  created_at?: string | null;
};

type AspectIssue = {
  projectAspect: string;
  supportedAspectRatios: string[];
};

type BatchResult = {
  submitted: Array<{ shotId: string; taskId: string }>;
  failed: Array<{ shotId: string; error: string }>;
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

const FINAL_VIDEO_ERROR_MESSAGES: Record<string, string> = {
  TAKE_NOT_FOUND: '该 Take 已不存在，请刷新历史列表后重试。',
  TAKE_SHOT_MISMATCH: '该 Take 不属于当前镜头，不能定稿。',
  TAKE_NOT_COMPLETED: '该 Take 尚未生成完成，不能定稿。',
  TAKE_NOT_DOWNLOADED: '该 Take 尚未完成本地落盘，不能定稿。',
  TAKE_FILE_MISSING: '该 Take 的本地文件缺失或不可读，不能定稿。',
};

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

function taskStatusLabel(task: VideoTaskRecord): string {
  if (task.status === 'completed' && task.local_path) return '已落盘';
  if (task.status === 'completed' && task.download_error) return '下载失败';
  if (task.status === 'completed') return '等待本地落盘';
  if (task.status === 'in_progress') return '生成中';
  if (task.status === 'failed') return '失败';
  return '排队中';
}

function taskStatusClass(task: VideoTaskRecord): string {
  if (task.status === 'completed' && task.local_path) {
    return 'border-emerald-700 bg-emerald-950/40 text-emerald-300';
  }
  if (task.status === 'failed' || task.download_error) {
    return 'border-red-800 bg-red-950/40 text-red-300';
  }
  return 'border-amber-700 bg-amber-950/35 text-amber-300';
}

function taskDurationSec(task: VideoTaskRecord): number | null {
  if (task.generation_snapshot_json) {
    try {
      const snapshot = JSON.parse(task.generation_snapshot_json);
      const duration = Number(snapshot?.parameters?.durationSec);
      if (Number.isFinite(duration) && duration > 0) return duration;
    } catch {
      // Old rows may not have a valid M1 snapshot; fall through to frame mapping.
    }
  }
  const frameDurations: Record<number, number> = { 81: 3, 121: 5, 241: 10, 441: 18 };
  return task.num_frames && frameDurations[task.num_frames] ? frameDurations[task.num_frames] : null;
}

function formatTaskTime(value?: string | null): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
  const [aspectRetryTarget, setAspectRetryTarget] = useState<'single' | 'batch'>('single');
  const [showPreview, setShowPreview] = useState(false);
  const [takes, setTakes] = useState<VideoTaskRecord[]>([]);
  const [takesLoading, setTakesLoading] = useState(false);
  const [takesError, setTakesError] = useState('');
  const [takeRefreshNonce, setTakeRefreshNonce] = useState(0);
  const [compareTaskIds, setCompareTaskIds] = useState<string[]>([]);
  const [compareError, setCompareError] = useState('');
  const [finalVideoTaskIds, setFinalVideoTaskIds] = useState<Record<string, string | undefined>>({});
  const [finalizingTaskId, setFinalizingTaskId] = useState<string | null>(null);
  const [batchShotIds, setBatchShotIds] = useState<string[]>([]);
  const [batchGateOpen, setBatchGateOpen] = useState(false);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);

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
  const compareTakes = useMemo(
    () => compareTaskIds
      .map(id => takes.find(take => take.id === id))
      .filter((take): take is VideoTaskRecord => Boolean(take?.local_path)),
    [compareTaskIds, takes],
  );
  const shotSelectionSignature = selectableShots
    .map(shot => `${shot.id}:${shot.finalVideoTaskId || ''}`)
    .join('|');

  useEffect(() => {
    if (selectableShots.some(shot => shot.id === selectedShotId)) return;
    setSelectedShotId(selectableShots[0]?.id || '');
  }, [selectableShots, selectedShotId]);

  useEffect(() => {
    const nextFinalIds: Record<string, string | undefined> = {};
    const nextBatchShotIds: string[] = [];
    for (const shot of selectableShots) {
      if (!shot.id) continue;
      nextFinalIds[shot.id] = shot.finalVideoTaskId;
      if (!shot.finalVideoTaskId) nextBatchShotIds.push(shot.id);
    }
    setFinalVideoTaskIds(nextFinalIds);
    setBatchShotIds(nextBatchShotIds);
    setBatchResult(null);
    setBatchError('');
  // Reset only when project/shot identity or persisted gold-take state changes.
  }, [projectId, shotSelectionSignature]);

  useEffect(() => {
    setTakes([]);
    setCompareTaskIds([]);
    setCompareError('');
  }, [projectId, selectedShotId]);

  useEffect(() => {
    if (!selectedShotId) {
      setTakes([]);
      setCompareTaskIds([]);
      return;
    }
    const controller = new AbortController();
    setTakesLoading(true);
    setTakesError('');
    void fetch(
      `/api/video-lab/shots/${encodeURIComponent(selectedShotId)}/tasks?projectId=${encodeURIComponent(projectId)}`,
      { signal: controller.signal },
    ).then(readJson).then(data => {
      const nextTakes = Array.isArray(data.tasks) ? data.tasks as VideoTaskRecord[] : [];
      setTakes(nextTakes);
      setCompareTaskIds(current => current.filter(id => nextTakes.some(take => take.id === id && take.local_path)));
    }).catch(loadError => {
      if ((loadError as Error).name !== 'AbortError') {
        setTakesError((loadError as Error).message || 'Take 历史加载失败');
      }
    }).finally(() => {
      if (!controller.signal.aborted) setTakesLoading(false);
    });
    return () => controller.abort();
  }, [projectId, selectedShotId, takeRefreshNonce]);

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

        if (nextTask.status === 'failed') {
          setTakeRefreshNonce(value => value + 1);
          return;
        }
        if (nextTask.status === 'completed') {
          if (nextTask.local_path || nextTask.download_error) {
            setTakeRefreshNonce(value => value + 1);
            return;
          }
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
      setAspectRetryTarget('single');
      setShowPreview(false);
      setTakeRefreshNonce(value => value + 1);
    } catch (submitError) {
      const apiError = submitError as ApiRequestError;
      if (apiError.status === 409 && apiError.data?.code === 'ASPECT_UNSUPPORTED') {
        setAspectRetryTarget('single');
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

  const toggleCompareTake = (taskIdToToggle: string) => {
    setCompareError('');
    setCompareTaskIds(current => {
      if (current.includes(taskIdToToggle)) return current.filter(id => id !== taskIdToToggle);
      if (current.length >= 3) {
        setCompareError('最多同时对比 3 个已落盘 Take。');
        return current;
      }
      return [...current, taskIdToToggle];
    });
  };

  const updateFinalVideo = async (shotId: string, nextTaskId: string | null) => {
    setFinalizingTaskId(nextTaskId || '__clear__');
    setTakesError('');
    try {
      const data = await readJson(await fetch(
        `/api/video-lab/shots/${encodeURIComponent(shotId)}/final-video?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: nextTaskId }),
        },
      ));
      const persistedTaskId = typeof data.shot?.finalVideoTaskId === 'string'
        ? data.shot.finalVideoTaskId
        : undefined;
      setFinalVideoTaskIds(current => ({ ...current, [shotId]: persistedTaskId }));
      setBatchShotIds(current => persistedTaskId
        ? current.filter(id => id !== shotId)
        : current.includes(shotId) ? current : [...current, shotId]);
    } catch (finalizeError) {
      const apiError = finalizeError as ApiRequestError;
      const code = String(apiError.data?.code || '');
      const mapped = FINAL_VIDEO_ERROR_MESSAGES[code];
      const downloadDetail = code === 'TAKE_NOT_DOWNLOADED' && apiError.data?.download_error
        ? ` 下载错误：${String(apiError.data.download_error)}`
        : '';
      setTakesError(`${mapped || apiError.message || '定稿失败'}${downloadDetail}`);
    } finally {
      setFinalizingTaskId(null);
    }
  };

  const toggleBatchShot = (shotId: string) => {
    setBatchError('');
    setBatchShotIds(current => current.includes(shotId)
      ? current.filter(id => id !== shotId)
      : current.length >= 100 ? current : [...current, shotId]);
  };

  const submitBatch = async (aspectDecision?: { aspectRatio: string; adaptMode: AdaptMode }) => {
    if (!selectedCapability || durationSec === undefined || resolution === undefined || fps === undefined || batchShotIds.length === 0) return;
    setBatchGateOpen(false);
    setBatchSubmitting(true);
    setBatchError('');
    setBatchResult(null);
    try {
      const response = await fetch('/api/video-lab/batch-shot-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          shotIds: batchShotIds,
          provider: selectedCapability.id,
          durationSec,
          fps,
          resolution,
          motionStrength,
          ...(negativePrompt.trim() ? { negativePrompt: negativePrompt.trim() } : {}),
          ...(aspectDecision ? { aspectDecision } : {}),
          confirmed: true,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 502 && Array.isArray(data.submitted) && Array.isArray(data.failed)) {
          setBatchResult(data as BatchResult);
          setBatchError('本批次全部提交失败；任务行与错误信息已保留。');
          setTakeRefreshNonce(value => value + 1);
          return;
        }
        throw new ApiRequestError(apiErrorMessage(data, response.status), response.status, data);
      }
      setBatchResult(data as BatchResult);
      setAspectIssue(null);
      setTakeRefreshNonce(value => value + 1);
    } catch (submitError) {
      const apiError = submitError as ApiRequestError;
      if (apiError.status === 409 && apiError.data?.code === 'ASPECT_UNSUPPORTED') {
        setAspectRetryTarget('batch');
        setAspectIssue({
          projectAspect: String(apiError.data.projectAspect || projectAspect),
          supportedAspectRatios: Array.isArray(apiError.data.supportedAspectRatios)
            ? apiError.data.supportedAspectRatios.map(String)
            : selectedCapability.aspectRatios,
        });
      } else {
        setBatchError(apiError.message || '批量视频生成提交失败');
      }
    } finally {
      setBatchSubmitting(false);
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
  const canBatch = Boolean(
    selectedCapability?.configured
    && durationSec !== undefined
    && resolution
    && fps !== undefined
    && batchShotIds.length > 0
    && batchShotIds.length <= 100,
  );
  const batchOutputSeconds = batchShotIds.length * (durationSec || 0);
  const batchEstimatedRuntimeSeconds = batchShotIds.length * 70;
  const selectedFinalTaskId = selectedShotId ? finalVideoTaskIds[selectedShotId] : undefined;
  const targetAspect = aspectIssue?.supportedAspectRatios[0];
  const progress = typeof task?.progress === 'number' && Number.isFinite(task.progress)
    ? Math.max(0, Math.min(100, task.progress))
    : null;

  return (
    <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-slate-200 shadow-xl sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-violet-400">Video Lab · M2</p>
          <h2 className="mt-1 text-base font-bold text-white">多 Take · 定稿 · 批量生成</h2>
          <p className="mt-1 text-xs text-slate-500">保留 M1 单镜生成；视频只有本地落盘且文件可读后才可定稿。</p>
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
            <span className={`rounded-full border px-3 py-1 text-[10px] font-bold ${taskStatusClass(task)}`}>
              {taskStatusLabel(task)}
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

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/35 p-4" aria-label="历史 Take 与对比">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-400">当前镜头 · 历史 Take</p>
            <p className="mt-1 text-xs text-slate-500">按创建时间倒序；最多选择 3 个已落盘 Take 并排对比。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedFinalTaskId && (
              <button
                type="button"
                disabled={finalizingTaskId !== null}
                onClick={() => selectedShotId && void updateFinalVideo(selectedShotId, null)}
                className="rounded-lg border border-amber-700 px-3 py-2 text-[10px] font-semibold text-amber-300 hover:bg-amber-950/40 disabled:opacity-40"
              >
                {finalizingTaskId === '__clear__' ? '正在取消…' : '取消当前定稿'}
              </button>
            )}
            <button
              type="button"
              disabled={!selectedShotId || takesLoading}
              onClick={() => setTakeRefreshNonce(value => value + 1)}
              className="rounded-lg border border-slate-700 px-3 py-2 text-[10px] font-semibold text-slate-300 hover:border-slate-500 disabled:opacity-40"
            >
              刷新 Take
            </button>
          </div>
        </div>

        {takesError && <p className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200" role="alert">{takesError}</p>}
        {takesLoading && <p className="text-xs text-slate-500" role="status">正在加载 Take 历史…</p>}
        {!takesLoading && takes.length === 0 && !takesError && (
          <p className="rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center text-xs text-slate-600">当前镜头还没有视频 Take。</p>
        )}

        {takes.length > 0 && (
          <div className="space-y-2">
            {takes.map((take, index) => {
              const duration = taskDurationSec(take);
              const isGold = selectedFinalTaskId === take.id;
              const canUseLocalTake = take.status === 'completed' && Boolean(take.local_path) && !take.download_error;
              return (
                <article key={take.id} className={`rounded-lg border p-3 ${isGold ? 'border-amber-500/70 bg-amber-950/20' : 'border-slate-800 bg-slate-950/55'}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold text-white">Take {takes.length - index}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold ${taskStatusClass(take)}`}>{taskStatusLabel(take)}</span>
                        {isGold && <span className="rounded-full border border-amber-500 bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold text-amber-300">★ 当前定稿</span>}
                      </div>
                      <p className="mt-1 break-all font-mono text-[9px] text-slate-600">{take.id}</p>
                      <p className="mt-1 text-[10px] text-slate-500">
                        {formatTaskTime(take.created_at)} · Seed {take.seed ?? '未知'} · {duration ? `${duration}s` : '时长未知'}
                      </p>
                    </div>
                    {canUseLocalTake && (
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-slate-700 px-3 text-[10px] text-slate-300 hover:border-cyan-600">
                          <input
                            type="checkbox"
                            checked={compareTaskIds.includes(take.id)}
                            onChange={() => toggleCompareTake(take.id)}
                            className="accent-cyan-500"
                          />
                          对比
                        </label>
                        {!isGold && (
                          <button
                            type="button"
                            disabled={finalizingTaskId !== null}
                            onClick={() => selectedShotId && void updateFinalVideo(selectedShotId, take.id)}
                            className="min-h-9 rounded-lg bg-amber-600 px-3 text-[10px] font-bold text-white hover:bg-amber-500 disabled:opacity-40"
                          >
                            {finalizingTaskId === take.id ? '正在定稿…' : '设为定稿'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {take.download_error && (
                    <div className="mt-2 rounded border border-red-900/70 bg-red-950/30 px-3 py-2 text-[10px] text-red-200" role="alert">
                      <p className="font-semibold">下载失败，不能对比或定稿。</p>
                      <p className="mt-1 break-words font-mono text-red-300/90">{take.download_error}</p>
                    </div>
                  )}
                  {take.status === 'failed' && take.error && (
                    <p className="mt-2 break-words text-[10px] text-red-300">{take.error}</p>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {compareError && <p className="text-xs text-amber-300" role="alert">{compareError}</p>}
        {compareTakes.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Take 并排对比">
            {compareTakes.map(take => (
              <figure key={take.id} className="overflow-hidden rounded-lg border border-cyan-900/70 bg-black">
                <video
                  src={take.local_path || undefined}
                  controls
                  muted
                  loop
                  playsInline
                  className="aspect-video w-full bg-black object-contain"
                />
                <figcaption className="border-t border-slate-800 px-3 py-2 text-[9px] text-slate-400">
                  <span className="block font-mono">{take.id}</span>
                  <span className="mt-1 block text-slate-500">Seed {take.seed ?? '未知'} · {formatTaskTime(take.created_at)}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-violet-900/60 bg-violet-950/10 p-4" aria-label="批量生成">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-violet-400">批量生成</p>
            <h3 className="mt-1 text-sm font-bold text-white">为多个镜头各建一个独立任务</h3>
            <p className="mt-1 text-[10px] text-slate-500">默认选择尚未定稿的镜头；复用上方 Provider、时长、分辨率、FPS、运动强度与 Negative Prompt。</p>
          </div>
          <span className="rounded-full border border-violet-800 bg-violet-950/40 px-3 py-1 text-[10px] font-bold text-violet-300">已选 {batchShotIds.length} / 100</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setBatchShotIds(selectableShots.filter(shot => shot.id && !finalVideoTaskIds[shot.id]).map(shot => shot.id as string).slice(0, 100))}
            className="rounded border border-slate-700 px-3 py-1.5 text-[10px] text-slate-300 hover:border-violet-500"
          >
            选择未定稿
          </button>
          <button
            type="button"
            onClick={() => setBatchShotIds(selectableShots.map(shot => shot.id as string).slice(0, 100))}
            className="rounded border border-slate-700 px-3 py-1.5 text-[10px] text-slate-300 hover:border-violet-500"
          >
            全选（最多 100）
          </button>
          <button type="button" onClick={() => setBatchShotIds([])} className="rounded border border-slate-700 px-3 py-1.5 text-[10px] text-slate-400 hover:border-slate-500">清空</button>
        </div>

        <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
          {selectableShots.map((shot, index) => shot.id && (
            <label key={shot.id} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-xs ${batchShotIds.includes(shot.id) ? 'border-violet-600 bg-violet-950/30 text-slate-200' : 'border-slate-800 bg-slate-950/45 text-slate-500'}`}>
              <input type="checkbox" checked={batchShotIds.includes(shot.id)} onChange={() => toggleBatchShot(shot.id as string)} className="mt-0.5 accent-violet-500" />
              <span className="min-w-0">
                <span className="block font-semibold">#{index + 1} {finalVideoTaskIds[shot.id] ? '★ 已定稿' : '未定稿'}</span>
                <span className="mt-1 block truncate text-[9px] opacity-70">{shot.description || shot.id}</span>
              </span>
            </label>
          ))}
        </div>

        {batchError && <p className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs text-red-200" role="alert">{batchError}</p>}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
          <div className="text-[10px] text-slate-500">
            <p>当前参数：{selectedCapability?.label || '未选 Provider'} · {durationSec ?? '-'}s · {resolution || '-'} · {fps ?? '-'} FPS</p>
            <p className="mt-1">每个镜头使用 optimizedPrompt（缺失时 description）+ cameraPromptUsed，seed 各自随机。</p>
          </div>
          <button
            type="button"
            disabled={!canBatch || batchSubmitting}
            onClick={() => setBatchGateOpen(true)}
            className="min-h-11 rounded-lg bg-violet-600 px-5 py-2 text-xs font-bold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-600"
          >
            {batchSubmitting ? '批量提交中…' : '核对成本并生成'}
          </button>
        </div>

        {batchResult && (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-emerald-900/70 bg-emerald-950/20 p-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">已提交 {batchResult.submitted.length}</p>
              <div className="mt-2 space-y-1">
                {batchResult.submitted.map(item => (
                  <button key={`${item.shotId}:${item.taskId}`} type="button" onClick={() => setSelectedShotId(item.shotId)} className="block w-full rounded border border-emerald-900/70 px-2 py-1.5 text-left font-mono text-[9px] text-emerald-200 hover:bg-emerald-950/40">
                    {item.shotId} → {item.taskId}
                  </button>
                ))}
                {batchResult.submitted.length === 0 && <p className="text-[10px] text-slate-600">无</p>}
              </div>
            </div>
            <div className="rounded-lg border border-red-900/70 bg-red-950/20 p-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-red-400">提交失败 {batchResult.failed.length}</p>
              <div className="mt-2 space-y-1">
                {batchResult.failed.map(item => (
                  <button key={`${item.shotId}:${item.error}`} type="button" onClick={() => setSelectedShotId(item.shotId)} className="block w-full rounded border border-red-900/70 px-2 py-1.5 text-left text-[9px] text-red-200 hover:bg-red-950/40">
                    <span className="block font-mono">{item.shotId}</span>
                    <span className="mt-0.5 block break-words opacity-80">{item.error}</span>
                  </button>
                ))}
                {batchResult.failed.length === 0 && <p className="text-[10px] text-slate-600">无</p>}
              </div>
            </div>
          </div>
        )}
      </section>

      {batchGateOpen && selectedCapability && (
        <div className="fixed inset-0 z-[134] flex items-center justify-center bg-black/85 p-4" role="dialog" aria-modal="true" aria-label="确认批量生成成本">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-violet-800 bg-slate-900 p-5 shadow-2xl">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-violet-400">成本确认门</p>
              <h3 className="mt-1 text-base font-bold text-white">确认提交本批次？</h3>
            </div>
            <dl className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs">
              <div className="flex justify-between gap-4"><dt className="text-slate-500">镜头数量</dt><dd className="font-mono text-white">{batchShotIds.length}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-slate-500">预计生成任务</dt><dd className="font-mono text-white">{batchShotIds.length}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-slate-500">总输出时长</dt><dd className="font-mono text-white">{batchOutputSeconds} 秒</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-slate-500">估算运行时间</dt><dd className="font-mono text-white">{batchEstimatedRuntimeSeconds} 秒（{batchShotIds.length} × 70）</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-slate-500">Provider</dt><dd className="text-right text-white">{selectedCapability.label}</dd></div>
              <div className="border-t border-slate-800 pt-2"><dt className="text-slate-500">预计费用</dt><dd className="mt-1 text-amber-300">费用由 {selectedCapability.label} 的 Provider 实际计费；本界面不虚构单价。</dd></div>
            </dl>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setBatchGateOpen(false)} className="min-h-11 rounded-lg border border-slate-700 text-xs font-semibold text-slate-300 hover:bg-slate-800">返回修改</button>
              <button type="button" onClick={() => void submitBatch()} className="min-h-11 rounded-lg bg-violet-600 text-xs font-bold text-white hover:bg-violet-500">确认并提交</button>
            </div>
          </div>
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
                disabled={!targetAspect || submitting || batchSubmitting}
                onClick={() => {
                  if (!targetAspect) return;
                  const decision = { aspectRatio: targetAspect, adaptMode: 'crop' as const };
                  if (aspectRetryTarget === 'batch') void submitBatch(decision);
                  else void submit(decision);
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-left text-xs font-semibold text-slate-200 hover:border-violet-500 disabled:opacity-40"
              >
                使用裁切适配
                <span className="mt-1 block text-[10px] font-normal text-slate-500">明确裁切到 {targetAspect || '可用画幅'}</span>
              </button>
              <button
                type="button"
                disabled={!targetAspect || submitting || batchSubmitting}
                onClick={() => {
                  if (!targetAspect) return;
                  const decision = { aspectRatio: targetAspect, adaptMode: 'letterbox' as const };
                  if (aspectRetryTarget === 'batch') void submitBatch(decision);
                  else void submit(decision);
                }}
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
