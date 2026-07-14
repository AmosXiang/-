import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyVideoGenerationError, generateSingleShotVideo, VideoGenerationError } from './video-generation.ts';

test('classifies invalid API keys', () => assert.equal(classifyVideoGenerationError(Object.assign(new Error('API key not valid'), { status: 401 })).code, 'INVALID_API_KEY'));
test('classifies network timeouts', () => assert.equal(classifyVideoGenerationError(new Error('fetch failed: ETIMEDOUT')).code, 'NETWORK_TIMEOUT'));
test('classifies content moderation rejection', () => assert.equal(classifyVideoGenerationError(new Error('RAI media filtered by safety policy')).code, 'CONTENT_MODERATION_REJECTED'));
test('classifies invalid parameters', () => assert.equal(classifyVideoGenerationError(Object.assign(new Error('invalid argument'), { status: 400 })).code, 'INVALID_PARAMETERS'));
test('rejects a missing API key before making a request', async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(generateSingleShotVideo({ prompt: 'test', references: [], outputPath: 'unused.mp4' }), (error: unknown) => error instanceof VideoGenerationError && error.code === 'INVALID_API_KEY');
  if (previous) process.env.GEMINI_API_KEY = previous;
});
