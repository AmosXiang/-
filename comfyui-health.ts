import { exec as execCallback } from 'child_process';
import util from 'util';

const defaultExec = util.promisify(execCallback);

export type ComfyProcessCandidate = {
  processId: number;
  name: string;
  commandLine: string | null;
  parentProcessId: number | null;
  executable: string | null;
  sources: string[];
  ownsPort8001: boolean;
  confirmedComfyMain: boolean;
  duplicateSourceCount: number;
};

export type ComfyProcessDetection = {
  portOwnerPids: number[];
  candidates: ComfyProcessCandidate[];
  confirmedMainPids: number[];
  multipleProcesses: boolean;
  commandLineUnavailable: boolean;
};

type ExecResult = { stdout: string; stderr?: string };
type ExecCommand = (command: string, options: { windowsHide: boolean; timeout: number }) => Promise<ExecResult>;
type Logger = Pick<Console, 'log' | 'warn'>;

export type ComfyHealthDependencies = {
  exec?: ExecCommand;
  platform?: NodeJS.Platform;
  logger?: Logger;
};

const emptyDetection = (): ComfyProcessDetection => ({
  portOwnerPids: [], candidates: [], confirmedMainPids: [], multipleProcesses: false, commandLineUnavailable: false,
});

export async function getPort8001OwnerPids(dependencies: ComfyHealthDependencies = {}): Promise<number[]> {
  if ((dependencies.platform || process.platform) !== 'win32') return [];
  try {
    const { stdout } = await (dependencies.exec || defaultExec)('netstat -ano -p tcp', { windowsHide: true, timeout: 8_000 });
    return [...new Set(stdout.split(/\r?\n/).filter(line => /:8001\s+.*LISTENING\s+\d+\s*$/i.test(line)).map(line => Number(line.trim().split(/\s+/).at(-1))).filter(Boolean))];
  } catch {
    return [];
  }
}

export async function detectComfyProcesses(
  comfyRoot: string,
  context: Record<string, unknown> = {},
  dependencies: ComfyHealthDependencies = {},
): Promise<ComfyProcessDetection> {
  const platform = dependencies.platform || process.platform;
  const logger = dependencies.logger || console;
  const execCommand = dependencies.exec || defaultExec;
  const timestamp = new Date().toISOString();
  logger.log('[ComfyProcessDetect:Start]', JSON.stringify({ timestamp, ...context, comfyRoot }));
  if (platform !== 'win32') return emptyDetection();

  const raw: Array<Record<string, unknown> & { source: string; ownsPort8001?: boolean }> = [];
  const portOwnerPids = await getPort8001OwnerPids({ exec: execCommand, platform });
  for (const processId of portOwnerPids) raw.push({ ProcessId: processId, source: 'netstat:8001', ownsPort8001: true });

  const escapedRoot = comfyRoot.replace(/'/g, "''");
  const ps = `$items = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { ($_.Name -match 'python|comfy') -and (($_.CommandLine -and ($_.CommandLine -like '*ComfyUI*' -or $_.CommandLine -like '*main.py*')) -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith('${escapedRoot}', [System.StringComparison]::OrdinalIgnoreCase))) } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath; $items | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execCommand(`powershell.exe -NoProfile -Command "${ps}"`, { windowsHide: true, timeout: 8_000 });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    for (const item of (Array.isArray(parsed) ? parsed : [parsed])) raw.push({ ...item, source: 'cim' });
  } catch (error: any) {
    logger.warn('[ComfyPreflight:ProcessCheckFailed]', error.message);
  }

  const candidatesByPid = new Map<number, ComfyProcessCandidate>();
  for (const item of raw) {
    const processId = Number(item.ProcessId);
    if (!processId) continue;
    const existing = candidatesByPid.get(processId);
    const commandLine = item.CommandLine ? String(item.CommandLine) : existing?.commandLine || null;
    const executable = item.ExecutablePath ? String(item.ExecutablePath) : existing?.executable || null;
    const normalized = `${commandLine || ''} ${executable || ''}`.replace(/\\/g, '/');
    const candidate: ComfyProcessCandidate = {
      processId,
      name: String(item.Name || existing?.name || ''),
      commandLine,
      parentProcessId: Number(item.ParentProcessId) || existing?.parentProcessId || null,
      executable,
      sources: [...new Set([...(existing?.sources || []), item.source])],
      ownsPort8001: !!item.ownsPort8001 || portOwnerPids.includes(processId) || !!existing?.ownsPort8001,
      confirmedComfyMain: /(?:^|[\s"'])[^\s"']*comfyui\/main\.py(?:[\s"']|$)/i.test(normalized) || !!existing?.confirmedComfyMain,
      duplicateSourceCount: (existing?.duplicateSourceCount || 0) + 1,
    };
    candidatesByPid.set(processId, candidate);
    logger.log('[ComfyProcessDetect:Candidate]', JSON.stringify({ timestamp, ...context, ...candidate, commandLine: candidate.commandLine || 'unavailable' }));
  }

  const candidates = [...candidatesByPid.values()];
  const confirmedMainPids = candidates.filter(item => item.confirmedComfyMain).map(item => item.processId);
  const multipleProcesses = confirmedMainPids.length >= 2 || portOwnerPids.length >= 2;
  const commandLineUnavailable = candidates.some(item => item.ownsPort8001 && !item.commandLine);
  logger.log('[ComfyProcessDetect:PortOwner]', JSON.stringify({ timestamp, ...context, portOwnerPids, owners: candidates.filter(item => item.ownsPort8001) }));
  logger.log('[ComfyProcessDetect:Deduped]', JSON.stringify({ timestamp, ...context, rawCount: raw.length, distinctPids: candidates.map(item => item.processId), candidates }));
  if (commandLineUnavailable) {
    logger.warn('[ComfyProcessDetect:Degraded]', JSON.stringify({ timestamp, ...context, message: 'commandLine 读取失败，降级模式运行', portOwnerPids }));
  }
  logger.log('[ComfyProcessDetect:Decision]', JSON.stringify({ timestamp, ...context, confirmedMainPids, portOwnerPids, multipleProcesses, commandLineUnavailable }));
  return { portOwnerPids, candidates, confirmedMainPids, multipleProcesses, commandLineUnavailable };
}
