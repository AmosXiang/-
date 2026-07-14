import assert from 'node:assert/strict';
import test from 'node:test';
import { detectComfyProcesses } from './comfyui-health.ts';

const netstat = (pids: number[]) => pids.map(pid => `  TCP    127.0.0.1:8001    0.0.0.0:0    LISTENING    ${pid}`).join('\n');

function harness(portPids: number[], cim: unknown | Error) {
  const logs: string[] = [];
  return {
    logs,
    dependencies: {
      platform: 'win32' as const,
      logger: { log: (...values: unknown[]) => logs.push(values.join(' ')), warn: (...values: unknown[]) => logs.push(values.join(' ')) },
      exec: async (command: string) => {
        if (command.startsWith('netstat')) return { stdout: netstat(portPids) };
        if (cim instanceof Error) throw cim;
        return { stdout: JSON.stringify(cim) };
      },
    },
  };
}

test('normal detection deduplicates netstat and CIM records by PID', async () => {
  const { dependencies } = harness([120], { ProcessId: 120, ParentProcessId: 1, Name: 'python.exe', CommandLine: 'python C:\\ComfyUI\\main.py --port 8001', ExecutablePath: 'C:\\ComfyUI\\python.exe' });
  const result = await detectComfyProcesses('C:\\ComfyUI', {}, dependencies);
  assert.deepEqual(result.portOwnerPids, [120]);
  assert.deepEqual(result.confirmedMainPids, [120]);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].sources, ['netstat:8001', 'cim']);
  assert.equal(result.multipleProcesses, false);
  assert.equal(result.commandLineUnavailable, false);
});

test('multiple distinct port owners are reported as multiple processes', async () => {
  const { dependencies } = harness([120, 121], []);
  const result = await detectComfyProcesses('C:\\ComfyUI', {}, dependencies);
  assert.equal(result.multipleProcesses, true);
});

test('CIM commandLine failure uses the single port owner and logs degraded mode', async () => {
  const { dependencies, logs } = harness([120], new Error('Access denied'));
  const result = await detectComfyProcesses('C:\\ComfyUI', { taskId: 'test' }, dependencies);
  assert.equal(result.multipleProcesses, false);
  assert.equal(result.commandLineUnavailable, true);
  assert.deepEqual(result.portOwnerPids, [120]);
  assert.match(logs.join('\n'), /降级模式运行/);
});
