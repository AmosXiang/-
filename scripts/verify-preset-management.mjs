import Database from 'better-sqlite3';

const baseUrl = `http://127.0.0.1:${process.env.PORT || 3002}`;
const db = new Database(process.env.SQLITE_DB_PATH || 'db.sqlite');

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${data.error || response.status}`);
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await import('../server.ts');
await new Promise(resolve => setTimeout(resolve, 1200));

const report = { status: 'FAIL', taskIds: {}, checks: {}, presets: [] };
let originalProjectPreferences;
let originalDefaultPreferences;
let projectId;
let originalScriptsJson;

try {
  const catalog = await request('/api/comfyui/presets');
  const requiredIds = ['sdxl_legacy', 'pure_klein', 'pulid_flux2', 'qwen_2511_three_views', 'esrgan_4x'];
  assert(requiredIds.every(id => catalog.presets.some(preset => preset.presetId === id)), 'Preset catalog is incomplete');
  assert(catalog.presets.filter(preset => preset.purposes.includes('storyboard')).every(preset => ['sdxl_legacy', 'pure_klein'].includes(preset.presetId)), 'Storyboard filtering contains an invalid preset');
  report.presets = catalog.presets.map(preset => ({ presetId: preset.presetId, modelName: preset.modelName, workflowFamily: preset.workflowFamily, purposes: preset.purposes, available: preset.available, reason: preset.reason }));
  report.checks.catalog = 'PASS';

  const defaults = await request('/api/comfyui/default-preferences');
  originalDefaultPreferences = defaults.preferences;
  const pureDefaults = { ...defaults.preferences, shotPresetId: 'pure_klein' };
  await request('/api/comfyui/default-preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: pureDefaults }) });
  const reloadedDefaults = await request('/api/comfyui/default-preferences');
  assert(reloadedDefaults.preferences.shotPresetId === 'pure_klein', 'Global default did not persist');
  report.checks.globalPersistence = 'PASS';

  let scripts = await request('/api/generated-scripts');
  if (!scripts.length) {
    const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get();
    originalScriptsJson = row?.value || '[]';
    const fixture = {
      id: `preset-verification-${Date.now()}`,
      templateId: 'verification',
      templateTitle: 'Preset verification',
      topic: 'Preset verification',
      createdAt: new Date().toISOString(),
      comfyuiPreferences: originalDefaultPreferences,
      newTitle: 'Preset verification',
      newNarrative: { structure: '', rhythm: '', climaxDesign: '' },
      newCharacters: [],
      newShots: [{ id: `verify-shot-${Date.now()}`, timestamp: '00:00 - 00:05', timeSeconds: 0, movement: '', composition: '', emotion: '', description: 'Preset verification frame', imageUrl: '' }],
    };
    db.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(JSON.stringify([fixture]));
    scripts = await request('/api/generated-scripts');
  }
  const project = scripts[0];
  projectId = project.id;
  const shot = project.newShots?.[0];
  assert(shot?.id, 'Project has no shot target');
  const projectPreferences = await request(`/api/generated-scripts/${projectId}/comfyui-preferences`);
  originalProjectPreferences = projectPreferences.preferences;

  const purePreferences = { ...projectPreferences.preferences, shotPresetId: 'pure_klein' };
  await request(`/api/generated-scripts/${projectId}/comfyui-preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: purePreferences }) });
  const pureResult = await request('/api/generate-image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      projectId, targetId: `${shot.id}-verify-klein`, targetType: 'shot', viewType: 'main', shotIndex: 0,
      prompt: 'preset verification frame, cinematic lighting', negativePrompt: 'blurry', platform: 'comfyui',
      skipTranslation: true, lockCharacterIdentity: false,
    }),
  });
  report.taskIds.pureKlein = pureResult.taskId;
  const pureTask = db.prepare('SELECT workflowPresetId, workflowFamily, model FROM comfyui_tasks WHERE id = ?').get(pureResult.taskId);
  assert(pureTask?.workflowPresetId === '01_klein_character_master', 'Pure Klein task did not freeze the Klein preset');
  assert(String(pureTask?.model || '').includes('klein'), 'Pure Klein task did not freeze the Klein model');
  report.checks.pureKleinTaskSnapshot = 'PASS';

  const sdxlPreferences = { ...purePreferences, shotPresetId: 'sdxl_legacy' };
  await request(`/api/generated-scripts/${projectId}/comfyui-preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: sdxlPreferences }) });
  const sdxlResult = await request('/api/generate-image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      projectId, targetId: `${shot.id}-verify-sdxl`, targetType: 'shot', viewType: 'main', shotIndex: 0,
      prompt: 'preset verification frame, cinematic lighting', negativePrompt: 'blurry', platform: 'comfyui',
      skipTranslation: true, lockCharacterIdentity: false,
    }),
  });
  report.taskIds.sdxl = sdxlResult.taskId;
  const sdxlTask = db.prepare('SELECT workflowPresetId, workflowFamily, model FROM comfyui_tasks WHERE id = ?').get(sdxlResult.taskId);
  const oldPureTask = db.prepare('SELECT workflowPresetId, model FROM comfyui_tasks WHERE id = ?').get(pureResult.taskId);
  assert(sdxlTask?.workflowPresetId === 'sdxl_legacy' && sdxlTask?.workflowFamily === 'sdxl', 'SDXL task did not freeze the SDXL preset');
  assert(oldPureTask?.workflowPresetId === '01_klein_character_master', 'Changing the default rewrote the old task preset');
  const refreshedProjectPreferences = await request(`/api/generated-scripts/${projectId}/comfyui-preferences`);
  assert(refreshedProjectPreferences.preferences.shotPresetId === 'sdxl_legacy', 'Project preference did not survive reload');
  report.checks.sdxlTaskSnapshot = 'PASS';
  report.checks.oldTaskIsolation = 'PASS';
  report.checks.projectPersistence = 'PASS';

  report.status = 'PASS';
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  for (const taskId of Object.values(report.taskIds)) {
    await fetch(`${baseUrl}/api/comfyui/tasks/${taskId}/cancel`, { method: 'POST' }).catch(() => undefined);
  }
  if (projectId && originalProjectPreferences) {
    await fetch(`${baseUrl}/api/generated-scripts/${projectId}/comfyui-preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: originalProjectPreferences }) }).catch(() => undefined);
  }
  if (originalDefaultPreferences) {
    await fetch(`${baseUrl}/api/comfyui/default-preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: originalDefaultPreferences }) }).catch(() => undefined);
  }
  if (originalScriptsJson !== undefined) {
    db.prepare("INSERT OR REPLACE INTO store (key, value) VALUES ('generated_scripts', ?)").run(originalScriptsJson);
  }
  console.log(JSON.stringify(report, null, 2));
  db.close();
  process.exit(report.status === 'PASS' ? 0 : 1);
}
