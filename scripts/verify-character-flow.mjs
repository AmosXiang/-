import Database from 'better-sqlite3';

const baseUrl = `http://127.0.0.1:${process.env.PORT || 3003}`;
const db = new Database(process.env.SQLITE_DB_PATH || 'db.sqlite');

async function request(path, options = {}, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (expectedStatus !== undefined) {
    if (response.status !== expectedStatus) throw new Error(`${path}: expected ${expectedStatus}, got ${response.status}`);
    return data;
  }
  if (!response.ok) throw new Error(`${path}: ${data.error || response.status}`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await import('../server.ts');
await new Promise(resolve => setTimeout(resolve, 1200));

const storeRow = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get();
const originalScriptsJson = storeRow?.value || '[]';
const stamp = Date.now();
const projectId = stamp;
const characterId = `character-${stamp}`;
const shotId = `shot-${stamp}`;
const avatarUrl = '/src/assets/images/steampunk_professor_1782410189707.jpg';
const report = { status: 'FAIL', taskIds: {}, checks: {} };

try {
  const scripts = JSON.parse(originalScriptsJson);
  scripts.push({
    id: projectId,
    createdAt: new Date().toISOString(),
    comfyuiPreferences: {
      shotPresetId: 'pure_klein',
      characterMasterPresetId: 'pure_klein',
      identityPresetId: 'pulid_flux2',
      threeViewPresetId: 'qwen_2511_three_views',
      upscalePresetId: 'esrgan_4x',
    },
    newTitle: 'Character flow verification',
    newNarrative: { structure: '', rhythm: '', climaxDesign: '' },
    newCharacters: [{ id: characterId, name: 'Verification Character', role: 'Lead', personality: 'Calm', clothing: 'Blue coat', avatarUrl: '' }],
    newShots: [{ id: shotId, timestamp: '00:00 - 00:05', timeSeconds: 0, movement: '', composition: '', emotion: '', description: 'Verification Character in a city street', characterIds: [characterId], characterNames: ['Verification Character'], imageUrl: '' }],
  });
  db.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify(scripts));

  const bindingResult = await request(`/api/generated-scripts/${projectId}/shots/${shotId}/matched-characters`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchedCharacterIds: [characterId] }),
  });
  assert(bindingResult.success === true && bindingResult.projectId === String(projectId) && bindingResult.shotId === shotId, 'Shot binding endpoint response is incorrect');
  const persistedAfterBinding = JSON.parse(db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get().value).find(script => String(script.id) === String(projectId));
  assert(JSON.stringify(persistedAfterBinding?.newShots?.[0]?.matchedCharacterIds) === JSON.stringify([characterId]), 'matchedCharacterIds did not persist');
  const refreshedScripts = await request('/api/generated-scripts');
  const refreshedProject = refreshedScripts.find(script => String(script.id) === String(projectId));
  assert(JSON.stringify(refreshedProject?.newShots?.[0]?.matchedCharacterIds) === JSON.stringify([characterId]), 'matchedCharacterIds did not survive refresh');
  report.checks.shotCharacterBinding = 'PASS';

  const missingAvatar = await request('/api/generate-image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      projectId, targetId: characterId, targetType: 'character', characterName: 'Verification Character',
      presetId: 'qwen_2511_three_views', platform: 'comfyui', sourceImageUrl: '',
    }),
  }, 422);
  assert(String(missingAvatar.error || '').includes('角色母版'), 'Missing-avatar reason is not explicit');
  report.checks.threeViewRequiresAvatar = 'PASS';

  const avatarTaskResult = await request('/api/generate-image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      projectId, targetId: characterId, targetType: 'character', viewType: 'avatar', characterName: 'Verification Character',
      presetId: 'pure_klein', prompt: 'Verification Character, blue coat, character master', platform: 'comfyui', skipTranslation: true,
    }),
  });
  report.taskIds.characterMaster = avatarTaskResult.taskId;
  const avatarTask = db.prepare('SELECT workflowPresetId,model,viewType FROM comfyui_tasks WHERE id = ?').get(avatarTaskResult.taskId);
  assert(avatarTask?.workflowPresetId === '01_klein_character_master' && avatarTask?.viewType === 'avatar', 'Character master task snapshot is incorrect');
  report.checks.characterMasterSelection = 'PASS';

  const updatedScripts = JSON.parse(db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get().value);
  const fixture = updatedScripts.find(script => script.id === projectId);
  fixture.newCharacters[0].avatarUrl = avatarUrl;
  fixture.newCharacters[0].avatarGeneration = { presetId: avatarTask.workflowPresetId, model: avatarTask.model, imageUrl: avatarUrl, taskId: avatarTaskResult.taskId };
  db.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify(updatedScripts));

  const threeViewResult = await request('/api/generate-image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      projectId, targetId: characterId, targetType: 'character', characterName: 'Verification Character',
      viewType: 'front', presetId: 'qwen_2511_three_views', platform: 'comfyui', sourceImageUrl: avatarUrl, sourceTaskId: avatarTaskResult.taskId,
    }),
  });
  report.taskIds.threeViews = threeViewResult.taskIds;
  const threeViewTasks = db.prepare(`SELECT id,viewType,workflowPresetId,model,sourceImageUrl,sourceTaskId FROM comfyui_tasks WHERE workflowBatchId = ? ORDER BY viewType`).all(threeViewResult.batchId);
  assert(threeViewTasks.length === 3 && threeViewTasks.every(task => task.workflowPresetId === '03_qwen_2511_three_views'), 'Three-view preset snapshot is incorrect');
  assert(threeViewTasks.every(task => task.sourceImageUrl === avatarUrl && task.sourceTaskId === avatarTaskResult.taskId), 'Three-view tasks did not freeze the avatar reference');
  report.checks.independentThreeViewSelection = 'PASS';
  report.checks.avatarReferenceFrozen = 'PASS';

  const shotPreflight = await request('/api/comfyui/shots/generate-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, regenerateMode: 'all', lockCharacterIdentity: true }),
  });
  assert(shotPreflight.requiresConfirmation === true && shotPreflight.preflight?.total === 1 && shotPreflight.preflight?.pulid === 1, 'Storyboard preflight did not classify the PuLID shot');
  report.checks.storyboardPreflight = 'PASS';
  const shotResult = await request('/api/comfyui/shots/generate-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, regenerateMode: 'all', lockCharacterIdentity: true, confirmed: true }),
  });
  assert(shotResult.taskIds.length === 1, 'Expected one storyboard task');
  report.taskIds.storyboard = shotResult.taskIds[0];
  const shotTask = db.prepare('SELECT workflowPresetId,sourceImageUrl,characterReferenceImageUrl,lockCharacterIdentity FROM comfyui_tasks WHERE id = ?').get(shotResult.taskIds[0]);
  assert(shotTask?.workflowPresetId === '02_klein_pulid_identity', 'Storyboard did not switch to the verified identity workflow');
  assert(shotTask?.sourceImageUrl && shotTask?.characterReferenceImageUrl && shotTask?.lockCharacterIdentity === 1, 'Storyboard did not persist the character reference');
  report.checks.storyboardUsesCharacterReference = 'PASS';
  report.status = 'PASS';
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  const taskIds = [report.taskIds.characterMaster, ...(report.taskIds.threeViews || []), report.taskIds.storyboard].filter(Boolean);
  for (const taskId of taskIds) {
    await fetch(`${baseUrl}/api/comfyui/tasks/${taskId}/cancel`, { method: 'POST' }).catch(() => undefined);
  }
  db.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(originalScriptsJson);
  console.log(JSON.stringify(report, null, 2));
  db.close();
  process.exit(report.status === 'PASS' ? 0 : 1);
}
