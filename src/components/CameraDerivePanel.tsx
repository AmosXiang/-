// 机位派生面板:三下拉框(方位/俯仰/景别)落库、主帧单选标记、单镜头派生、
// 整场批量派生(preflight 弹窗,同现有批量确认模式)。自包含组件,App.tsx 仅需
// 一处挂载,避免与 UI 重构任务改动同一渲染区域。
import { useState } from 'react';
import type { Shot } from '../types';
import {
  CAMERA_H_KEYS,
  CAMERA_V_KEYS,
  CAMERA_ZOOM_KEYS,
  isLargeAngleFromFront,
  isCameraH,
  LARGE_ANGLE_WARNING,
} from '../../server/constants/cameraVocab';

const H_LABELS: Record<string, string> = {
  front: '正面 0°', front_right: '右前 45°', right: '右侧 90°', back_right: '右后 135°',
  back: '背面 180°', back_left: '左后 135°', left: '左侧 90°', front_left: '左前 45°',
};
const V_LABELS: Record<string, string> = {
  low: '低角度仰拍', eye: '平视', elevated: '略高俯视', high: '高角度俯拍',
};
const ZOOM_LABELS: Record<string, string> = {
  close_up: '特写', medium_cu: '中近景', medium: '中景', full: '全景', wide: '远景',
};

interface BatchPreflight {
  masterShotLabel: string;
  total: number;
  missingParams: Array<{ shotId: string; shotLabel: string; missing: string[] }>;
  largeAngleWarnings: Array<{ shotId: string; shotLabel: string; cameraH: string; warning: string }>;
}

export default function CameraDerivePanel({
  projectId,
  shots,
  shotIndex,
  onShotsChange,
}: {
  projectId: string;
  shots: Shot[];
  shotIndex: number;
  onShotsChange: (nextShots: Shot[]) => void;
}) {
  const shot = shots[shotIndex];
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [preflight, setPreflight] = useState<BatchPreflight | null>(null);

  if (!shot) return null;
  const shotId = String(shot.id || '');
  const master = shots.find(item => item.isMaster === true) || null;
  const masterIndex = master ? shots.findIndex(item => String(item.id) === String(master.id)) : -1;
  const masterHasImage = !!(master && (master.generatedImageUrl || master.imageUrl));
  const paramsComplete = !!(shot.cameraH && shot.cameraV && shot.cameraZoom);
  const derivedFromIndex = shot.derivedFromShotId
    ? shots.findIndex(item => String(item.id) === String(shot.derivedFromShotId))
    : -1;

  const patchLocalShot = (id: string, patch: Partial<Shot>) => {
    onShotsChange(shots.map(item => (String(item.id) === id ? { ...item, ...patch } : item)));
  };

  const saveCameraParam = async (field: 'cameraH' | 'cameraV' | 'cameraZoom', value: string) => {
    setMessage(null);
    const body = { [field]: value || null };
    patchLocalShot(shotId, { [field]: (value || undefined) } as Partial<Shot>);
    const res = await fetch(`/api/generated-scripts/${projectId}/shots/${shotId}/camera`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setMessage({ kind: 'err', text: data.error || `保存机位参数失败 (HTTP ${res.status})` });
  };

  const setMaster = async () => {
    const switching = master && String(master.id) !== shotId;
    const confirmText = shot.isMaster
      ? `取消镜头 #${shotIndex + 1} 的主帧标记?`
      : switching
        ? `本场主帧将从 #${masterIndex + 1} 切换为 #${shotIndex + 1},已有派生记录保留原来源标注。确认切换?`
        : `将镜头 #${shotIndex + 1} 设为本场主帧?其余镜头将从它派生机位。`;
    if (!window.confirm(confirmText)) return;
    setMessage(null);
    const res = await fetch(`/api/generated-scripts/${projectId}/shots/${shotId}/master`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isMaster: !shot.isMaster }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setMessage({ kind: 'err', text: data.error || `设置主帧失败 (HTTP ${res.status})` });
    const flags = new Map<string, boolean>((data.shots || []).map((item: any) => [String(item.id), !!item.isMaster] as [string, boolean]));
    onShotsChange(shots.map(item => ({ ...item, isMaster: flags.get(String(item.id)) ?? false })));
  };

  const deriveSingle = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/generated-scripts/${projectId}/shots/${shotId}/camera-derive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cameraH: shot.cameraH, cameraV: shot.cameraV, cameraZoom: shot.cameraZoom }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 透传服务端原始错误文本(含 ComfyUI 错误),不吞错。
        setMessage({ kind: 'err', text: data.error || `派生请求失败 (HTTP ${res.status})` });
        return;
      }
      patchLocalShot(shotId, { derivedFromShotId: data.derivedFromShotId, cameraPromptUsed: data.cameraPromptUsed });
      setMessage({
        kind: 'ok',
        text: `已入队派生任务 ${String(data.taskId).slice(0, 8)}…(seed ${data.seed}),完成后自动回填本镜画面。${data.warning ? ` ⚠ ${data.warning}` : ''}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const requestBatch = async (confirmed: boolean) => {
    setBusy(true);
    if (!confirmed) setMessage(null);
    try {
      const res = await fetch(`/api/generated-scripts/${projectId}/camera-derive-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmed ? { confirmed: true } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreflight(null);
        setMessage({ kind: 'err', text: data.error || `批量派生失败 (HTTP ${res.status})` });
        return;
      }
      if (data.requiresConfirmation) {
        setPreflight(data.preflight);
        return;
      }
      setPreflight(null);
      if (data.queued) {
        const derivedFromShotId = data.preflight ? String(data.preflight.masterShotId) : undefined;
        onShotsChange(shots.map(item =>
          (data.tasks || []).some((task: any) => String(task.shotId) === String(item.id))
            ? { ...item, derivedFromShotId }
            : item,
        ));
        setMessage({ kind: 'ok', text: `批量派生已入队 ${data.queued} 个任务,完成后自动回填。` });
      } else {
        setMessage({ kind: 'err', text: data.message || '没有可派生的镜头' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-2.5" onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">机位派生 / Camera Derive</span>
        <div className="flex items-center gap-1.5">
          {shot.isMaster && (
            <span className="rounded bg-amber-500/20 border border-amber-500/50 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">主帧</span>
          )}
          {!shot.isMaster && derivedFromIndex >= 0 && (
            <span className="rounded bg-blue-500/15 border border-blue-500/40 px-1.5 py-0.5 text-[9px] font-semibold text-blue-300" title={shot.cameraPromptUsed || ''}>
              派生自 #{derivedFromIndex + 1}
            </span>
          )}
          <button
            type="button"
            onClick={() => void setMaster()}
            className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[9px] font-semibold text-slate-300 hover:border-amber-500/60 hover:text-amber-300 transition-colors cursor-pointer"
          >
            {shot.isMaster ? '取消主帧' : '设为主帧'}
          </button>
        </div>
      </div>

      {!shot.isMaster && (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            {([
              ['cameraH', '方位', CAMERA_H_KEYS, H_LABELS],
              ['cameraV', '俯仰', CAMERA_V_KEYS, V_LABELS],
              ['cameraZoom', '景别', CAMERA_ZOOM_KEYS, ZOOM_LABELS],
            ] as Array<['cameraH' | 'cameraV' | 'cameraZoom', string, readonly string[], Record<string, string>]>).map(([field, label, keys, labels]) => (
              <label key={field} className="flex flex-col gap-1">
                <span className="text-[9px] font-semibold text-slate-500">{label}</span>
                <select
                  value={(shot[field] as string) || ''}
                  onChange={event => void saveCameraParam(field, event.target.value)}
                  className="rounded-lg border border-slate-800 bg-slate-950 px-1.5 py-1.5 text-[10px] text-slate-200 outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="">未设置</option>
                  {keys.map(key => <option key={key} value={key}>{labels[key]}</option>)}
                </select>
              </label>
            ))}
          </div>

          {isCameraH(shot.cameraH) && isLargeAngleFromFront(shot.cameraH) && (
            <p className="text-[9px] leading-relaxed text-amber-400/90">⚠ 与主帧(正面)角度差超过 90°:{LARGE_ANGLE_WARNING}</p>
          )}

          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy || !master || !masterHasImage || !paramsComplete}
              onClick={() => void deriveSingle()}
              title={!master ? '本场尚未指定主帧' : !masterHasImage ? '主帧尚未生成图片' : !paramsComplete ? '请先选齐方位/俯仰/景别' : ''}
              className="flex-1 rounded-lg bg-blue-600 px-2 py-1.5 text-[10px] font-semibold text-white hover:bg-blue-500 disabled:bg-slate-850 disabled:text-slate-600 transition-colors cursor-pointer"
            >
              {busy ? '处理中…' : '从主帧派生'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void requestBatch(false)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-[10px] font-semibold text-slate-300 hover:border-blue-500/60 hover:text-blue-300 disabled:opacity-50 transition-colors cursor-pointer"
            >
              批量派生(整场)
            </button>
          </div>
        </>
      )}

      {shot.isMaster && (
        <p className="text-[9px] leading-relaxed text-slate-500">本镜为主帧:其余镜头设置机位参数后可从本镜派生。批量派生入口位于非主帧镜头的面板中。</p>
      )}

      {message && (
        <p className={`text-[9px] leading-relaxed whitespace-pre-wrap ${message.kind === 'err' ? 'text-red-400' : 'text-emerald-400'}`}>{message.text}</p>
      )}

      {preflight && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/85 p-4" onClick={() => setPreflight(null)}>
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-3 shadow-2xl" onClick={event => event.stopPropagation()}>
            <h3 className="text-sm font-bold text-white">批量派生确认</h3>
            <div className="space-y-2 text-[11px] text-slate-300 max-h-[50vh] overflow-y-auto">
              <p>主帧:{preflight.masterShotLabel} · 待派生 <b className="text-white">{preflight.total}</b> 个镜头</p>
              {preflight.missingParams.length > 0 && (
                <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-2">
                  <p className="font-semibold text-slate-400 mb-1">缺机位参数(将跳过):</p>
                  {preflight.missingParams.map(item => (
                    <p key={item.shotId} className="text-slate-500">{item.shotLabel}:缺 {item.missing.join(' / ')}</p>
                  ))}
                </div>
              )}
              {preflight.largeAngleWarnings.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-2">
                  <p className="font-semibold text-amber-300 mb-1">大角度警告(&gt;90°):</p>
                  {preflight.largeAngleWarnings.map(item => (
                    <p key={item.shotId} className="text-amber-400/90">{item.shotLabel}({H_LABELS[item.cameraH] || item.cameraH}):{item.warning}</p>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPreflight(null)} className="flex-1 rounded-lg border border-slate-700 bg-slate-800 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition-colors cursor-pointer">取消</button>
              <button
                type="button"
                disabled={busy || preflight.total === 0}
                onClick={() => void requestBatch(true)}
                className="flex-1 rounded-lg bg-blue-600 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:bg-slate-850 disabled:text-slate-600 transition-colors cursor-pointer"
              >
                确认派生 {preflight.total} 个镜头
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
