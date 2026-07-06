// Gemini 通用封装 —— 从 server.ts 既有实现中逐字提取(classifyGeminiImageError /
// withGeminiTimeout / Files API 上传轮询模式),供 server/modules/ 下的模块复用。
// server.ts 是不导出符号的入口脚本,无法被直接 import,因此在此提取;
// server.ts 内部的原始副本保持不动,统一改为引用本文件属于后续独立重构。

import { GoogleGenAI } from '@google/genai';

export type GeminiErrorCode =
  | 'GEMINI_TIMEOUT'
  | 'GEMINI_NETWORK'
  | 'GEMINI_AUTH'
  | 'GEMINI_RATE_LIMIT'
  | 'GEMINI_INVALID_RESPONSE'
  | 'GEMINI_UPSTREAM'
  | 'GEMINI_NOT_CONFIGURED';

export type ClassifiedGeminiError = {
  code: GeminiErrorCode;
  status: number;
  retryable: boolean;
  message: string;
};

export function classifyGeminiError(error: any): ClassifiedGeminiError {
  const message = String(error?.message || error || 'Unknown Gemini error');
  const normalized = message.toLowerCase();
  const upstreamStatus = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  if (error?.code === 'GEMINI_NOT_CONFIGURED') {
    return { code: 'GEMINI_NOT_CONFIGURED', status: 500, retryable: false, message: 'GEMINI_API_KEY environment variable is not configured.' };
  }
  if (error?.code === 'GEMINI_TIMEOUT' || normalized.includes('timed out') || normalized.includes('timeout')) {
    return { code: 'GEMINI_TIMEOUT', status: 504, retryable: true, message: 'Gemini request timed out.' };
  }
  if (upstreamStatus === 401 || upstreamStatus === 403 || normalized.includes('api key') || normalized.includes('permission_denied')) {
    return { code: 'GEMINI_AUTH', status: 502, retryable: false, message: 'Gemini authentication failed. Check GEMINI_API_KEY.' };
  }
  if (upstreamStatus === 429 || normalized.includes('rate limit') || normalized.includes('resource_exhausted')) {
    return { code: 'GEMINI_RATE_LIMIT', status: 429, retryable: true, message: 'Gemini rate limit reached. Retry later.' };
  }
  if (error instanceof SyntaxError || error?.code === 'GEMINI_INVALID_RESPONSE') {
    return { code: 'GEMINI_INVALID_RESPONSE', status: 502, retryable: false, message: `Gemini returned an invalid structured response: ${message}` };
  }
  if (normalized.includes('fetch failed') || normalized.includes('econnreset') || normalized.includes('enotfound') || normalized.includes('network')) {
    return { code: 'GEMINI_NETWORK', status: 502, retryable: true, message: 'Cannot reach Gemini API from the server.' };
  }
  return { code: 'GEMINI_UPSTREAM', status: 502, retryable: upstreamStatus >= 500 || upstreamStatus === 0, message };
}

export async function withGeminiTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Gemini request timed out after ${timeoutMs}ms`), { code: 'GEMINI_TIMEOUT' })), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw Object.assign(new Error('GEMINI_API_KEY environment variable is not configured.'), { code: 'GEMINI_NOT_CONFIGURED' });
  return new GoogleGenAI({ apiKey });
}

// Files API 上传 + 轮询直到 ACTIVE(同 server.ts /api/analyze 的处理方式)。
// 调用方负责在使用完毕后调用 deleteGeminiFile 清理。
export async function uploadFileToGemini(
  ai: GoogleGenAI,
  fullFilePath: string,
  mimeType: string,
  logger: Pick<Console, 'log'> = console,
): Promise<{ uri: string; name: string; mimeType: string }> {
  let fileInfo = await ai.files.upload({ file: fullFilePath, config: { mimeType } });
  logger.log(`[Gemini] File uploaded, URI: ${fileInfo.uri}. State: ${fileInfo.state}`);
  while (fileInfo.state === 'PROCESSING') {
    logger.log('[Gemini] File is processing, waiting 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    fileInfo = await ai.files.get({ name: fileInfo.name! });
  }
  if (fileInfo.state === 'FAILED') {
    throw new Error('Gemini API file processing failed.');
  }
  return { uri: fileInfo.uri!, name: fileInfo.name!, mimeType: fileInfo.mimeType || mimeType };
}

export async function deleteGeminiFile(ai: GoogleGenAI, name: string, logger: Pick<Console, 'warn'> = console): Promise<void> {
  try {
    await ai.files.delete({ name });
  } catch (err) {
    logger.warn('[Gemini] Failed to clean up file from Gemini storage:', err);
  }
}

export function videoMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.avi')) return 'video/x-msvideo';
  return 'video/mp4';
}
