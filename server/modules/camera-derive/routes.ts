// 机位派生模块 HTTP 接口。
// 路径遵循仓库现有约定 /api/generated-scripts/:id/shots/:shotId/*(而非任务书
// §6 的 /api/shots/:shotId —— 项目中不存在无项目上下文的 shot 路由,也不存在
// scene 实体;"场次"按项目(generatedScript)粒度落地,详见 PR 描述 A1)。
// 错误响应统一 { error: string },与 /api/generate-image 系列一致,前端可直接透出。

import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';

import {
  CAMERA_H_KEYS,
  CAMERA_V_KEYS,
  CAMERA_ZOOM_KEYS,
  isCameraH,
  isCameraV,
  isCameraZoom,
  renderCameraInstruction,
  isLargeAngleFromFront,
  LARGE_ANGLE_WARNING,
  type CameraH,
  type CameraV,
  type CameraZoom,
} from '../../constants/cameraVocab.ts';
import {
  CAMERA_DERIVE_PRESET_ID,
  CameraDeriveError,
  loadCameraDeriveWorkflow,
  buildCameraDeriveSnapshot,
  type CameraDeriveWorkflowBundle,
} from './workflow.ts';

type DatabaseInstance = Database.Database;

export interface CameraDeriveDeps {
  // 写 store 必须走 server.ts 的串行写队列,避免并发覆盖 generated_scripts 文档。
  mutateDb: (mutator: (db: any) => void | Promise<void>) => Promise<unknown>;
  // 提交前连通性检查;离线时按任务书 §6.1 返回 502 并透传错误文本。
  checkComfyOnline: () => Promise<{ online: boolean; error?: string }>;
}

function logCameraDerive(event: string, details: Record<string, unknown>) {
  console.log(`[CameraDerive:${event}]`, JSON.stringify({ timestamp: new Date().toISOString(), ...details }));
}

function readScripts(db: DatabaseInstance): any[] {
  const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get() as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shotLabel(script: any, shot: any): string {
  const index = (script.newShots || []).findIndex((item: any) => String(item.id) === String(shot.id));
  return `#${index + 1}`;
}

function masterImageUrl(shot: any): string | null {
  return shot?.generatedImageUrl || shot?.imageUrl || null;
}

function findMasterShot(script: any): any | null {
  return (script.newShots || []).find((item: any) => item?.isMaster === true) || null;
}

function randomSeed(): number {
  return Number(BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) % 9_007_199_254_740_991n);
}

function missingCameraParams(shot: any): string[] {
  const missing: string[] = [];
  if (!isCameraH(shot?.cameraH)) missing.push('cameraH');
  if (!isCameraV(shot?.cameraV)) missing.push('cameraV');
  if (!isCameraZoom(shot?.cameraZoom)) missing.push('cameraZoom');
  return missing;
}

interface DeriveTaskPlan {
  taskId: string;
  shotId: string;
  shotIndex: number;
  seed: number;
  instruction: string;
  cameraH: CameraH;
  cameraV: CameraV;
  cameraZoom: CameraZoom;
  largeAngle: boolean;
  snapshotJson: string;
}

// 单镜头派生的任务落库 + shot 记录更新。调用方保证参数已校验、主帧已就绪。
async function enqueueDeriveTasks(
  db: DatabaseInstance,
  deps: CameraDeriveDeps,
  projectId: string,
  master: any,
  masterImage: string,
  bundle: CameraDeriveWorkflowBundle,
  plans: DeriveTaskPlan[],
  workflowBatchId: string | null,
) {
  const now = () => new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO comfyui_tasks (
      id, projectId, targetId, targetType, viewType, shotIndex, characterName,
      prompt, negativePrompt, seed, model, width, height, status, retryCount,
      apiWorkflowJson, uiWorkflowJson, createdAt, updatedAt,
      workflowPresetId, workflowFamily, workflowBatchId, sourceImageUrl, sourceTaskId, outputNodeId, presetParametersJson,
      characterReferenceImageUrl, characterReferenceTaskId, lockCharacterIdentity, batchOrder
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const supersede = db.prepare(`
    UPDATE comfyui_tasks
    SET status = 'cancelled', supersededByTaskId = ?, error = 'Superseded by camera derive task', completedAt = ?, updatedAt = ?
    WHERE targetId = ? AND viewType = 'main' AND status IN ('pending', 'processing')
  `);

  const tx = db.transaction(() => {
    plans.forEach((plan, order) => {
      supersede.run(plan.taskId, now(), now(), plan.shotId);
      insert.run(
        plan.taskId,
        projectId,
        plan.shotId,
        'shot',
        'main',
        plan.shotIndex,
        null,
        plan.instruction,
        '',
        String(plan.seed),
        bundle.modelName,
        768,
        512,
        'pending',
        0,
        plan.snapshotJson,
        plan.snapshotJson,
        now(),
        now(),
        CAMERA_DERIVE_PRESET_ID,
        'qwen',
        workflowBatchId,
        masterImage,
        null,
        bundle.mappings.saveImageNodeId,
        JSON.stringify({
          cameraDerive: {
            cameraH: plan.cameraH,
            cameraV: plan.cameraV,
            cameraZoom: plan.cameraZoom,
            masterShotId: String(master.id),
            largeAngle: plan.largeAngle,
            nodeMappings: bundle.mappings,
          },
        }),
        null,
        null,
        0,
        workflowBatchId ? order : null,
      );
    });
  });
  tx();

  // 机位参数、派生关系与实际注入指令(审计字段)写回 shot 记录。
  await deps.mutateDb((store: any) => {
    const script = store.generated_scripts.find((item: any) => String(item.id) === String(projectId));
    if (!script) return;
    for (const plan of plans) {
      const shot = (script.newShots || []).find((item: any) => String(item.id) === plan.shotId);
      if (!shot) continue;
      shot.cameraH = plan.cameraH;
      shot.cameraV = plan.cameraV;
      shot.cameraZoom = plan.cameraZoom;
      shot.derivedFromShotId = String(master.id);
      shot.cameraPromptUsed = plan.instruction;
    }
  });

  for (const plan of plans) {
    logCameraDerive('Enqueued', {
      projectId,
      shotId: plan.shotId,
      taskId: plan.taskId,
      masterShotId: String(master.id),
      cameraH: plan.cameraH,
      cameraV: plan.cameraV,
      cameraZoom: plan.cameraZoom,
      seed: plan.seed,
      largeAngle: plan.largeAngle,
      cameraPromptUsed: plan.instruction,
      workflowBatchId,
    });
  }
}

export function registerCameraDeriveModule(app: Express, db: DatabaseInstance, deps: CameraDeriveDeps): void {
  // 机位参数落库(前端下拉框直接调用)。
  app.put('/api/generated-scripts/:id/shots/:shotId/camera', async (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const shotId = String(req.params.shotId);
    const patch: Record<string, unknown> = {};
    const { cameraH, cameraV, cameraZoom } = req.body || {};
    if (cameraH !== undefined) {
      if (cameraH !== null && !isCameraH(cameraH)) return res.status(422).json({ error: `cameraH 必须是 ${CAMERA_H_KEYS.join('/')} 之一` });
      patch.cameraH = cameraH;
    }
    if (cameraV !== undefined) {
      if (cameraV !== null && !isCameraV(cameraV)) return res.status(422).json({ error: `cameraV 必须是 ${CAMERA_V_KEYS.join('/')} 之一` });
      patch.cameraV = cameraV;
    }
    if (cameraZoom !== undefined) {
      if (cameraZoom !== null && !isCameraZoom(cameraZoom)) return res.status(422).json({ error: `cameraZoom 必须是 ${CAMERA_ZOOM_KEYS.join('/')} 之一` });
      patch.cameraZoom = cameraZoom;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: '未提供 cameraH/cameraV/cameraZoom 中的任何字段' });

    let updatedShot: any = null;
    await deps.mutateDb((store: any) => {
      const script = store.generated_scripts.find((item: any) => String(item.id) === projectId);
      const shot = script?.newShots?.find((item: any) => String(item.id) === shotId);
      if (!shot) return;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete shot[key];
        else shot[key] = value;
      }
      updatedShot = { ...shot };
    });
    if (!updatedShot) return res.status(404).json({ error: 'Project or shot not found' });
    logCameraDerive('ParamsSaved', { projectId, shotId, ...patch });
    return res.json({ success: true, shot: updatedShot });
  });

  // 主帧标记:项目内单选,应用层保证 isMaster 至多一个。
  app.put('/api/generated-scripts/:id/shots/:shotId/master', async (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const shotId = String(req.params.shotId);
    const isMaster = req.body?.isMaster !== false;

    let found = false;
    let shots: any[] = [];
    await deps.mutateDb((store: any) => {
      const script = store.generated_scripts.find((item: any) => String(item.id) === projectId);
      if (!script) return;
      const shot = (script.newShots || []).find((item: any) => String(item.id) === shotId);
      if (!shot) return;
      found = true;
      for (const item of script.newShots || []) {
        if (isMaster) item.isMaster = String(item.id) === shotId;
        else if (String(item.id) === shotId) item.isMaster = false;
      }
      shots = script.newShots.map((item: any) => ({ id: item.id, isMaster: !!item.isMaster }));
    });
    if (!found) return res.status(404).json({ error: 'Project or shot not found' });
    logCameraDerive('MasterChanged', { projectId, shotId, isMaster });
    return res.json({ success: true, shots });
  });

  // 单镜头派生(任务书 §6.1)。
  app.post('/api/generated-scripts/:id/shots/:shotId/camera-derive', async (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const shotId = String(req.params.shotId);
    const { cameraH, cameraV, cameraZoom } = req.body || {};
    logCameraDerive('Request', { projectId, shotId, cameraH, cameraV, cameraZoom, seed: req.body?.seed ?? null });
    try {
      if (!isCameraH(cameraH)) return res.status(422).json({ error: `cameraH 缺失或非法,必须是 ${CAMERA_H_KEYS.join('/')} 之一` });
      if (!isCameraV(cameraV)) return res.status(422).json({ error: `cameraV 缺失或非法,必须是 ${CAMERA_V_KEYS.join('/')} 之一` });
      if (!isCameraZoom(cameraZoom)) return res.status(422).json({ error: `cameraZoom 缺失或非法,必须是 ${CAMERA_ZOOM_KEYS.join('/')} 之一` });
      const seed = req.body?.seed === undefined || req.body?.seed === null ? randomSeed() : Number(req.body.seed);
      if (!Number.isSafeInteger(seed) || seed < 0) return res.status(422).json({ error: 'seed 必须是非负安全整数' });

      const script = readScripts(db).find((item: any) => String(item.id) === projectId);
      if (!script) return res.status(404).json({ error: `Project ${projectId} not found` });
      const shot = (script.newShots || []).find((item: any) => String(item.id) === shotId);
      if (!shot) return res.status(404).json({ error: `Shot ${shotId} not found in project ${projectId}` });

      const master = findMasterShot(script);
      if (!master) {
        return res.status(422).json({ error: `项目「${script.newTitle || projectId}」内没有标记主帧:请先在场次内将一个镜头设为主帧(isMaster),再派生机位。` });
      }
      if (String(master.id) === shotId) {
        return res.status(422).json({ error: `镜头 ${shotLabel(script, shot)} 是本场主帧,主帧不能从自身派生。` });
      }
      const masterImage = masterImageUrl(master);
      if (!masterImage) {
        return res.status(422).json({ error: `项目「${script.newTitle || projectId}」的主帧 ${shotLabel(script, master)} 尚未生成图片:请先精修并生成主帧图,再派生机位。` });
      }

      const bundle = loadCameraDeriveWorkflow();
      const online = await deps.checkComfyOnline();
      if (!online.online) {
        logCameraDerive('Error', { projectId, shotId, stage: 'preflight', error: online.error || 'ComfyUI offline' });
        return res.status(502).json({ error: `ComfyUI 未连接:${online.error || '连接失败'}` });
      }

      const instruction = renderCameraInstruction(cameraH, cameraV, cameraZoom);
      const largeAngle = isLargeAngleFromFront(cameraH);
      const shotIndex = (script.newShots || []).findIndex((item: any) => String(item.id) === shotId);
      const plan: DeriveTaskPlan = {
        taskId: crypto.randomUUID(),
        shotId,
        shotIndex,
        seed,
        instruction,
        cameraH,
        cameraV,
        cameraZoom,
        largeAngle,
        snapshotJson: JSON.stringify(buildCameraDeriveSnapshot(bundle, instruction, seed)),
      };
      await enqueueDeriveTasks(db, deps, projectId, master, masterImage, bundle, [plan], null);

      return res.json({
        success: true,
        taskId: plan.taskId,
        status: 'pending',
        provider: 'comfyui',
        workflowPresetId: CAMERA_DERIVE_PRESET_ID,
        seed,
        cameraPromptUsed: instruction,
        derivedFromShotId: String(master.id),
        ...(largeAngle ? { warning: `目标方位与主帧(front)角度差超过 90°:${LARGE_ANGLE_WARNING}` } : {}),
      });
    } catch (error: any) {
      const status = error instanceof CameraDeriveError ? error.status : 500;
      logCameraDerive('Error', { projectId, shotId, stage: 'derive', status, error: error.message });
      return res.status(status).json({ error: error.message });
    }
  });

  // 按场(项目)批量派生(任务书 §6.2)。A3 确认:现有批量生成为同接口两态 ——
  // confirmed !== true 时仅返回 preflight 报告,confirmed === true 时执行。
  app.post('/api/generated-scripts/:id/camera-derive-batch', async (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const requestedShotIds: string[] | null = Array.isArray(req.body?.shotIds)
      ? req.body.shotIds.map((value: unknown) => String(value))
      : null;
    const confirmed = req.body?.confirmed === true;
    try {
      const script = readScripts(db).find((item: any) => String(item.id) === projectId);
      if (!script) return res.status(404).json({ error: `Project ${projectId} not found` });
      const allShots: any[] = script.newShots || [];

      const master = findMasterShot(script);
      if (!master) {
        return res.status(422).json({ error: `项目「${script.newTitle || projectId}」内没有标记主帧:请先在场次内将一个镜头设为主帧(isMaster),再批量派生。` });
      }
      const masterImage = masterImageUrl(master);
      if (!masterImage) {
        return res.status(422).json({ error: `项目「${script.newTitle || projectId}」的主帧 ${shotLabel(script, master)} 尚未生成图片:请先精修并生成主帧图,再批量派生。` });
      }

      if (requestedShotIds) {
        const known = new Set(allShots.map((item: any) => String(item.id)));
        const unknown = requestedShotIds.filter(id => !known.has(id));
        if (unknown.length) return res.status(422).json({ error: `以下 shotIds 不在项目内:${unknown.join(', ')}` });
      }

      // 缺省范围 = 全部非主帧镜头;显式 shotIds 时按请求列表(仍排除主帧)。
      const scope = allShots.filter((item: any) => {
        if (String(item.id) === String(master.id)) return false;
        return requestedShotIds ? requestedShotIds.includes(String(item.id)) : true;
      });

      const missingParams = scope
        .map((item: any) => ({ shot: item, missing: missingCameraParams(item) }))
        .filter(entry => entry.missing.length)
        .map(entry => ({
          shotId: String(entry.shot.id),
          shotLabel: shotLabel(script, entry.shot),
          missing: entry.missing,
        }));
      const derivable = scope.filter((item: any) => !missingCameraParams(item).length);
      const largeAngleWarnings = derivable
        .filter((item: any) => isLargeAngleFromFront(item.cameraH))
        .map((item: any) => ({
          shotId: String(item.id),
          shotLabel: shotLabel(script, item),
          cameraH: item.cameraH,
          warning: LARGE_ANGLE_WARNING,
        }));

      const preflight = {
        projectId,
        masterShotId: String(master.id),
        masterShotLabel: shotLabel(script, master),
        masterImageUrl: masterImage,
        total: derivable.length,
        derivableShotIds: derivable.map((item: any) => String(item.id)),
        missingParams,
        largeAngleWarnings,
      };
      logCameraDerive('BatchPreflight', { ...preflight, confirmed });

      if (derivable.length === 0) {
        return res.json({ success: true, requiresConfirmation: false, count: 0, preflight, message: '没有可派生的镜头(缺机位参数或全部为主帧)' });
      }
      if (!confirmed) {
        return res.json({ success: true, requiresConfirmation: true, preflight });
      }

      const bundle = loadCameraDeriveWorkflow();
      const online = await deps.checkComfyOnline();
      if (!online.online) {
        logCameraDerive('Error', { projectId, stage: 'batch-preflight', error: online.error || 'ComfyUI offline' });
        return res.status(502).json({ error: `ComfyUI 未连接:${online.error || '连接失败'}` });
      }

      const workflowBatchId = crypto.randomUUID();
      const plans: DeriveTaskPlan[] = derivable.map((item: any) => {
        const seed = randomSeed();
        const instruction = renderCameraInstruction(item.cameraH, item.cameraV, item.cameraZoom);
        return {
          taskId: crypto.randomUUID(),
          shotId: String(item.id),
          shotIndex: allShots.findIndex((candidate: any) => String(candidate.id) === String(item.id)),
          seed,
          instruction,
          cameraH: item.cameraH,
          cameraV: item.cameraV,
          cameraZoom: item.cameraZoom,
          largeAngle: isLargeAngleFromFront(item.cameraH),
          snapshotJson: JSON.stringify(buildCameraDeriveSnapshot(bundle, instruction, seed)),
        };
      });
      await enqueueDeriveTasks(db, deps, projectId, master, masterImage, bundle, plans, workflowBatchId);
      logCameraDerive('BatchEnqueued', { projectId, workflowBatchId, queued: plans.length });

      return res.json({
        success: true,
        requiresConfirmation: false,
        batchId: workflowBatchId,
        queued: plans.length,
        preflight,
        tasks: plans.map(plan => ({ shotId: plan.shotId, taskId: plan.taskId, seed: plan.seed })),
      });
    } catch (error: any) {
      const status = error instanceof CameraDeriveError ? error.status : 500;
      logCameraDerive('Error', { projectId, stage: 'batch', status, error: error.message });
      return res.status(status).json({ error: error.message });
    }
  });
}
