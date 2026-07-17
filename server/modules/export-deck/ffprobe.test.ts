import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { checkFfprobeAvailability, parseFfprobeOutput, resolveFfprobeCommand } from './ffprobe.ts';

test('resolveFfprobeCommand honors an explicit FFPROBE_PATH', () => {
  const resolution = resolveFfprobeCommand({
    ffprobePath: ' C:/tools/ffprobe.exe ',
    ffmpegPath: 'C:/other/ffmpeg.exe',
    fileExists: candidate => candidate === 'C:/tools/ffprobe.exe',
  });
  assert.deepEqual(resolution, {
    command: 'C:/tools/ffprobe.exe',
    source: 'FFPROBE_PATH',
    warning: null,
  });
});

test('resolveFfprobeCommand uses an existing sibling of FFMPEG_PATH', () => {
  const ffmpegPath = path.join('C:', 'tools', 'ffmpeg.exe');
  const expected = path.join('C:', 'tools', 'ffprobe.exe');
  const resolution = resolveFfprobeCommand({
    ffmpegPath,
    fileExists: candidate => candidate === expected,
  });
  assert.deepEqual(resolution, {
    command: expected,
    source: 'FFMPEG_PATH_SIBLING',
    warning: null,
  });
});

test('resolveFfprobeCommand never invents a missing custom ffprobe binary', () => {
  const resolution = resolveFfprobeCommand({
    ffmpegPath: 'C:/imageio/ffmpeg-win-x86_64-v7.1.exe',
    fileExists: () => false,
  });
  assert.equal(resolution.command, 'ffprobe');
  assert.equal(resolution.source, 'PATH');
  assert.match(resolution.warning || '', /No ffprobe sibling/);
});

test('resolveFfprobeCommand warns for a missing explicit executable', () => {
  const resolution = resolveFfprobeCommand({
    ffprobePath: 'C:/missing/ffprobe.exe',
    fileExists: () => false,
  });
  assert.equal(resolution.command, 'C:/missing/ffprobe.exe');
  assert.equal(resolution.source, 'FFPROBE_PATH');
  assert.match(resolution.warning || '', /does not exist/);
});

test('checkFfprobeAvailability runs the bounded version self-check', () => {
  let received: any[] | null = null;
  const availability = checkFfprobeAvailability('C:/tools/ffprobe.exe', ((...args: any[]) => {
    received = args;
    return Buffer.from('ffprobe version fixture');
  }) as any);
  assert.deepEqual(availability, { available: true, errorCode: null });
  assert.deepEqual(received, [
    'C:/tools/ffprobe.exe',
    ['-version'],
    { encoding: 'utf8', timeout: 5_000, windowsHide: true },
  ]);
});

test('checkFfprobeAvailability returns a stable error code', () => {
  const availability = checkFfprobeAvailability('ffprobe', (() => {
    const error: NodeJS.ErrnoException = new Error('spawn failed');
    error.code = 'ENOENT';
    throw error;
  }) as any);
  assert.deepEqual(availability, { available: false, errorCode: 'ENOENT' });
});

test('parseFfprobeOutput parses ratio and decimal frame rates', () => {
  assert.deepEqual(parseFfprobeOutput(JSON.stringify({ streams: [{
    width: 1088,
    height: 832,
    r_frame_rate: '24000/1001',
    duration: '3.375',
  }] })), {
    width: 1088,
    height: 832,
    fps: 24000 / 1001,
    durationSec: 3.375,
  });
  assert.deepEqual(parseFfprobeOutput(JSON.stringify({ streams: [{
    width: 1920,
    height: 1080,
    r_frame_rate: '24',
    duration: 0,
  }] })), {
    width: 1920,
    height: 1080,
    fps: 24,
    durationSec: 0,
  });
});

test('parseFfprobeOutput rejects malformed or non-physical metadata', () => {
  assert.equal(parseFfprobeOutput('not-json'), null);
  assert.equal(parseFfprobeOutput(JSON.stringify({ streams: [] })), null);
  assert.equal(parseFfprobeOutput(JSON.stringify({ streams: [{
    width: 0,
    height: 832,
    r_frame_rate: '24/0',
    duration: '-1',
  }] })), null);
});
