import { agnesImageRateLimiter } from './imageGen/rateLimiter.ts';

export class AgnesApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = 'AgnesApiError';
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function errorMessage(raw: unknown, status: number | null): string {
  const body = record(raw);
  const error = record(body.error);
  return String(error.message || error.detail || body.message || body.detail || (status ? `Agnes request failed with HTTP ${status}` : 'Agnes network request failed.'));
}

function log(event: string, details: Record<string, unknown>) {
  console.log('[AgnesClient]', JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

export interface AgnesImageRequest {
  model: 'agnes-image-2.1-flash' | 'agnes-image-2.0-flash';
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  referenceDataUrls?: string[];
}

export class AgnesClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl = process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1',
  ) {
    if (!apiKey.trim()) throw new Error('AGNES_API_KEY environment variable is not configured.');
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async generateImage(req: AgnesImageRequest): Promise<{ raw: unknown; requestId: string; status: number }> {
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      size: `${req.width}x${req.height}`,
    };
    if (req.referenceDataUrls?.length) {
      body.tags = ['img2img'];
      body.extra_body = { image: req.referenceDataUrls, response_format: 'url' };
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const queuedAt = Date.now();
      const permit = await agnesImageRateLimiter.acquire(req.width, req.height, 120_000);
      log('image_rate_limit_acquired', { tier: permit.tier, queued_ahead: permit.queuedAhead, queue_ms: Date.now() - queuedAt, attempt });
      const startedAt = Date.now();
      log('image_request', { method: 'POST', path: '/images/generations', model: req.model, size: body.size, seed_requested: req.seed ?? null, seed_forwarded: false, reference_count: req.referenceDataUrls?.length || 0, attempt });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await fetch(`${this.baseUrl}/images/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        let raw: unknown = null;
        if (text) {
          try { raw = JSON.parse(text); } catch { raw = { raw_text: text }; }
        }
        const payload = record(raw);
        const requestId = String(response.headers.get('x-request-id') || payload.request_id || payload.id || crypto.randomUUID());
        log('image_response', { request_id: requestId, status_code: response.status, duration_ms: Date.now() - startedAt, attempt, response: raw });
        if (response.ok) return { raw, requestId, status: response.status };
        const error = new AgnesApiError(errorMessage(raw, response.status), response.status, raw);
        if (response.status < 500 || attempt === 3) throw error;
        lastError = error;
      } catch (error: any) {
        if (error instanceof AgnesApiError && (error.status === null || error.status < 500)) throw error;
        lastError = error;
        if (attempt === 3) {
          const message = error?.name === 'AbortError' ? 'Agnes image request timed out after 120000ms.' : String(error?.message || error);
          throw new AgnesApiError(message, error instanceof AgnesApiError ? error.status : null, error instanceof AgnesApiError ? error.raw : null);
        }
        log('image_retry', { attempt, next_attempt: attempt + 1, status_code: error instanceof AgnesApiError ? error.status : null, error: String(error?.message || error) });
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }
}
