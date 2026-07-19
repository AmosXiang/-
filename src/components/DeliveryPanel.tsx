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

interface StyleGateDetail {
  shotId: string;
  index: number;
  fingerprint: string | null;
  contractCurrent: boolean;
  anchorCurrent: boolean;
  recipeMatches: boolean | null;
  imageDecodable: boolean;
  styleApprovedValid: boolean;
  colorOutlier: boolean | null;
  needsAttention: boolean;
  reasons: string[];
  warnings: string[];
}

interface StyleGateSummary {
  total: number;
  contractStale: number;
  anchorStale: number;
  recipeDrift: number;
  undecodable: number;
  unapproved: number;
  colorOutliers: number;
  needsAttention: number;
  approvedRecipeMissing: boolean;
  approvedRecipe: { fingerprint: string; setFromShotId: string; setAt: string } | null;
  details: StyleGateDetail[];
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
  styleGate: StyleGateSummary;
  finalVideos?: { count: number; totalBytes: number };
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

function formatVideoBytes(bytes: number): string {
  const gigabyte = 1024 ** 3;
  if (bytes >= gigabyte) return `${(bytes / gigabyte).toFixed(1)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
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
  const [includeFinalVideos, setIncludeFinalVideos] = useState(false);
  const [styleAction, setStyleAction] = useState('');

  const baseUrl = `/api/generated-scripts/${encodeURIComponent(projectId)}`;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setChecking(true);
    setError('');
    try {
      const data = await readJson(await fetch(`${baseUrl}/delivery-check`, { signal }));
      setSummary(data);
      if (!data.finalVideos?.count) setIncludeFinalVideos(false);
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
    setIncludeFinalVideos(false);
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
        body: JSON.stringify({ mode, includeFinalVideos }),
      }));
      setResult(data);
      if (data.summary) setSummary(current => ({ ...data.summary, finalVideos: current?.finalVideos }));
    } catch (exportError) {
      if (exportError instanceof RequestError && exportError.status === 409) {
        setMissing(Array.isArray(exportError.data?.missing) ? exportError.data.missing : []);
      }
      setError((exportError as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const runStyleAction = async (key: string, request: () => Promise<Response>) => {
    setStyleAction(key);
    setError('');
    try {
      await readJson(await request());
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setStyleAction('');
    }
  };

  const pinRecipe = (shotId: string) => runStyleAction(`pin:${shotId}`, () => fetch(
    `/api/projects/${encodeURIComponent(projectId)}/approved-recipe`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId }),
    },
  ));

  const clearRecipe = () => runStyleAction('clear-recipe', () => fetch(
    `/api/projects/${encodeURIComponent(projectId)}/approved-recipe`,
    { method: 'DELETE' },
  ));

  const setStyleApproved = (shotId: string, approved: boolean) => runStyleAction(
    `approve:${shotId}`,
    () => fetch(
      `/api/generated-scripts/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/style-approved`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      },
    ),
  );

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
  const styleGate = summary?.styleGate;
  const styleStats = styleGate ? [
    ['契约旧版', styleGate.contractStale],
    ['锚图旧版', styleGate.anchorStale],
    ['配方漂移', styleGate.recipeDrift],
    ['图片不可解码', styleGate.undecodable],
    ['未人工确认', styleGate.unapproved],
    ['色彩离群提示', styleGate.colorOutliers],
  ] as const : [];
  const approvedRecipeIndex = styleGate?.approvedRecipe
    ? styleGate.details.find(item => item.shotId === styleGate.approvedRecipe?.setFromShotId)?.index
    : undefined;

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

      {styleGate && (
        <section className="space-y-3 rounded-xl border border-indigo-900/70 bg-indigo-950/15 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-indigo-200">风格一致性 · 人工复核门</p>
              <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-500">
                只报告配方、版本、图片与人工确认状态；不自动淘汰、不自动重生，也不新增导出阻断。色彩离群仅作提示。
              </p>
            </div>
            {styleGate.approvedRecipe ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-lg border border-emerald-800 bg-emerald-950/30 px-2 py-1 text-[10px] text-emerald-300">
                  批准配方来自 {approvedRecipeIndex === undefined ? styleGate.approvedRecipe.setFromShotId : `#${approvedRecipeIndex + 1}`}
                </span>
                <button
                  type="button"
                  disabled={Boolean(styleAction)}
                  onClick={() => void clearRecipe()}
                  className="rounded-lg border border-slate-700 px-2 py-1 text-[10px] text-slate-400 hover:border-red-700 hover:text-red-300 disabled:opacity-40"
                >
                  {styleAction === 'clear-recipe' ? '清除中…' : '清除批准配方'}
                </button>
              </div>
            ) : (
              <span className="rounded-lg border border-amber-800 bg-amber-950/30 px-2 py-1 text-[10px] text-amber-300">未设批准配方 · 请从下方镜头钉选</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {styleStats.map(([label, value], index) => (
              <div key={label} className="rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-2">
                <p className="text-[9px] text-slate-500">{label}</p>
                <p className={`mt-1 font-mono text-base font-bold ${value > 0 ? (index === 5 ? 'text-cyan-300' : 'text-amber-300') : 'text-emerald-300'}`}>{value}</p>
              </div>
            ))}
          </div>

          <div className="max-h-80 divide-y divide-slate-800 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/45">
            {styleGate.details.map(detail => {
              const criteria = [
                ['契约', detail.contractCurrent, false],
                ['锚图', detail.anchorCurrent, false],
                ['配方', detail.recipeMatches, true],
                ['图片', detail.imageDecodable, false],
                ['人工', detail.styleApprovedValid, false],
              ] as const;
              return (
                <div key={detail.shotId} className="space-y-2 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-10 font-mono font-semibold text-slate-300">#{detail.index + 1}</span>
                    <span className="flex flex-1 flex-wrap gap-1.5">
                      {criteria.map(([label, value, nullable]) => (
                        <span
                          key={label}
                          className={`rounded-md border px-1.5 py-0.5 text-[9px] ${value === true ? 'border-emerald-800 bg-emerald-950/30 text-emerald-300' : nullable && value === null ? 'border-slate-700 bg-slate-900 text-slate-400' : 'border-amber-800 bg-amber-950/30 text-amber-300'}`}
                        >
                          {label} {value === true ? '通过' : nullable && value === null ? '未设标准' : '需处理'}
                        </span>
                      ))}
                      {detail.colorOutlier === true && <span className="rounded-md border border-cyan-800 bg-cyan-950/30 px-1.5 py-0.5 text-[9px] text-cyan-300">色彩离群 · 仅提示</span>}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={!detail.fingerprint || Boolean(styleAction)}
                      onClick={() => void pinRecipe(detail.shotId)}
                      className="rounded-md border border-indigo-800 px-2 py-1 text-[9px] text-indigo-300 hover:bg-indigo-950/50 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {styleAction === `pin:${detail.shotId}` ? '钉选中…' : '钉为批准配方'}
                    </button>
                    <button
                      type="button"
                      disabled={!detail.fingerprint || Boolean(styleAction)}
                      onClick={() => void setStyleApproved(detail.shotId, !detail.styleApprovedValid)}
                      className="rounded-md border border-emerald-800 px-2 py-1 text-[9px] text-emerald-300 hover:bg-emerald-950/40 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {styleAction === `approve:${detail.shotId}` ? '保存中…' : detail.styleApprovedValid ? '撤销风格确认' : '标记风格已确认'}
                    </button>
                    {onJumpToShot && (
                      <button type="button" onClick={() => onJumpToShot(detail.shotId)} className="rounded-md border border-slate-700 px-2 py-1 text-[9px] text-slate-400 hover:text-white">跳到镜头 →</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-slate-500">需关注 {styleGate.needsAttention}/{styleGate.total} 镜；色彩离群不计入该数字。最终风格判断必须由人工完成。</p>
        </section>
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

      <div className="space-y-3 border-t border-slate-800 pt-4">
        <label className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${summary?.finalVideos?.count ? 'cursor-pointer border-slate-700 bg-slate-900/50 text-slate-300' : 'cursor-not-allowed border-slate-800 bg-slate-950/40 text-slate-600'}`}>
          <input
            type="checkbox"
            checked={includeFinalVideos}
            disabled={!summary?.finalVideos?.count || checking || Boolean(exporting)}
            onChange={event => setIncludeFinalVideos(event.target.checked)}
            className="mt-0.5 accent-emerald-500"
          />
          <span>
            <span className="block font-semibold">同时打包定稿视频（预计增加 {formatVideoBytes(summary?.finalVideos?.totalBytes || 0)}）</span>
            <span className="mt-0.5 block text-[10px] text-slate-500">默认关闭；不勾选时 manifest 仍会引用已复核的本地定稿视频。</span>
          </span>
        </label>

        <div className="grid gap-3 md:grid-cols-2">
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
