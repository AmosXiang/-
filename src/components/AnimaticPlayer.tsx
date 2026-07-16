import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnimaticItem } from './animaticPlaylist.ts';
import { nextIndex, previousIndex } from './animaticPlaylist.ts';

type AnimaticPlayerProps = {
  items: AnimaticItem[];
  activeShotId?: string;
  onShotChange?: (shotId: string) => void;
  onClose?: () => void;
};

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

export default function AnimaticPlayer({
  items,
  activeShotId,
  onShotChange,
  onClose,
}: AnimaticPlayerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const currentItem = items[currentIndex];
  const totalDuration = useMemo(() => items.reduce((sum, item) => sum + item.durationSec, 0), [items]);

  const goToIndex = useCallback((requestedIndex: number, elapsed = 0) => {
    if (items.length === 0) return;
    const targetIndex = Math.max(0, Math.min(requestedIndex, items.length - 1));
    const changed = targetIndex !== currentIndex;
    setCurrentIndex(targetIndex);
    setElapsedSec(Math.max(0, Math.min(elapsed, items[targetIndex].durationSec)));
    if (changed) onShotChange?.(items[targetIndex].shotId);
  }, [currentIndex, items, onShotChange]);

  const advance = useCallback(() => {
    if (currentIndex >= items.length - 1) {
      setElapsedSec(currentItem?.durationSec ?? 0);
      setIsPlaying(false);
      return;
    }
    goToIndex(nextIndex(currentIndex, items.length));
  }, [currentIndex, currentItem?.durationSec, goToIndex, items.length]);

  useEffect(() => {
    if (items.length === 0) {
      setCurrentIndex(0);
      setElapsedSec(0);
      setIsPlaying(false);
      return;
    }
    if (currentIndex >= items.length) goToIndex(items.length - 1);
  }, [currentIndex, goToIndex, items.length]);

  useEffect(() => {
    if (!activeShotId) return;
    const targetIndex = items.findIndex(item => item.shotId === activeShotId);
    if (targetIndex >= 0 && targetIndex !== currentIndex) goToIndex(targetIndex);
  }, [activeShotId, currentIndex, goToIndex, items]);

  useEffect(() => {
    if (!onClose) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !currentItem?.videoUrl) return;
    if (isPlaying) {
      void video.play().catch(() => {
        // Browser autoplay policy may reject play; the explicit play control can retry.
      });
    } else {
      video.pause();
    }
  }, [currentIndex, currentItem?.videoUrl, isPlaying]);

  useEffect(() => {
    if (!isPlaying || !currentItem) return;
    const startedAt = performance.now() - elapsedSec * 1000;
    const intervalId = window.setInterval(() => {
      const nextElapsed = (performance.now() - startedAt) / 1000;
      if (nextElapsed >= currentItem.durationSec) {
        window.clearInterval(intervalId);
        advance();
      } else {
        setElapsedSec(nextElapsed);
      }
    }, 100);
    return () => window.clearInterval(intervalId);
    // elapsedSec is deliberately captured only when playback starts or the shot changes.
    // Including it would recreate the interval on every tick and introduce drift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advance, currentIndex, currentItem, isPlaying]);

  const togglePlayback = () => {
    if (!currentItem) return;
    if (!isPlaying && currentIndex === items.length - 1 && elapsedSec >= currentItem.durationSec) {
      goToIndex(0);
      setIsPlaying(true);
      return;
    }
    setIsPlaying(value => !value);
  };

  if (!currentItem) {
    return (
      <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/90 p-4 text-slate-200">
        <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center shadow-2xl">
          <p className="text-sm font-semibold text-white">暂无可播放分镜</p>
          <p className="mt-2 text-xs text-slate-500">先为项目添加带 ID 的分镜。</p>
          {onClose && <button type="button" onClick={onClose} className="mt-5 rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800">关闭</button>}
        </div>
      </div>
    );
  }

  const shotProgress = Math.min(100, (elapsedSec / currentItem.durationSec) * 100);

  return (
    <div className="fixed inset-0 z-[140] flex flex-col bg-black/95 text-slate-200" role="dialog" aria-modal="true" aria-label="分镜动态预览">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 py-3 sm:px-6">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-violet-400">Animatic Preview</p>
          <p className="mt-1 font-mono text-xs text-slate-400">镜头 {currentIndex + 1} / {items.length} · {formatSeconds(elapsedSec)} / {formatSeconds(currentItem.durationSec)}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-xs text-slate-500 sm:inline">全片 {formatSeconds(totalDuration)}</span>
          {onClose && <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:bg-slate-800">关闭</button>}
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-4 sm:p-8">
        {currentItem.videoUrl ? (
          <video
            key={currentItem.shotId}
            ref={videoRef}
            src={currentItem.videoUrl}
            muted
            autoPlay={isPlaying}
            playsInline
            className="h-full w-full object-contain"
            onEnded={advance}
            onTimeUpdate={event => {
              const mediaElapsed = Math.min(event.currentTarget.currentTime, currentItem.durationSec);
              setElapsedSec(current => Math.max(current, mediaElapsed));
            }}
          />
        ) : currentItem.imageUrl ? (
          <img src={currentItem.imageUrl} alt={`分镜 ${currentIndex + 1}`} className="h-full w-full object-contain" />
        ) : (
          <div className="flex aspect-video w-full max-w-4xl flex-col items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-slate-950 text-center">
            <p className="font-mono text-3xl font-black tracking-[0.2em] text-slate-500">SHOT {String(currentIndex + 1).padStart(2, '0')}</p>
            <p className="mt-3 text-sm text-slate-600">无定稿图</p>
          </div>
        )}
        {!isPlaying && <span className="pointer-events-none absolute rounded-full border border-white/15 bg-black/65 px-4 py-2 text-xs font-semibold tracking-widest text-white backdrop-blur">已暂停</span>}
      </main>

      <footer className="border-t border-slate-800 bg-slate-950 px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="flex h-3 w-full gap-1" aria-label="分镜时间轴">
            {items.map((item, index) => {
              const selected = index === currentIndex;
              const width = selected ? shotProgress : index < currentIndex ? 100 : 0;
              return (
                <button
                  key={item.shotId}
                  type="button"
                  aria-label={`跳转到镜头 ${index + 1}，时长 ${formatSeconds(item.durationSec)}`}
                  aria-pressed={selected}
                  title={`镜头 ${index + 1} · ${formatSeconds(item.durationSec)}`}
                  onClick={() => goToIndex(index)}
                  className={`relative min-w-[3px] overflow-hidden rounded-full border transition-colors ${selected ? 'border-violet-400 bg-slate-700' : 'border-slate-700 bg-slate-800 hover:border-slate-500'}`}
                  style={{ flexGrow: item.durationSec, flexBasis: 0 }}
                >
                  <span className={`absolute inset-y-0 left-0 ${selected ? 'bg-violet-500' : 'bg-slate-500'}`} style={{ width: `${width}%` }} />
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-center gap-2">
            <button type="button" disabled={currentIndex === 0} onClick={() => goToIndex(previousIndex(currentIndex, items.length))} className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-35">上一镜</button>
            <button type="button" onClick={togglePlayback} className="min-w-24 rounded-lg bg-violet-600 px-5 py-2 text-xs font-bold text-white hover:bg-violet-500">{isPlaying ? '暂停' : '播放'}</button>
            <button type="button" disabled={currentIndex === items.length - 1} onClick={() => goToIndex(nextIndex(currentIndex, items.length))} className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-35">下一镜</button>
          </div>
          <p className="mt-3 text-center font-mono text-[10px] text-slate-600 sm:hidden">全片 {formatSeconds(totalDuration)}</p>
        </div>
      </footer>
    </div>
  );
}
