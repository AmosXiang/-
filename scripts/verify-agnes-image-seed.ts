import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { AgnesClient } from '../server/providers/agnesClient.ts';
import { AgnesImageProvider } from '../server/providers/imageGen/agnesImageProvider.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function sha256(file: string) {
  return crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
}

async function dHash(file: string): Promise<string> {
  const { data } = await sharp(file).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

function hamming(a: string, b: string): number {
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor) { distance += Number(xor & 1n); xor >>= 1n; }
  return distance;
}

const apiKey = String(process.env.AGNES_API_KEY || '');
if (!apiKey) throw new Error('AGNES_API_KEY is required.');
const width = Number(arg('width', '1024'));
const height = Number(arg('height', '1024'));
const seed = Number(arg('seed', '424242'));
const prompt = arg('prompt', 'A cinematic moonlit modern mansion on a remote island, no people, wide establishing shot.');
const uploadsDir = path.resolve(arg('uploads-dir', 'uploads'));
const provider = new AgnesImageProvider(new AgnesClient(apiKey), uploadsDir);
const request = { shotId: 0, prompt, width, height, seed };
const first = await provider.generate(request);
const second = await provider.generate(request);
const firstPath = path.join(uploadsDir, first.imagePath.replace(/^\/uploads\//, ''));
const secondPath = path.join(uploadsDir, second.imagePath.replace(/^\/uploads\//, ''));
const sha = [await sha256(firstPath), await sha256(secondPath)];
const hashes = [await dHash(firstPath), await dHash(secondPath)];
const distance = hamming(hashes[0], hashes[1]);
const conclusion = sha[0] === sha[1] ? 'byte_reproducible' : distance <= 8 ? 'semantic_reproducible' : 'not_reproducible';
console.log(JSON.stringify({
  prompt,
  size: `${width}x${height}`,
  seed_requested: seed,
  seed_forwarded: false,
  limitation: 'Live Agnes API returned HTTP 422 whenever seed was included; seedUsed is therefore undefined.',
  outputs: [
    { request_id: first.requestId, image_path: first.imagePath, sha256: sha[0], dhash: hashes[0] },
    { request_id: second.requestId, image_path: second.imagePath, sha256: sha[1], dhash: hashes[1] },
  ],
  dhash_distance: distance,
  conclusion,
}, null, 2));
