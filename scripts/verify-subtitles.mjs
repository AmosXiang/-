import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-verify-'));
const srtPath = path.join(tempDir, '中文 字幕.srt');
const outputPath = path.join(tempDir, 'result.mp4');
const filterPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
fs.writeFileSync(srtPath, '\uFEFF1\n00:00:00,000 --> 00:00:01,000\n中文、引号“测试”：第二行\n正常显示\n', 'utf8');

const filter = `subtitles=filename='${filterPath}':charenc=UTF-8:force_style='FontName=Microsoft YaHei,FontSize=24,Alignment=2'`;
const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1', '-vf', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', outputPath], { encoding: 'utf8' });
try {
  if (result.status !== 0) throw new Error(result.stderr || `FFmpeg exited ${result.status}`);
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new Error('Subtitle output video was not created');
  console.log(JSON.stringify({ status: 'PASS', outputBytes: fs.statSync(outputPath).size, encoding: 'utf8-bom', filter: 'subtitles/libass' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
