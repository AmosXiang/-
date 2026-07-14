import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';

dotenv.config();
const execFileAsync = promisify(execFile);
const root = path.resolve(process.env.COMFYUI_ROOT || 'C:\\Users\\Owner\\Documents\\ComfyUI');
const url = (process.env.COMFYUI_API_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '');

function probe(directory) {
  const result = { path: directory, exists: fs.existsSync(directory), writable: false, error: null };
  if (!result.exists) return { ...result, error: 'directory not found' };
  const probePath = path.join(directory, `.codex-write-test-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(probePath, 'permission-test', { flag: 'wx' });
    fs.unlinkSync(probePath);
    result.writable = true;
  } catch (error) {
    result.error = error.message;
    try { if (fs.existsSync(probePath)) fs.unlinkSync(probePath); } catch {}
  }
  return result;
}

async function processes() {
  if (process.platform !== 'win32') return [];
  const escaped = root.replace(/'/g, "''");
  const script = `$items = Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'python|comfy') -and (($_.CommandLine -and ($_.CommandLine -like '*ComfyUI*' -or $_.CommandLine -like '*main.py*')) -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith('${escaped}', [System.StringComparison]::OrdinalIgnoreCase))) } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath; $items | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 8000 });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    const matches = Array.isArray(parsed) ? parsed : [parsed];
    if (matches.length) return matches;
  } catch (error) {
    // Fall through to the listening-port owner when CIM command lines are restricted.
  }
  try {
    const fallback = `$items = Get-NetTCPConnection -State Listen -LocalPort 8001 -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [pscustomobject]@{ ProcessId = $_.OwningProcess; Name = $p.ProcessName; CommandLine = '[command line unavailable; detected by port 8001]' } }; $items | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', fallback], { windowsHide: true, timeout: 8000 });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    const matches = Array.isArray(parsed) ? parsed : [parsed];
    if (matches.length) return matches;
  } catch (error) {
    // Fall through to netstat, which does not require CIM privileges.
  }
  try {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 8000 });
    const pids = [...new Set(stdout.split(/\r?\n/).filter(line => /:8001\s+.*LISTENING\s+\d+\s*$/i.test(line)).map(line => Number(line.trim().split(/\s+/).at(-1))).filter(Boolean))];
    return pids.map(ProcessId => ({ ProcessId, Name: 'ComfyUI port owner', CommandLine: '[detected by netstat port 8001]' }));
  } catch (error) {
    return [{ error: `process detection failed: ${error.message}` }];
  }
}

async function online() {
  try {
    const response = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(5000) });
    return { pass: response.ok, status: response.status, error: response.ok ? null : await response.text() };
  } catch (error) {
    return { pass: false, status: null, error: error.message };
  }
}

async function portOwnerPids() {
  try {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 8000 });
    return [...new Set(stdout.split(/\r?\n/).filter(line => /:8001\s+.*LISTENING\s+\d+\s*$/i.test(line)).map(line => Number(line.trim().split(/\s+/).at(-1))).filter(Boolean))];
  } catch { return []; }
}

async function comfyRootProcesses() {
  if (process.platform !== 'win32') return [];
  const escaped = root.replace(/'/g, "''");
  const script = `$items = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('${escaped}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [pscustomobject]@{ ProcessId=$_.Id; ParentProcessId=$null; Name=$_.ProcessName; CommandLine=$null; ExecutablePath=$_.Path } }; $items | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 8000 });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

const input = probe(path.join(root, 'input'));
const output = probe(path.join(root, 'output'));
const userDefault = probe(path.join(root, 'user', 'default'));
const detected = [...await processes(), ...await comfyRootProcesses()];
const runningByPid = new Map();
for (const item of detected.filter(item => item.ProcessId)) {
  const pid = Number(item.ProcessId);
  const previous = runningByPid.get(pid) || {};
  runningByPid.set(pid, { ...previous, ...item, CommandLine: item.CommandLine || previous.CommandLine || null, ExecutablePath: item.ExecutablePath || previous.ExecutablePath || null, duplicateSourceCount: (previous.duplicateSourceCount || 0) + 1 });
}
const running = [...runningByPid.values()];
const occupiedPids = await portOwnerPids();
const portOwners = occupiedPids.map(pid => running.find(item => Number(item.ProcessId) === pid) || ({ ProcessId: pid, CommandLine: '[command line unavailable; detected by port 8001]' }));
const confirmedMain = running.filter(item => /(?:^|[\s"'])[^\s"']*comfyui[\\/]main\.py(?:[\s"']|$)/i.test(`${item.CommandLine || ''} ${item.ExecutablePath || ''}`));
const multipleProcesses = confirmedMain.length >= 2 || occupiedPids.length >= 2;
const dbCandidates = [path.join(root, 'user', 'default', 'comfyui.db'), path.join(root, 'comfyui.db')];
const dbPath = dbCandidates.find(candidate => fs.existsSync(candidate)) || dbCandidates[0];
let dbLocked = false;
let dbError = null;
if (fs.existsSync(dbPath)) {
  try {
    const handle = fs.openSync(dbPath, 'r+');
    fs.closeSync(handle);
  } catch (error) {
    dbLocked = true;
    dbError = error.message;
  }
}
const connection = await online();
const label = value => value ? 'PASS' : 'FAIL';

console.log(`ComfyUI URL: ${url} (${label(connection.pass)}${connection.error ? `: ${connection.error}` : ''})`);
console.log(`input writable: ${label(input.writable)} - ${input.path}${input.error ? ` - ${input.error}` : ''}`);
console.log(`output writable: ${label(output.writable)} - ${output.path}${output.error ? ` - ${output.error}` : ''}`);
console.log(`user/default writable: ${label(userDefault.writable)} - ${userDefault.path}${userDefault.error ? ` - ${userDefault.error}` : ''}`);
console.log(`[ComfyProcessDetect:Start] ${JSON.stringify({ timestamp: new Date().toISOString(), root })}`);
console.log(`running ComfyUI candidates: ${running.length}`);
for (const item of running) console.log(`[ComfyProcessDetect:Candidate] ${JSON.stringify({ processId: Number(item.ProcessId), parentProcessId: Number(item.ParentProcessId) || null, name: item.Name || '', commandLine: item.CommandLine || 'unavailable', executable: item.ExecutablePath || null, ownsPort8001: occupiedPids.includes(Number(item.ProcessId)), confirmedComfyMain: confirmedMain.some(main => Number(main.ProcessId) === Number(item.ProcessId)) })}`);
console.log(`8001 occupied PID: ${portOwners.map(item => item.ProcessId).filter(Boolean).join(', ') || 'not detected'}`);
for (const item of portOwners) console.log(`PID ${item.ProcessId} CommandLine: ${item.CommandLine || '[unavailable]'}`);
console.log(`[ComfyProcessDetect:PortOwner] ${JSON.stringify({ portOwnerPids: occupiedPids })}`);
console.log(`[ComfyProcessDetect:Deduped] ${JSON.stringify({ distinctPids: running.map(item => Number(item.ProcessId)), confirmedMainPids: confirmedMain.map(item => Number(item.ProcessId)) })}`);
console.log(`[ComfyProcessDetect:Decision] ${JSON.stringify({ multipleProcesses, message: multipleProcesses ? '检测到多个 ComfyUI 主进程，请关闭重复实例。' : (occupiedPids.length === 1 ? 'ComfyUI 已连接。' : '未检测到 8001 owner。') })}`);
console.log(`multiple ComfyUI processes: ${label(!multipleProcesses)}`);
console.log(`db lock: ${label(!dbLocked)} - ${dbPath}${dbError ? ` - ${dbError}` : ''}`);

if (!connection.pass || !input.writable || !output.writable || !userDefault.writable || multipleProcesses || dbLocked) process.exitCode = 1;
