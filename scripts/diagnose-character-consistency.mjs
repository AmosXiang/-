import Database from 'better-sqlite3';

const db = new Database(process.env.SQLITE_DB_PATH || 'db.sqlite', { readonly: true });
const row = db.prepare("SELECT value FROM store WHERE key = 'generated_scripts'").get();
const scripts = row ? JSON.parse(row.value) : [];
const tasks = db.prepare(`
  SELECT id,projectId,targetId,shotIndex,status,workflowPresetId,workflowFamily,model,sourceImageUrl,
         characterReferenceImageUrl,characterReferenceTaskId,lockCharacterIdentity,createdAt
  FROM comfyui_tasks
  WHERE targetType = 'shot' AND viewType = 'main'
  ORDER BY createdAt DESC
`).all();

const latestBySlot = new Map();
for (const task of tasks) {
  const key = `${task.projectId}:${task.targetId}`;
  if (!latestBySlot.has(key)) latestBySlot.set(key, task);
}

const projects = [];
for (const script of scripts) {
  const shots = (script.newShots || []).map((shot, shotIndex) => {
    const explicit = new Set([...(shot.characterIds || []), ...(shot.characters || []), ...(shot.characterNames || [])].map(value => String(value).trim().toLocaleLowerCase()).filter(Boolean));
    const searchable = String(shot.description || '').toLocaleLowerCase();
    const matchedCharacters = (script.newCharacters || []).filter(character => {
      const id = String(character.id || '').trim().toLocaleLowerCase();
      const name = String(character.name || '').trim().toLocaleLowerCase();
      return (id && explicit.has(id)) || (name && (explicit.has(name) || searchable.includes(name)));
    });
    const task = latestBySlot.get(`${script.id}:${shot.id}`) || null;
    const missingAvatar = matchedCharacters.filter(character => !character.avatarUrl).map(character => character.name);
    const hasReference = !!(task?.sourceImageUrl || task?.characterReferenceImageUrl);
    const suspiciousSubtitle = /\ufffd|Ã|Â|ï¼|trotopty/i.test(String(shot.description || ''));
    return {
      shotIndex,
      shotId: shot.id || null,
      style: shot.style || '写实（默认）',
      matchedCharacters: matchedCharacters.map(character => ({ id: character.id || null, name: character.name, avatarUrl: character.avatarUrl || null, views: character.views || null })),
      missingAvatar,
      latestTask: task,
      flags: {
        characterDetectedButReferenceMissing: matchedCharacters.length > 0 && !hasReference,
        characterDetectedButNotPulid: matchedCharacters.length > 0 && !!task && task.workflowPresetId !== '02_klein_pulid_identity',
        noCharacterDetected: matchedCharacters.length === 0,
        suspiciousSubtitle,
      },
      subtitleSource: suspiciousSubtitle ? shot.description : undefined,
    };
  });
  const modelCounts = {};
  for (const shot of shots) {
    const key = `${shot.latestTask?.workflowPresetId || 'no-task'} | ${shot.latestTask?.model || 'no-model'}`;
    modelCounts[key] = (modelCounts[key] || 0) + 1;
  }
  projects.push({
    projectId: script.id,
    title: script.newTitle || script.title || script.topic || 'Untitled',
    modelCounts,
    anomalyCount: shots.filter(shot => Object.entries(shot.flags).some(([key, value]) => key !== 'noCharacterDetected' && value)).length,
    shots,
  });
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), projectCount: projects.length, projects }, null, 2));
db.close();
