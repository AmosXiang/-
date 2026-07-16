export interface ApiFetchRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryUnsafeMethod?: boolean;
}

const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);

function waitForRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const finish = () => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    };
    const handleAbort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = window.setTimeout(finish, delayMs);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function connectionError(cause: unknown): Error {
  const error = new Error('暂时无法连接应用后端，请等待服务启动完成后重试。');
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

/**
 * Retries read-only API calls during the short Vite/Express startup race.
 * Mutating requests are never retried unless the caller explicitly marks them safe.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ApiFetchRetryOptions = {},
): Promise<Response> {
  const method = String(init.method || 'GET').toUpperCase();
  const canRetry = method === 'GET' || method === 'HEAD' || options.retryUnsafeMethod === true;
  const attempts = canRetry ? Math.max(1, options.attempts ?? 3) : 1;
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 2_000);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === attempts - 1) {
        return response;
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      lastError = error;
      if (attempt === attempts - 1) throw connectionError(error);
    }

    await waitForRetry(Math.min(maxDelayMs, baseDelayMs * (2 ** attempt)), init.signal);
  }

  throw connectionError(lastError);
}
