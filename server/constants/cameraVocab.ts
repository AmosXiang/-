// 机位派生词表:结构化机位参数 → 标准英文机位短语的确定性映射。
// 禁止运行时经 LLM 改写;同参数渲染结果必须字节级一致(验收依赖此性质)。

export const CAMERA_H = {
  front:        "front view",
  front_right:  "front-right three-quarter view",
  right:        "right side view",
  back_right:   "back-right three-quarter view",
  back:         "back view",
  back_left:    "back-left three-quarter view",
  left:         "left side view",
  front_left:   "front-left three-quarter view",
} as const;

export const CAMERA_V = {
  low:      "low-angle shot",
  eye:      "eye-level shot",
  elevated: "elevated shot",
  high:     "high-angle shot",
} as const;

export const CAMERA_ZOOM = {
  close_up:   "close-up",
  medium_cu:  "medium close-up",
  medium:     "medium shot",
  full:       "full shot",
  wide:       "wide shot",
} as const;

export type CameraH = keyof typeof CAMERA_H;
export type CameraV = keyof typeof CAMERA_V;
export type CameraZoom = keyof typeof CAMERA_ZOOM;

export const CAMERA_H_KEYS = Object.keys(CAMERA_H) as CameraH[];
export const CAMERA_V_KEYS = Object.keys(CAMERA_V) as CameraV[];
export const CAMERA_ZOOM_KEYS = Object.keys(CAMERA_ZOOM) as CameraZoom[];

// 指令模板单处定义。{H}/{V}/{Z} 为唯一插值点。
export const CAMERA_INSTRUCTION_TEMPLATE =
  "Rotate the camera to the {H}, {V}, {Z}.\n" +
  "Keep the character's identity, outfit, pose intent, lighting, props and set unchanged.";

export function isCameraH(value: unknown): value is CameraH {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CAMERA_H, value);
}
export function isCameraV(value: unknown): value is CameraV {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CAMERA_V, value);
}
export function isCameraZoom(value: unknown): value is CameraZoom {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CAMERA_ZOOM, value);
}

// 确定性编译:枚举 key → 完整英文机位指令。非法 key 直接抛错,不静默降级。
export function renderCameraInstruction(h: CameraH, v: CameraV, zoom: CameraZoom): string {
  if (!isCameraH(h)) throw new Error(`Unknown cameraH key: ${String(h)}`);
  if (!isCameraV(v)) throw new Error(`Unknown cameraV key: ${String(v)}`);
  if (!isCameraZoom(zoom)) throw new Error(`Unknown cameraZoom key: ${String(zoom)}`);
  return CAMERA_INSTRUCTION_TEMPLATE
    .replace("{H}", CAMERA_H[h])
    .replace("{V}", CAMERA_V[v])
    .replace("{Z}", CAMERA_ZOOM[zoom]);
}

// 水平方位角(度),主帧默认朝向 front = 0°。
export const CAMERA_H_DEGREES: Record<CameraH, number> = {
  front: 0,
  front_right: 45,
  right: 90,
  back_right: 135,
  back: 180,
  back_left: 225,
  left: 270,
  front_left: 315,
};

// 与主帧(front)的最小角度差 > 90° 视为大角度派生,preflight 需输出 warning。
export function cameraHAngleFromFront(h: CameraH): number {
  const raw = Math.abs(CAMERA_H_DEGREES[h] - CAMERA_H_DEGREES.front) % 360;
  return Math.min(raw, 360 - raw);
}

export function isLargeAngleFromFront(h: CameraH): boolean {
  return cameraHAngleFromFront(h) > 90;
}

export const LARGE_ANGLE_WARNING =
  "建议两步派生(先 90° 中间帧)或接受更高漂移风险";
