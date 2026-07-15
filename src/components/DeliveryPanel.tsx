import { useCallback, useEffect, useState } from 'react';

type IssueCode =
  | 'not_finalized'
  | 'missing_image'
  | 'image_not_local'
  | 'missing_camera'
  | 'missing_framing'
  | 'missing_duration'
  | 'stale_input'
  | 'latest_task_failed';

interface DeliveryDetail {
  shotId: string;
  index: number;
  issues: IssueCode[];
}

interface DeliverySummary {
  total: number;
  finalized: number;
  notFinalized: number;
  missingImage: number;
  failed: number;
  missingParams: number;
  stale: number;
  details: DeliveryDetail[];
}

interface ExportResult {
  mode: 'final' | 'review';
  files: { pptxUrl: string; manifestUrl: string; zipUrl: string };
  summary: DeliverySummary;
}

const ISSUE_LABELS: Record<IssueCode, string> = {
  not_finalized: '未定稿',
  missing_image: '缺图',
  image_not_local: '图片非本地',
  missing_camera: '缺运镜参数',
  missing_framing: '缺景别参数',
  missing_duration: '缺时长',
  stale_input: '基于旧输入',
  latest_task_failed: '最新任务失败',
};

class RequestError extends Error {
  constructor(public status: number, public data: any) {
    super(data?.error || `请求失败 (HTTP ${status})`);
    this.name = 'RequestError';
  }
}

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(response.status, data);
  return data;
}

export default function DeliveryPanel({
  projectId,
  onJumpToShot,
}: {
  projectId: string;
  onJumpToShot?: (shotId: string) => void;
}) {
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [checking, setChecking] = useState(true);
  const [exporting, setExporting] = useState<'final' | 'review' | null>(null);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState<DeliveryDetail[]>([]);
  const [result, setResult] = useState<ExportResult | null>(null);

  const baseUrl = `/api/generated-scripts/${encodeURIComponent(projectId)}`;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setChecking(true);
    setError('');
    try {
      const data = await readJson(await fetch(`${baseUrl}/delivery-check`, { signal }));
      setSummary(data);
      setMissing([]);
    } catch (refreshError) {
      if ((refreshError as Error).name !== 'AbortError') setError((refreshError as Error).message);
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    setResult(null);
    setMissing([]);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const exportDeck = async (mode: 'final' | 'review') => {
    setExporting(mode);
    setError('');
    setMissing([]);
    setResult(null);
    try {
      const data = await readJson(await fetch(`${baseUrl}/export-deck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      }));
      setResult(data);
      if (data.summary) setSummary(data.summary);
    } catch (exportError) {
      if (exportError instanceof RequestError && exportError.status === 409) {
        setMissing(Array.isArray(exportError.data?.missing) ? exportError.data.missing : []);
      }
      setError((exportError as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const stats = summary ? [
    ['分镜总数', summary.total, 'text-white'],
    ['已定稿', summary.finalized, 'text-emerald-300'],
    ['未定稿', summary.notFinalized, 'text-amber-300'],
    ['缺图', summary.missingImage, 'text-red-300'],
    ['失败', summary.failed, 'text-red-300'],
    ['缺参数', summary.missingParams, 'text-orange-300'],
    ['基于旧输入', summary.stale, 'text-amber-300'],
  ] as const : [];

  const issueRows = missing.length > 0 ? missing : summary?.details || [];
  const finalBlocked = !summary || summary.notFinalized > 0;

  return (
    <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-200">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">交付检查 / Delivery</p>
          <h2 className="mt-1 text-sm font-semibold text-white">分镜交付包</h2>
        </div>
        <button
          type="button"
          disabled={checking || Boolean(exporting)}
          onClick={() => void refresh()}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:border-emerald-500 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {checking ? '检查中…' : '重新检查'}
        </button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-red-300">
          {error}
        </div>
      )}

      {checking && !summary ? (
        <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-slate-500">正在检查交付完整性…</div>
      ) : summary && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
          {stats.map(([label, value, color]) => (
            <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3">
              <p className="text-[10px] text-slate-500">{label}</p>
              <p className={`mt-1 font-mono text-xl font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {issueRows.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50">
          <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2.5">
            <span className="font-semibold text-slate-300">需处理的分镜</span>
            <span className="text-[10px] text-slate-500">{issueRows.length} 镜有缺项</span>
          </div>
          <div className="max-h-72 divide-y divide-slate-800 overflow-y-auto">
            {issueRows.map(detail => (
              <button
                key={`${detail.shotId}-${detail.index}`}
                type="button"
                disabled={!onJumpToShot}
                onClick={() => onJumpToShot?.(detail.shotId)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800/70 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="w-12 shrink-0 font-mono font-semibold text-slate-300">#{detail.index + 1}</span>
                <span className="flex flex-1 flex-wrap gap-1.5">
                  {detail.issues.map(issue => (
                    <span key={issue} className={`rounded-md border px-1.5 py-0.5 text-[9px] ${issue === 'stale_input' ? 'border-amber-800 bg-amber-950/30 text-amber-300' : issue === 'not_finalized' ? 'border-slate-700 bg-slate-900 text-slate-300' : 'border-red-900/70 bg-red-950/30 text-red-300'}`}>
                      {ISSUE_LABELS[issue] || issue}
                    </span>
                  ))}
                </span>
                {onJumpToShot && <span className="text-slate-600">跳转 →</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {summary && issueRows.length === 0 && (
        <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/20 px-3 py-3 text-emerald-300">交付检查通过，没有发现缺项。</div>
      )}

      <div className="grid gap-3 border-t border-slate-800 pt-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <button
            type="button"
            disabled={checking || Boolean(exporting) || finalBlocked}
            onClick={() => void exportDeck('final')}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
          >
            {exporting === 'final' ? '正在生成正式包…' : '导出正式交付包'}
          </button>
          <p className={`text-[10px] ${finalBlocked ? 'text-amber-400' : 'text-slate-500'}`}>
            {!summary ? '完成检查后可导出' : summary.notFinalized > 0 ? `仍有 ${summary.notFinalized} 镜未定稿，正式包暂不可用` : '所有分镜均已定稿，可生成正式交付包'}
          </p>
        </div>
        <div className="space-y-1.5">
          <button
            type="button"
            disabled={checking || Boolean(exporting)}
            onClick={() => void exportDeck('review')}
            className="w-full rounded-lg border border-violet-700 bg-violet-950/30 px-4 py-2.5 font-semibold text-violet-300 hover:bg-violet-900/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {exporting === 'review' ? '正在生成审阅稿…' : '导出审阅稿'}
          </button>
          <p className="text-[10px] text-slate-500">未定稿镜头将标记 DRAFT，不会静默漏页。</p>
        </div>
      </div>

      {result && (
        <div className="rounded-xl border border-emerald-700/60 bg-emerald-950/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold text-emerald-300">{result.mode === 'final' ? '正式交付包' : '审阅稿'}生成完成</p>
              <p className="mt-1 text-[10px] text-slate-400">
                共 {result.summary.total} 镜 · 已定稿 {result.summary.finalized} 镜
                {result.summary.stale > 0 ? ` · ${result.summary.stale} 镜基于旧输入，已在手册中标注` : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={result.files.pptxUrl} className="rounded-lg border border-emerald-700 px-2.5 py-1.5 font-semibold text-emerald-300 hover:bg-emerald-900/40">下载 PPTX</a>
              <a href={result.files.manifestUrl} className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-slate-300 hover:bg-slate-800">下载 manifest</a>
              <a href={result.files.zipUrl} className="rounded-lg bg-emerald-600 px-2.5 py-1.5 font-semibold text-white hover:bg-emerald-500">下载 ZIP</a>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
