# Image generation providers

## Routing

Rules are loaded from `config/imageGenRouting.json` in order. Master frames and shots with bound characters use `comfyui_local`; other shots use `agnes`. `forceProvider` is the only override. A provider error is recorded and returned without invoking the other provider.

### Rollout state: autoRoute is ON

`config/imageGenRouting.json` has a top-level `autoRoute` flag, currently `true`: normal shot generation requests are routed by the rules above. The frontend handles both response contracts by shape: a synchronous Agnes `{ provider: 'agnes', imageUrl }` updates the shot state directly (the server has already persisted it), while a ComfyUI `{ taskId }` follows the existing async polling flow. Explicitly ComfyUI-bound UI operations (the ComfyUI parameter dialog, shot advanced-adjust which opens the ComfyUI GUI) send `forceProvider: 'comfyui_local'`. Set `autoRoute` back to `false` to instantly restore pure legacy behavior without redeploying code.

### Requests that never enter provider routing

Regardless of `autoRoute`, the middleware passes through (`next()`) any shot request that is an operation on an existing image rather than new shot generation:

- `sourceImageUrl` present (upscale, re-render from a source image);
- `presetId` containing `upscale` (e.g. `04_esrgan_upscale`) or `presetRole: "upscale"`;
- requests without a usable `prompt` (unless `forceProvider` is explicit, in which case validation rejects them with 400).

### Duplicate submission guard

While an Agnes generation for a given `(projectId, shotId)` is in flight, a second POST for the same shot returns 409 without calling Agnes, mirroring the ComfyUI pipeline's 409 semantics and preventing double billing from double clicks.

### Audit caveat for the ComfyUI path

For `comfyui_local` decisions the audit row is written at routing time, before the async task completes. Only synchronous HTTP errors are reflected back into the audit; the eventual ComfyUI task outcome lives in `comfyui_tasks`, not in `shot_image_provider_audit`.

The repository does not have a relational `shots` table. Shots are JSON objects inside SQLite `store.generated_scripts.newShots`. The migration therefore adds the four audit fields to each shot JSON object and creates `shot_image_provider_audit` as a queryable companion table. This preserves task A camera fields whether they are already present or merged later.

Character presence uses `matchedCharacterIds`, with legacy `characterIds`, `characters`, and `characterNames` as compatibility inputs. Missing `isMaster`/`is_master` is treated as false and emits one startup/runtime warning.

## Agnes contract and retention

- Base URL verified live: `https://apihub.agnes-ai.com/v1`.
- Text-to-image: `agnes-image-2.1-flash`.
- Reference image generation: `agnes-image-2.0-flash`; references are local files converted to Data URI and placed in `extra_body.image`.
- Width and height are validated locally as multiples of 16 before rate limiting or HTTP.
- Pure text-to-image does not send `extra_body.response_format`.
- Only network failures and HTTP 5xx are retried, at most twice. Every retry is logged.
- Image rate limits are independent of video polling: 1K 20 RPM, 2K 10 RPM, 3K/4K 1 RPM.

The downloaded local image is the only truth source. Remote URLs are audit data only. A successful response is downloaded immediately (with a 120s timeout), decoded with Sharp, written atomically below `uploads/images/agnes/`, decoded again, and checked for non-zero size. Deleting that local file is irreversible; the remote URL and a repeated prompt cannot be treated as recovery mechanisms.

## Verified limitation: seed is not accepted

On 2026-07-12, live requests to `agnes-image-2.1-flash` succeeded with `model + prompt + size`, but returned HTTP 422 when `seed` was sent either at the top level or in `extra_body`. The provider therefore records `seed_requested` and `seed_forwarded:false`, returns `seedUsed: undefined`, and never claims deterministic seed support. This is explicit behavior, not a silent fallback.

`scripts/verify-agnes-image-seed.ts` runs two otherwise identical requests, prints both SHA-256 and dHash values, and classifies the observed result without presuming reproducibility.
