// 机位派生工作流加载与参数注入。
// A2 确认:现有预设按 manifest 声明的 node id 注入;本工作流由 Amos 在 ComfyUI
// 手工搭建导出(§8),node id 在导出前未知,故按任务契约 §5 用节点 _meta.title
// (INPUT_master_image / INPUT_camera_instruction / INPUT_seed)在加载时确定性
// 解析为 node id,解析结果随任务快照存储。加载失败/标题缺失一律抛错,不静默降级。

import fs from 'node:fs';
import path from 'node:path';

export const CAMERA_DERIVE_PRESET_ID = '04_qwen_edit_2512_camera_derive';
export const CAMERA_DERIVE_WORKFLOW_FILE = path.join('workflows', '04_qwen_edit_2512_camera_derive.json');

export const INPUT_MASTER_IMAGE_TITLE = 'INPUT_master_image';
export const INPUT_CAMERA_INSTRUCTION_TITLE = 'INPUT_camera_instruction';
export const INPUT_SEED_TITLE = 'INPUT_seed';

export class CameraDeriveError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'CameraDeriveError';
  }
}

type ComfyApiNode = {
  class_type?: string;
  inputs?: Record<string, any>;
  _meta?: { title?: string };
};
export type ComfyApiWorkflow = Record<string, ComfyApiNode>;

export interface CameraDeriveNodeMappings {
  loadImageNodeId: string;
  loadImageInputKey: string;
  promptNodeId: string;
  promptInputKey: string;
  seedNodeId: string;
  seedInputKey: string;
  saveImageNodeId: string | null;
}

export interface CameraDeriveWorkflowBundle {
  workflow: ComfyApiWorkflow;
  mappings: CameraDeriveNodeMappings;
  modelName: string;
}

function findByTitle(workflow: ComfyApiWorkflow, title: string): [string, ComfyApiNode] {
  const matches = Object.entries(workflow).filter(
    ([, node]) => String(node?._meta?.title || '').trim() === title,
  );
  if (matches.length === 0) {
    const seen = Object.values(workflow)
      .map(node => String(node?._meta?.title || '').trim())
      .filter(Boolean);
    throw new CameraDeriveError(
      500,
      `机位派生工作流缺少标题为 '${title}' 的节点。当前工作流中的节点标题:${seen.length ? seen.join(', ') : '(无标题节点)'}。请在 ComfyUI 中按契约命名后重新导出 API JSON。`,
      'WORKFLOW_NODE_TITLE_MISSING',
    );
  }
  if (matches.length > 1) {
    throw new CameraDeriveError(
      500,
      `机位派生工作流中标题 '${title}' 出现 ${matches.length} 次(节点 ${matches.map(([id]) => id).join(', ')}),无法确定注入点。`,
      'WORKFLOW_NODE_TITLE_DUPLICATE',
    );
  }
  return matches[0] as [string, ComfyApiNode];
}

function pickInputKey(node: ComfyApiNode, nodeId: string, candidates: string[], label: string): string {
  const key = candidates.find(candidate =>
    node.inputs && Object.prototype.hasOwnProperty.call(node.inputs, candidate),
  );
  if (!key) {
    throw new CameraDeriveError(
      500,
      `机位派生工作流 ${label} 节点 ${nodeId}(${node.class_type || 'unknown'})没有可注入输入(候选:${candidates.join(', ')};实际:${Object.keys(node.inputs || {}).join(', ') || '无'})。`,
      'WORKFLOW_INPUT_KEY_MISSING',
    );
  }
  return key;
}

export function loadCameraDeriveWorkflow(baseDir: string = process.cwd()): CameraDeriveWorkflowBundle {
  const filePath = path.resolve(baseDir, CAMERA_DERIVE_WORKFLOW_FILE);
  if (!fs.existsSync(filePath)) {
    throw new CameraDeriveError(
      503,
      `机位派生工作流模板未安装:未找到 ${CAMERA_DERIVE_WORKFLOW_FILE}。请在 ComfyUI 中搭建派生工作流(节点标题:${INPUT_MASTER_IMAGE_TITLE} / ${INPUT_CAMERA_INSTRUCTION_TITLE} / ${INPUT_SEED_TITLE}),导出 API 格式 JSON 后放入该路径(环境准备 §8)。`,
      'WORKFLOW_NOT_INSTALLED',
    );
  }
  let workflow: ComfyApiWorkflow;
  try {
    workflow = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error: any) {
    throw new CameraDeriveError(500, `机位派生工作流 JSON 解析失败(${filePath}):${error.message}`, 'WORKFLOW_INVALID_JSON');
  }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new CameraDeriveError(
      500,
      `机位派生工作流不是 ComfyUI API 格式(应为 {nodeId: {class_type, inputs}} 映射)。请使用"导出(API)"而非普通保存。`,
      'WORKFLOW_NOT_API_FORMAT',
    );
  }

  const [loadImageNodeId, loadImageNode] = findByTitle(workflow, INPUT_MASTER_IMAGE_TITLE);
  if (loadImageNode.class_type !== 'LoadImage') {
    throw new CameraDeriveError(
      500,
      `'${INPUT_MASTER_IMAGE_TITLE}' 节点 ${loadImageNodeId} 的类型是 ${loadImageNode.class_type || 'unknown'},应为 LoadImage。`,
      'WORKFLOW_NODE_CLASS_MISMATCH',
    );
  }
  const loadImageInputKey = pickInputKey(loadImageNode, loadImageNodeId, ['image'], INPUT_MASTER_IMAGE_TITLE);

  const [promptNodeId, promptNode] = findByTitle(workflow, INPUT_CAMERA_INSTRUCTION_TITLE);
  const promptInputKey = pickInputKey(promptNode, promptNodeId, ['prompt', 'text'], INPUT_CAMERA_INSTRUCTION_TITLE);

  const [seedNodeId, seedNode] = findByTitle(workflow, INPUT_SEED_TITLE);
  const seedInputKey = pickInputKey(seedNode, seedNodeId, ['seed', 'noise_seed'], INPUT_SEED_TITLE);

  const saveImageEntry = Object.entries(workflow).find(([, node]) => node?.class_type === 'SaveImage');

  const modelLoader = Object.values(workflow).find(node =>
    ['UNETLoader', 'UnetLoaderGGUF', 'CheckpointLoaderSimple'].includes(String(node?.class_type)),
  );
  const modelName = String(
    modelLoader?.inputs?.unet_name || modelLoader?.inputs?.ckpt_name || 'qwen-image-edit-2512',
  );

  return {
    workflow,
    mappings: {
      loadImageNodeId,
      loadImageInputKey,
      promptNodeId,
      promptInputKey,
      seedNodeId,
      seedInputKey,
      saveImageNodeId: saveImageEntry ? saveImageEntry[0] : null,
    },
    modelName,
  };
}

// 生成任务快照:注入机位指令与 seed。主帧图片文件名由队列 worker 在提交前
// 通过现有 /upload/image 机制(A4)上传后注入 loadImage 节点,此处不注入。
export function buildCameraDeriveSnapshot(
  bundle: CameraDeriveWorkflowBundle,
  cameraInstruction: string,
  seed: number,
): ComfyApiWorkflow {
  const snapshot: ComfyApiWorkflow = JSON.parse(JSON.stringify(bundle.workflow));
  snapshot[bundle.mappings.promptNodeId].inputs![bundle.mappings.promptInputKey] = cameraInstruction;
  snapshot[bundle.mappings.seedNodeId].inputs![bundle.mappings.seedInputKey] = seed;
  return snapshot;
}

// 供队列 worker 使用:从任务行的 presetParametersJson 恢复注入点映射。
// 仅对 camera-derive 预设返回映射,其余预设返回 null(走 manifest 路径)。
export function cameraDeriveTaskNodeMappings(task: {
  workflowPresetId?: string | null;
  presetParametersJson?: string | null;
}): CameraDeriveNodeMappings | null {
  if (task?.workflowPresetId !== CAMERA_DERIVE_PRESET_ID) return null;
  try {
    const parameters = JSON.parse(task.presetParametersJson || '{}');
    const mappings = parameters?.cameraDerive?.nodeMappings;
    if (mappings?.loadImageNodeId && mappings?.loadImageInputKey) return mappings;
  } catch {
    // fall through
  }
  return null;
}
