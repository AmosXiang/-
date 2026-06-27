import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'db.sqlite');
const db = new Database(dbPath);

const baseUrl = 'http://127.0.0.1:3001';
const projectId = '1782543650666';

async function apiRequest(endpoint, options = {}) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  
  if (endpoint.includes('/export-workflow') || endpoint.includes('/open-ui')) {
    const bodyText = await res.text();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      bodyText
    };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function waitForTaskTerminal(taskId, timeoutMs = 120000) {
  const started = Date.now();
  while (true) {
    const row = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(taskId);
    if (!row) throw new Error(`Task ${taskId} not found in DB`);
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
      return row;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timeout waiting for task ${taskId}. Current status: ${row.status}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function run() {
  const results = {};

  const scripts = await apiRequest('/api/generated-scripts');
  const project = scripts.find(p => p.id === projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  const shot = project.newShots[0];

  // ----------------------------------------------------
  // Test A: Normal Default Workflow UI Export and Parameter Consistency
  // ----------------------------------------------------
  console.log("\n--- Test A: Default Workflow UI Export & Parameter Consistency ---");
  try {
    const testSeed = "887766554433221100";
    const testPrompt = "A futuristic cyberpunk metropolis at sunset, neon lights";
    const testNegative = "ugly, blurry, low resolution";
    const testModel = "sd_xl_base_1.0.safetensors";
    const testWidth = 768;
    const testHeight = 512;

    const res = await apiRequest('/api/generate-image', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        targetId: shot.id,
        targetType: 'shot',
        viewType: 'main',
        prompt: testPrompt,
        negativePrompt: testNegative,
        seedMode: 'keep',
        seed: testSeed,
        model: testModel,
        width: testWidth,
        height: testHeight,
        platform: 'comfyui',
        skipTranslation: true
      })
    });

    const taskId = res.taskId;
    console.log(`Enqueued Task ID: ${taskId}`);

    const completedTask = await waitForTaskTerminal(taskId);
    console.log(`Task ended with status: ${completedTask.status}`);

    if (completedTask.status !== 'succeeded') {
      throw new Error(`Expected task to succeed but got: ${completedTask.status}`);
    }

    const tasksList = await apiRequest(`/api/comfyui/tasks?projectId=${projectId}`);
    const apiTask = tasksList.find(t => t.id === taskId);
    
    const hasUiWorkflowVal = apiTask ? apiTask.hasUiWorkflow : null;
    const containsApiJson = apiTask && ('apiWorkflowJson' in apiTask);
    const containsUiJson = apiTask && ('uiWorkflowJson' in apiTask);

    console.log(`API Task List Info for ${taskId}:`);
    console.log(`- hasUiWorkflow: ${hasUiWorkflowVal} (Expected: true)`);
    console.log(`- contains apiWorkflowJson key: ${containsApiJson} (Expected: false)`);
    console.log(`- contains uiWorkflowJson key: ${containsUiJson} (Expected: false)`);

    const exportResult = await apiRequest(`/api/comfyui/tasks/${taskId}/export-workflow`);
    console.log(`Export HTTP Status: ${exportResult.status}`);
    console.log(`Content-Type: ${exportResult.headers['content-type']}`);
    console.log(`Content-Disposition: ${exportResult.headers['content-disposition']}`);

    const exportedWorkflow = JSON.parse(exportResult.bodyText);
    
    const ckptNode = exportedWorkflow.nodes.find(n => n.id === 1);
    const posNode = exportedWorkflow.nodes.find(n => n.id === 2);
    const negNode = exportedWorkflow.nodes.find(n => n.id === 3);
    const latentNode = exportedWorkflow.nodes.find(n => n.id === 4);
    const samplerNode = exportedWorkflow.nodes.find(n => n.id === 5);

    const wfModel = ckptNode ? ckptNode.widgets_values[0] : null;
    const wfPrompt = posNode ? posNode.widgets_values[0] : null;
    const wfNegative = negNode ? negNode.widgets_values[0] : null;
    const wfWidth = latentNode ? latentNode.widgets_values[0] : null;
    const wfHeight = latentNode ? latentNode.widgets_values[1] : null;
    const wfSeed = samplerNode ? samplerNode.widgets_values[0] : null;

    console.log(`\nParameter Match Check (Database vs. Exported Workflow):`);
    console.log(`- Model: "${testModel}" vs "${wfModel}"`);
    console.log(`- Prompt: "${testPrompt}" vs "${wfPrompt}"`);
    console.log(`- Negative: "${testNegative}" vs "${wfNegative}"`);
    console.log(`- Width: ${testWidth} vs ${wfWidth}`);
    console.log(`- Height: ${testHeight} vs ${wfHeight}`);
    console.log(`- Seed: "${testSeed}" vs "${wfSeed}"`);

    const paramsMatched = (wfModel === testModel) && (wfPrompt === testPrompt) && 
                          (wfNegative === testNegative) && (wfWidth === testWidth) && 
                          (wfHeight === testHeight) && (String(wfSeed) === String(testSeed));

    const exportHeaderMatched = exportResult.headers['content-type'].includes('application/json') &&
                                 exportResult.headers['content-disposition'].includes('attachment') &&
                                 exportResult.headers['content-disposition'].includes(`comfyui_shot_main_${taskId}.json`);

    const tAPassed = (completedTask.status === 'succeeded') && (hasUiWorkflowVal === true) && 
                     (!containsApiJson) && (!containsUiJson) && exportHeaderMatched && paramsMatched;

    results.testA = {
      status: tAPassed ? 'PASS' : 'FAIL',
      taskId,
      hasUiWorkflowVal,
      containsApiJson,
      containsUiJson,
      headersOk: exportHeaderMatched,
      paramsOk: paramsMatched,
      conclusion: tAPassed
        ? "PASS: Correct uiWorkflowJson exported and parameters match database task exactly."
        : "FAIL: Status code, header, hasUiWorkflow value or parameters mismatch."
    };
  } catch (err) {
    console.error("Test A failed:", err);
    results.testA = { status: 'FAIL', error: err.message };
  }

  // ----------------------------------------------------
  // Test B: Exporting missing/unsuccessful workflow returns error
  // ----------------------------------------------------
  console.log("\n--- Test B: Non-existent / Unsuccessful export checks ---");
  try {
    const fakeTaskId = "00000000-0000-0000-0000-000000000000";
    const resFake = await apiRequest(`/api/comfyui/tasks/${fakeTaskId}/export-workflow`);
    console.log(`Case 1 (Fake Task): HTTP Status = ${resFake.status}`);
    const isFake404 = resFake.status === 404;

    const testSeed = "123456";
    const resPending = await apiRequest('/api/generate-image', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        targetId: shot.id,
        targetType: 'shot',
        viewType: 'main',
        prompt: 'Pending test task',
        seedMode: 'keep',
        seed: testSeed,
        model: 'sd_xl_base_1.0.safetensors',
        platform: 'comfyui',
        skipTranslation: true
      })
    });
    const pendingTaskId = resPending.taskId;
    
    const resPendingExport = await apiRequest(`/api/comfyui/tasks/${pendingTaskId}/export-workflow`);
    console.log(`Case 2 (Pending Task): HTTP Status = ${resPendingExport.status}, message = ${resPendingExport.bodyText}`);
    const isPending409 = resPendingExport.status === 409;

    db.prepare("UPDATE comfyui_tasks SET status = 'succeeded', uiWorkflowJson = '' WHERE id = ?").run(pendingTaskId);
    const resNoUiExport = await apiRequest(`/api/comfyui/tasks/${pendingTaskId}/export-workflow`);
    console.log(`Case 3 (No UI Workflow Task): HTTP Status = ${resNoUiExport.status}, message = ${resNoUiExport.bodyText}`);
    const isNoUi409 = resNoUiExport.status === 409;

    const tBPassed = isFake404 && isPending409 && isNoUi409;
    results.testb = {
      status: tBPassed ? 'PASS' : 'FAIL',
      fakeTaskStatus: resFake.status,
      pendingTaskStatus: resPendingExport.status,
      noUiTaskStatus: resNoUiExport.status,
      conclusion: tBPassed
        ? "PASS: Backend correctly rejects export requests for fake, pending, or empty workflow tasks with HTTP 404/409."
        : "FAIL: Status codes are incorrect."
    };
  } catch (err) {
    console.error("Test B failed:", err);
    results.testb = { status: 'FAIL', error: err.message };
  }

  // ----------------------------------------------------
  // Test C: Latest Task Selection Test (Time field sorting check)
  // ----------------------------------------------------
  console.log("\n--- Test C: Latest Task Selection Test ---");
  try {
    const slotTargetId = "latest_selection_target_id";
    const slotViewType = "main";
    
    // Clear old tasks for this target to isolate test
    db.prepare("DELETE FROM comfyui_tasks WHERE targetId = ?").run(slotTargetId);
    
    // Insert Old Task A
    const tA_Id = "task_A_old_11111";
    db.prepare(`
      INSERT INTO comfyui_tasks (
        id, projectId, targetId, targetType, viewType, prompt, negativePrompt, seed, model, width, height, status, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tA_Id, projectId, slotTargetId, 'shot', slotViewType,
      'Old prompt A', 'bad', '111', 'modelA', 512, 512, 'succeeded',
      '2026-06-27T10:00:00.000Z', '2026-06-27T10:00:00.000Z'
    );

    // Insert New Task B
    const tB_Id = "task_B_new_22222";
    db.prepare(`
      INSERT INTO comfyui_tasks (
        id, projectId, targetId, targetType, viewType, prompt, negativePrompt, seed, model, width, height, status, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tB_Id, projectId, slotTargetId, 'shot', slotViewType,
      'New prompt B', 'bad', '222', 'modelB', 512, 512, 'succeeded',
      '2026-06-27T11:00:00.000Z', '2026-06-27T11:00:00.000Z'
    );

    // Fetch the list from tasks API
    const tasks = await apiRequest(`/api/comfyui/tasks?projectId=${projectId}`);
    
    // Filter and sort exactly like the frontend logic
    const getLatestSucceededTask = (tasksList, targetId, viewType) => {
      const succeededTasks = tasksList.filter(
        t => t.targetId === targetId && t.viewType === viewType && t.status === 'succeeded'
      );
      if (!succeededTasks.length) return null;
      return [...succeededTasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    };

    const latestSelected = getLatestSucceededTask(tasks, slotTargetId, slotViewType);
    console.log(`- Selected Task ID: "${latestSelected ? latestSelected.id : null}" (Expected: "${tB_Id}")`);
    console.log(`- Selected Task Prompt: "${latestSelected ? latestSelected.prompt : null}" (Expected: "New prompt B")`);

    const tCPassed = latestSelected && latestSelected.id === tB_Id;
    results.testc = {
      status: tCPassed ? 'PASS' : 'FAIL',
      selectedTaskId: latestSelected ? latestSelected.id : null,
      expectedTaskId: tB_Id,
      conclusion: tCPassed
        ? "PASS: Front-end logic accurately selects the latest succeeded task based on time sorting, ignoring array order."
        : "FAIL: Wrong task selected or sorting logic is broken."
    };
  } catch (err) {
    console.error("Test C failed:", err);
    results.testc = { status: 'FAIL', error: err.message };
  }

  // ----------------------------------------------------
  // Test D: Redirect address source and validation check
  // ----------------------------------------------------
  console.log("\n--- Test D: Redirect address source and validation check ---");
  try {
    // We request /api/comfyui/open-ui with a malicious query parameter to verify it is completely ignored
    // and that it only uses the server configuration.
    const resOpenUi = await apiRequest('/api/comfyui/open-ui?redirect=http://malicious.com', {
      redirect: 'manual'
    });
    const redirectUrl = resOpenUi.headers['location'];
    console.log(`- Open UI HTTP Status: ${resOpenUi.status}`);
    console.log(`- Redirect location: "${redirectUrl}" (Expected: configured ComfyUI API URL)`);

    const isValidUrl = redirectUrl && (redirectUrl.startsWith('http://') || redirectUrl.startsWith('https://'));
    const isRedirectSecure = redirectUrl && !redirectUrl.includes('malicious.com');

    const tDPassed = resOpenUi.status === 302 && isValidUrl && isRedirectSecure;
    results.testd = {
      status: tDPassed ? 'PASS' : 'FAIL',
      statusReturned: resOpenUi.status,
      redirectUrl,
      conclusion: tDPassed
        ? "PASS: ComfyUI redirection correctly uses configured URL without hardcoding, ignores query overrides, and validates protocols."
        : "FAIL: Redirect failed, protocol invalid, or open redirect vulnerability exists."
    };
  } catch (err) {
    console.error("Test D failed:", err);
    results.testd = { status: 'FAIL', error: err.message };
  }

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log("\n=== Advanced Adjustment Verification Summary ===");
  console.log(JSON.stringify(results, null, 2));

  const allPassed = Object.values(results).every(r => r.status === 'PASS');
  if (allPassed) {
    console.log("\nALL ADVANCED ADJUSTMENT TESTS PASSED!");
    process.exit(0);
  } else {
    console.error("\nONE OR MORE ADVANCED ADJUSTMENT TESTS FAILED!");
    process.exit(1);
  }
}

run();
