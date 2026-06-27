import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'db.sqlite');
const db = new Database(dbPath);

const baseUrl = 'http://127.0.0.1:3001';
const comfyUrl = 'http://127.0.0.1:8001';
const projectId = '1782543650666';

// Helper to make API requests
async function apiRequest(endpoint, options = {}) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Helper to wait for a task to transition to a terminal state
async function waitForTaskTerminal(taskId, timeoutMs = 120000) {
  const started = Date.now();
  console.log(`Polling task ${taskId} until terminal...`);
  while (true) {
    const row = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(taskId);
    if (!row) throw new Error(`Task ${taskId} not found in DB`);
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
      return row;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timeout waiting for task ${taskId} to complete. Current status: ${row.status}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// Scenarios execution function
async function runScenarios() {
  console.log("=== Running ComfyUI Fault Recovery Scenarios ===");

  // Fetch project to get target character and shot IDs
  const scripts = await apiRequest('/api/generated-scripts');
  const project = scripts.find(p => p.id === projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const character = project.newCharacters[0];
  const shot = project.newShots[0];

  const results = {};

  // ----------------------------------------------------
  // Scenario 1: Simultaneously submit front, side, back tasks and verify no mutual cancellation
  // ----------------------------------------------------
  console.log("\n--- Scenario 1: Concurrent front, side, back character view tasks ---");
  const viewTypes = ['front', 'side', 'back'];
  const s1Tasks = [];
  for (const vt of viewTypes) {
    const res = await apiRequest('/api/generate-image', {
      method: 'POST',
      body: JSON.stringify({
        prompt: `consistent character cyberpunk portrait, ${vt} view`,
        isCharacter: true,
        projectId,
        targetType: 'character',
        characterName: character.name,
        targetId: character.id,
        viewType: vt,
        platform: 'comfyui',
        skipTranslation: true,
      }),
    });
    console.log(`Submitted ${vt} task, ID: ${res.taskId}`);
    s1Tasks.push({ viewType: vt, taskId: res.taskId });
  }

  // Poll for completion and check that none got cancelled/superseded by each other
  const s1Completed = [];
  for (const t of s1Tasks) {
    const finalTask = await waitForTaskTerminal(t.taskId);
    s1Completed.push(finalTask);
    console.log(`Task ${t.taskId} (${t.viewType}) ended with status: ${finalTask.status}`);
  }

  const s1Success = s1Completed.every(t => t.status === 'succeeded');
  results.scenario1 = {
    success: s1Success,
    tasks: s1Completed.map(t => ({ id: t.id, viewType: t.viewType, status: t.status })),
    conclusion: s1Success 
      ? "PASS: Front, side, back tasks processed concurrently and succeeded without canceling each other."
      : "FAIL: One or more tasks were cancelled or failed."
  };

  // ----------------------------------------------------
  // Scenario 2: Cancel a local pending task and verify it is never sent to ComfyUI
  // ----------------------------------------------------
  console.log("\n--- Scenario 2: Cancel a local pending task ---");
  const s2Submit = await apiRequest('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({
      prompt: "Test cancel pending task",
      isCharacter: false,
      projectId,
      targetType: 'shot',
      shotIndex: 0,
      targetId: shot.id,
      viewType: 'main',
      platform: 'comfyui',
      skipTranslation: true,
    }),
  });
  const s2TaskId = s2Submit.taskId;
  console.log(`Submitted task ${s2TaskId}, canceling immediately...`);
  
  const s2Cancel = await apiRequest(`/api/comfyui/tasks/${s2TaskId}/cancel`, { method: 'POST' });
  console.log(`Cancel request response:`, s2Cancel);

  // Check state in DB
  const s2Row = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(s2TaskId);
  console.log(`Task status in SQLite: ${s2Row.status}`);

  // Query ComfyUI history/queue to verify it is NOT there
  let presentInComfy = false;
  try {
    const queueRes = await fetch(`${comfyUrl}/queue`);
    if (queueRes.ok) {
      const q = await queueRes.json();
      const inQueue = [...q.queue_running, ...q.queue_pending].some(item => item[1] === s2TaskId);
      if (inQueue) presentInComfy = true;
    }
    const historyRes = await fetch(`${comfyUrl}/history/${s2TaskId}`);
    if (historyRes.ok) {
      const h = await historyRes.json();
      if (h && h[s2TaskId]) presentInComfy = true;
    }
  } catch (err) {
    console.warn("Could not check ComfyUI status directly:", err.message);
  }

  const s2Success = s2Row.status === 'cancelled' && !presentInComfy;
  results.scenario2 = {
    success: s2Success,
    taskId: s2TaskId,
    dbStatus: s2Row.status,
    presentInComfy,
    conclusion: s2Success
      ? "PASS: Task marked as cancelled in SQLite and never reached ComfyUI server."
      : "FAIL: Task status is not cancelled or it reached ComfyUI server."
  };

  // ----------------------------------------------------
  // Scenario 3: Cancel a task already in ComfyUI queue_pending
  // ----------------------------------------------------
  console.log("\n--- Scenario 3: Cancel a task in queue_pending ---");
  // We submit a task, wait for it to become processing, then cancel it.
  const s3Submit = await apiRequest('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({
      prompt: "Test cancel processing queue task",
      isCharacter: false,
      projectId,
      targetType: 'shot',
      shotIndex: 0,
      targetId: shot.id,
      viewType: 'main',
      platform: 'comfyui',
      skipTranslation: true,
    }),
  });
  const s3TaskId = s3Submit.taskId;
  console.log(`Submitted task ${s3TaskId}, waiting for worker to claim and set status to processing...`);
  
  let s3Row;
  for (let i = 0; i < 20; i++) {
    s3Row = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(s3TaskId);
    if (s3Row.status === 'processing') break;
    await new Promise(r => setTimeout(r, 500));
  }
  
  if (s3Row.status !== 'processing') {
    throw new Error("Task was not picked up by the worker in time for Scenario 3");
  }
  console.log(`Task is now ${s3Row.status}. Sending cancel request...`);
  await apiRequest(`/api/comfyui/tasks/${s3TaskId}/cancel`, { method: 'POST' });
  
  // Wait a moment and check ComfyUI queue
  await new Promise(r => setTimeout(r, 2000));
  let deletedFromComfy = true;
  try {
    const queueRes = await fetch(`${comfyUrl}/queue`);
    if (queueRes.ok) {
      const q = await queueRes.json();
      const inQueuePending = (q.queue_pending || []).some(item => item[1] === s3TaskId);
      if (inQueuePending) deletedFromComfy = false;
    }
  } catch (err) {
    console.warn("Could not check ComfyUI queue:", err.message);
  }

  const s3DbRow = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(s3TaskId);
  const s3Success = s3DbRow.status === 'cancelled' && deletedFromComfy;
  results.scenario3 = {
    success: s3Success,
    taskId: s3TaskId,
    dbStatus: s3DbRow.status,
    deletedFromComfy,
    conclusion: s3Success
      ? "PASS: Task marked as cancelled in SQLite and successfully deleted from ComfyUI queue."
      : "FAIL: Task status is not cancelled or it remains in ComfyUI queue."
  };

  // ----------------------------------------------------
  // Scenario 4: Task B supersedes Task A
  // ----------------------------------------------------
  console.log("\n--- Scenario 4: Task B supersedes Task A ---");
  // Submit Task A
  const s4SubmitA = await apiRequest('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({
      prompt: "Superseded Task A",
      isCharacter: false,
      projectId,
      targetType: 'shot',
      shotIndex: 1, // shotIndex 1
      targetId: project.newShots[1].id,
      viewType: 'main',
      platform: 'comfyui',
      skipTranslation: true,
    }),
  });
  const taskIdA = s4SubmitA.taskId;
  console.log(`Submitted Task A: ${taskIdA}`);

  // Wait for A to start processing
  for (let i = 0; i < 20; i++) {
    const r = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(taskIdA);
    if (r.status === 'processing') break;
    await new Promise(r => setTimeout(r, 500));
  }

  // Submit Task B for the same targetId + viewType
  const s4SubmitB = await apiRequest('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({
      prompt: "Superseding Task B",
      isCharacter: false,
      projectId,
      targetType: 'shot',
      shotIndex: 1,
      targetId: project.newShots[1].id,
      viewType: 'main',
      platform: 'comfyui',
      skipTranslation: true,
    }),
  });
  const taskIdB = s4SubmitB.taskId;
  console.log(`Submitted Task B: ${taskIdB} to supersede Task A`);

  // Verify that Task A has been marked superseded
  const rowAAfter = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(taskIdA);
  console.log(`Task A status after B submission: ${rowAAfter.status}, supersededByTaskId: ${rowAAfter.supersededByTaskId}`);

  // Wait for both to finish
  await waitForTaskTerminal(taskIdA);
  const finalTaskB = await waitForTaskTerminal(taskIdB);

  console.log(`Task A finished terminal status: ${rowAAfter.status}`);
  console.log(`Task B finished terminal status: ${finalTaskB.status}`);

  // Verify DB generated scripts record: the image should belong to Task B
  const scriptsCheck = await apiRequest('/api/generated-scripts');
  const projectCheck = scriptsCheck.find(p => p.id === projectId);
  const targetShot = projectCheck.newShots[1];
  
  // Check the image metadata in generated_scripts
  const writtenUrl = targetShot.generatedImageUrl || targetShot.imageUrl;
  console.log(`Final image URL written to project: ${writtenUrl}`);

  const rowBRecord = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(taskIdB);
  // The writtenUrl should match task B's downloaded file URL (usually contains comfyui-<seed>)
  const rowARecord = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(taskIdA);
  const s4Success = rowAAfter.status === 'cancelled' && 
                    rowAAfter.supersededByTaskId === taskIdB && 
                    finalTaskB.status === 'succeeded' && 
                    writtenUrl === rowBRecord.imageUrl &&
                    rowARecord.imageUrl === null;

  results.scenario4 = {
    success: s4Success,
    taskIdA,
    taskIdB,
    statusA: rowAAfter.status,
    statusB: finalTaskB.status,
    writtenUrl,
    conclusion: s4Success
      ? "PASS: Task A was cancelled & superseded by B, and B successfully wrote back its final image."
      : "FAIL: Supersede logic failed or wrong image was written."
  };

  // ----------------------------------------------------
  // Scenario 6: Inject failed task, check continuation, retry
  // ----------------------------------------------------
  console.log("\n--- Scenario 6: Inject failed task, verify queue continuation and retry ---");
  // 1. Submit a task
  const s6Submit = await apiRequest('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({
      prompt: "Task to fail in ComfyUI",
      isCharacter: false,
      projectId,
      targetType: 'shot',
      shotIndex: 2,
      targetId: project.newShots[2].id,
      viewType: 'main',
      platform: 'comfyui',
      skipTranslation: true,
    }),
  });
  const s6TaskId = s6Submit.taskId;
  console.log(`Submitted task ${s6TaskId}`);

  // 2. Corrupt its apiWorkflowJson in DB before it gets processed
  const oldWorkflow = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(s6TaskId);
  db.prepare("UPDATE comfyui_tasks SET apiWorkflowJson = '{\"invalid\": true}' WHERE id = ?").run(s6TaskId);
  console.log(`Corrupted task workflow to invalid JSON to force failure.`);

  // 3. Wait for it to fail
  const s6FailedRow = await waitForTaskTerminal(s6TaskId);
  console.log(`Task ended with status: ${s6FailedRow.status}, error: ${s6FailedRow.error}`);

  // 4. Submit a new valid task to confirm queue continuation
  const s6ContSubmit = await apiRequest('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({
      prompt: "Queue continuation task",
      isCharacter: false,
      projectId,
      targetType: 'shot',
      shotIndex: 3,
      targetId: project.newShots[3].id,
      viewType: 'main',
      platform: 'comfyui',
      skipTranslation: true,
    }),
  });
  const contTaskId = s6ContSubmit.taskId;
  console.log(`Submitted subsequent task ${contTaskId} to verify queue did not get blocked.`);
  
  const contTaskRow = await waitForTaskTerminal(contTaskId);
  console.log(`Subsequent task ended with status: ${contTaskRow.status}`);

  // 5. Restore the failed task's workflow so retry succeeds
  db.prepare("UPDATE comfyui_tasks SET apiWorkflowJson = ? WHERE id = ?").run(oldWorkflow.apiWorkflowJson, s6TaskId);
  console.log(`Restored original workflow for failed task ${s6TaskId}`);

  // 6. Hit the retry endpoint
  const retryRes = await apiRequest(`/api/comfyui/tasks/${s6TaskId}/retry`, { method: 'POST' });
  const retryTaskId = retryRes.taskId;
  console.log(`Retried task. New task ID: ${retryTaskId}`);

  // Verify retry DB record
  const retryRow = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(retryTaskId);
  console.log(`Retry record: retryOfTaskId: ${retryRow.retryOfTaskId}, retryCount: ${retryRow.retryCount}`);

  // Wait for retry to succeed
  const retryFinalRow = await waitForTaskTerminal(retryTaskId);
  console.log(`Retried task final status: ${retryFinalRow.status}`);

  const s6Success = s6FailedRow.status === 'failed' && 
                    contTaskRow.status === 'succeeded' && 
                    retryRow.retryOfTaskId === s6TaskId && 
                    retryRow.retryCount === 1 &&
                    retryFinalRow.status === 'succeeded';

  results.scenario6 = {
    success: s6Success,
    failedTaskId: s6TaskId,
    contTaskId,
    retryTaskId,
    retryOfTaskId: retryRow.retryOfTaskId,
    retryCount: retryRow.retryCount,
    conclusion: s6Success
      ? "PASS: Failed task did not block the queue, and retrying it created a correct link which eventually succeeded."
      : "FAIL: Queue blocked, retry link invalid, or retry failed."
  };

  // ----------------------------------------------------
  // Scenario 7: Verify apiWorkflowJson and uiWorkflowJson parse
  // ----------------------------------------------------
  console.log("\n--- Scenario 7: Verify workflow snapshots parse ---");
  // Query a task from Scenario 1 of the current run to check its snapshots
  const successfulTask = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(s1Tasks[0].taskId);
  let apiValid = false;
  let uiValid = false;
  if (successfulTask) {
    try {
      JSON.parse(successfulTask.apiWorkflowJson);
      apiValid = true;
    } catch (e) {
      console.error("Failed to parse apiWorkflowJson", e);
    }
    try {
      JSON.parse(successfulTask.uiWorkflowJson);
      uiValid = true;
    } catch (e) {
      console.error("Failed to parse uiWorkflowJson", e);
    }
  }

  const s7Success = apiValid && uiValid;
  results.scenario7 = {
    success: s7Success,
    taskId: successfulTask ? successfulTask.id : null,
    apiValid,
    uiValid,
    conclusion: s7Success
      ? "PASS: Both apiWorkflowJson and uiWorkflowJson are valid, parsable JSON structures."
      : "FAIL: Workflow JSON parsing failed."
  };

  console.log("\n=== Scenarios Results Summary ===");
  console.log(JSON.stringify(results, null, 2));

  // Exit with status code based on success of all scenarios
  const overallSuccess = Object.values(results).every(r => r.success);
  if (!overallSuccess) {
    console.error("One or more fault scenarios failed!");
    process.exit(1);
  } else {
    console.log("All fault scenarios PASSED successfully!");
    process.exit(0);
  }
}

// Scenario 5 functions
async function runScenario5Start() {
  console.log("=== Scenario 5: Starting backend crash recovery test ===");
  const scripts = await apiRequest('/api/generated-scripts');
  const project = scripts.find(p => p.id === projectId);
  const shot = project.newShots[4]; // use shot 4

  const res = await apiRequest('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({
      prompt: "Crash recovery test task - shot 5",
      isCharacter: false,
      projectId,
      targetType: 'shot',
      shotIndex: 4,
      targetId: shot.id,
      viewType: 'main',
      platform: 'comfyui',
      skipTranslation: true,
    }),
  });
  const taskId = res.taskId;
  console.log(`Submitted task ${taskId}. Waiting for worker to mark processing (sent to ComfyUI)...`);

  let row;
  for (let i = 0; i < 20; i++) {
    row = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(taskId);
    if (row.status === 'processing') break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (row.status !== 'processing') {
    throw new Error("Task did not start processing in time");
  }

  console.log(`\n=============================================`);
  console.log(`Task is now running on ComfyUI!`);
  console.log(`Task ID: ${taskId}`);
  console.log(`ACTION REQUIRED:`);
  console.log(`1. Kill the backend task (task-177)`);
  console.log(`2. Wait for ComfyUI to complete (you can monitor http://127.0.0.1:8001/queue)`);
  console.log(`3. Restart the backend task`);
  console.log(`4. Run: node scripts/final-fault-verification.mjs --scenario-5-verify ${taskId}`);
  console.log(`=============================================\n`);
}

async function runScenario5Verify(taskId) {
  console.log(`=== Scenario 5: Verifying backend recovery for task ${taskId} ===`);
  const row = db.prepare("SELECT * FROM comfyui_tasks WHERE id = ?").get(taskId);
  console.log(`Current task status in database: ${row.status}`);
  console.log(`Recovery check count: ${row.recoveryCheckCount}`);
  console.log(`Error field: ${row.error}`);
  console.log(`Completed at: ${row.completedAt}`);

  if (row.status === 'succeeded') {
    console.log(`PASS: Task recovered successfully and was marked succeeded in database!`);
    process.exit(0);
  } else {
    console.log(`FAIL: Task is in status: ${row.status}`);
    process.exit(1);
  }
}

// Parse args
const mode = process.argv[2];
if (mode === '--run-scenarios') {
  runScenarios().catch(e => { console.error(e); process.exit(1); });
} else if (mode === '--scenario-5-start') {
  runScenario5Start().catch(e => { console.error(e); process.exit(1); });
} else if (mode === '--scenario-5-verify') {
  const tId = process.argv[3];
  if (!tId) {
    console.error("Please provide taskId");
    process.exit(2);
  }
  runScenario5Verify(tId).catch(e => { console.error(e); process.exit(1); });
} else {
  console.error("Usage:\n  node scripts/final-fault-verification.mjs --run-scenarios\n  node scripts/final-fault-verification.mjs --scenario-5-start\n  node scripts/final-fault-verification.mjs --scenario-5-verify <taskId>");
  process.exit(2);
}
