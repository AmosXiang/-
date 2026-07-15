import { useEffect, useMemo, useState } from 'react';

const MOVE_LABELS: Record<string, string> = {
  push_in: '推镜', pull_out: '拉镜', static: '固定', follow: '跟拍', pan: '横摇', tilt: '俯仰摇', handheld: '手持',
};
const SIZE_LABELS: Record<string, string> = {
  extreme_close: '大特写', close_up: '特写', medium_close: '中近景', medium: '中景', full: '全景', wide: '远景',
};
const ANGLE_LABELS: Record<string, string> = {
  front: '正面', side: '侧面', back: '背面', high: '俯拍', low: '仰拍', pov: '主观视角',
};
const CAMERA_H_LABELS: Record<string, string> = {
  front: '正面', front_right: '右前 45°', right: '右侧 90°', back_right: '右后 135°', back: '背面', back_left: '左后 135°', left: '左侧 90°', front_left: '左前 45°',
};
const CAMERA_V_LABELS: Record<string, string> = { low: '低机位', eye: '平视', elevated: '略高', high: '高机位' };
const CAMERA_ZOOM_LABELS: Record<string, string> = { close_up: '特写', medium_cu: '中近景', medium: '中景', full: '全景', wide: '远景' };

function uniqueImages(values: unknown[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(String))];
}

function shotImages(shot: any): string[] {
  const finalized = shot?.finalTaskId && shot?.finalizedImageUrl ? shot.finalizedImageUrl : null;
  return uniqueImages([finalized, shot?.generatedImageUrl, shot?.imageUrl]);
}

function characterImages(character: any): string[] {
  return uniqueImages([character?.avatarImageUrl, character?.avatarUrl, character?.avatarGeneration?.imageUrl]);
}

function SafeImage({
  candidates,
  alt,
  className,
  emptyLabel = '未生成',
}: {
  candidates: string[];
  alt: string;
  className: string;
  emptyLabel?: string;
}) {
  const candidateKey = uniqueImages(candidates).join('\u0000');
  const stableCandidates = useMemo(() => candidateKey ? candidateKey.split('\u0000') : [], [candidateKey]);
  const [index, setIndex] = useState(0);

  useEffect(() => setIndex(0), [stableCandidates]);

  const src = stableCandidates[index];
  if (!src) {
    return <div className={`${className} flex items-center justify-center border border-dashed border-slate-700 bg-slate-950 text-xs text-slate-600`}>{index > 0 ? '图片加载失败' : emptyLabel}</div>;
  }
  return <img src={src} alt={alt} className={className} onError={() => setIndex(current => current + 1)} />;
}

function valueLabel(value: unknown, labels?: Record<string, string>): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '未设置';
  return labels?.[normalized] || normalized;
}

export default function StoryboardReview({ script, onClose }: { script: any; onClose?: () => void }) {
  const shots = Array.isArray(script?.newShots) ? script.newShots : [];
  const characters = Array.isArray(script?.newCharacters) ? script.newCharacters : [];
  const finalizedCount = shots.filter((shot: any) => shot?.finalTaskId && shot?.finalizedImageUrl).length;

  return (
    <div className="storyboard-review-print-root min-h-full bg-slate-950 text-slate-200">
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          body * { visibility: hidden !important; }
          .storyboard-review-print-root, .storyboard-review-print-root * { visibility: visible !important; }
          .storyboard-review-print-root { position: absolute !important; inset: 0 !important; width: 100% !important; background: #fff !important; color: #111 !important; }
          .storyboard-review-print-root * { color: #111 !important; border-color: #bbb !important; box-shadow: none !important; background-color: transparent !important; }
          .storyboard-review-print-root section,
          .storyboard-review-print-root article,
          .storyboard-review-print-root header { background: #fff !important; }
          .storyboard-review-toolbar { display: none !important; }
          .storyboard-review-cover { break-after: page; page-break-after: always; }
          .storyboard-review-shot { break-inside: avoid; page-break-inside: avoid; break-after: page; page-break-after: always; }
          .storyboard-review-contact { break-before: page; page-break-before: always; }
          .storyboard-review-contact-item { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      <div className="storyboard-review-toolbar sticky top-0 z-20 flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-5 py-3 backdrop-blur">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-violet-400">工具内审阅预览</p>
          <p className="mt-0.5 text-xs text-slate-500">打印对话框中选择“另存为 PDF”即可导出</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => window.print()} className="rounded-lg bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500">🖨 打印 / 导出 PDF</button>
          {onClose && <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800">关闭</button>}
        </div>
      </div>

      <main className="mx-auto max-w-7xl space-y-6 p-5 print:max-w-none print:p-0">
        <section className="storyboard-review-cover overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
          <div className="border-b border-slate-800 pb-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-violet-400">Storyboard Review Book</p>
            <h1 className="mt-3 text-3xl font-bold text-white">{script?.newTitle || '未命名项目'}</h1>
            <p className="mt-2 text-sm text-slate-400">{script?.topic || '未设置创作主题'}</p>
            <p className="mt-4 font-mono text-xs text-slate-500">分镜 {shots.length} 镜 · 已定稿 {finalizedCount}/{shots.length}</p>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {[
              ['三幕结构', script?.newNarrative?.structure],
              ['视听节奏', script?.newNarrative?.rhythm],
              ['高潮设计', script?.newNarrative?.climaxDesign],
            ].map(([label, content]) => (
              <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-[10px] font-semibold text-violet-300">{label}</p>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">{content || '未设置'}</p>
              </div>
            ))}
          </div>

          <div className="mt-5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">角色</p>
            {characters.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {characters.map((character: any, index: number) => (
                  <div key={character.id || `${character.name}-${index}`} className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950/70 py-1 pl-1 pr-3">
                    <SafeImage candidates={characterImages(character)} alt={character.name || '角色'} className="h-8 w-8 rounded-full object-cover" emptyLabel="无头像" />
                    <span><strong className="text-slate-200">{character.name || '未命名角色'}</strong><span className="ml-1 text-slate-500">{character.role || ''}</span></span>
                  </div>
                ))}
              </div>
            ) : <p className="mt-2 text-xs text-slate-500">尚未设置角色</p>}
          </div>
        </section>

        {shots.map((shot: any, index: number) => {
          const finalized = Boolean(shot?.finalTaskId && shot?.finalizedImageUrl);
          return (
            <article key={shot.id || index} className="storyboard-review-shot relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
              {!finalized && <span className="absolute right-0 top-0 rounded-bl-xl border-b border-l border-amber-700 bg-amber-950/90 px-4 py-2 text-sm font-black tracking-widest text-amber-300">DRAFT</span>}
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3 pr-24">
                <div>
                  <p className="font-mono text-lg font-bold text-white">SHOT {String(index + 1).padStart(2, '0')}</p>
                  <p className="mt-1 font-mono text-xs text-slate-500">{shot.timestamp || '无时间码'} · {shot.durationSec > 0 ? `${shot.durationSec}s` : '时长未设置'}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {finalized && <span className="rounded-md border border-emerald-700 bg-emerald-950/40 px-2 py-1 text-[10px] font-semibold text-emerald-300">已定稿</span>}
                  {shot.isStale && <span className="rounded-md border border-amber-700 bg-amber-950/40 px-2 py-1 text-[10px] font-semibold text-amber-300">⚠ 基于旧版剧本</span>}
                </div>
              </header>

              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(19rem,0.75fr)]">
                <SafeImage candidates={shotImages(shot)} alt={`分镜 ${index + 1}`} className="aspect-video h-auto w-full rounded-xl bg-slate-950 object-contain" />
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    {[
                      ['运镜', valueLabel(shot.camera?.move || shot.movement, MOVE_LABELS)],
                      ['速度', valueLabel(shot.camera?.speed)],
                      ['景别', valueLabel(shot.framing?.shotSize || shot.composition, SIZE_LABELS)],
                      ['视角', valueLabel(shot.framing?.angle, ANGLE_LABELS)],
                      ['水平机位', valueLabel(shot.cameraH, CAMERA_H_LABELS)],
                      ['垂直机位', valueLabel(shot.cameraV, CAMERA_V_LABELS)],
                      ['机位景别', valueLabel(shot.cameraZoom, CAMERA_ZOOM_LABELS)],
                      ['主帧关系', shot.isMaster ? '主帧' : shot.derivedFromShotId ? `派生自 ${shot.derivedFromShotId}` : '独立镜头'],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                        <span className="text-slate-600">{label}</span>
                        <p className="mt-1 text-slate-300">{value}</p>
                      </div>
                    ))}
                  </div>
                  {shot.camera?.note && <p className="text-[10px] text-slate-500">运镜补充：{shot.camera.note}</p>}
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <p className="text-[10px] font-semibold text-slate-500">画面描述</p>
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">{shot.description || '未填写'}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <p className="text-[10px] font-semibold text-slate-500">生成 Prompt</p>
                  <p className="mt-2 whitespace-pre-wrap text-[10px] leading-relaxed text-slate-400">{shot.optimizedPrompt || '未填写'}</p>
                </div>
              </div>
            </article>
          );
        })}

        <section className="storyboard-review-contact rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="border-b border-slate-800 pb-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-violet-400">Contact Sheet</p>
            <h2 className="mt-1 text-lg font-semibold text-white">镜头总览</h2>
          </div>
          {shots.length > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {shots.map((shot: any, index: number) => (
                <div key={shot.id || index} className="storyboard-review-contact-item overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60">
                  <SafeImage candidates={shotImages(shot)} alt={`分镜总览 ${index + 1}`} className="aspect-video h-auto w-full bg-slate-950 object-contain" />
                  <div className="flex items-center justify-between px-2.5 py-2 text-[10px]">
                    <span className="font-mono font-bold text-slate-300">#{String(index + 1).padStart(2, '0')}</span>
                    <span className={shot.finalTaskId && shot.finalizedImageUrl ? 'text-emerald-400' : 'text-amber-400'}>{shot.finalTaskId && shot.finalizedImageUrl ? 'FINAL' : 'DRAFT'}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="mt-4 rounded-xl border border-dashed border-slate-700 p-10 text-center text-slate-500">当前项目没有分镜</div>}
        </section>
      </main>
    </div>
  );
}
