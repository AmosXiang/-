const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:3001';
const projectId = process.argv[2];

if (!projectId) {
  console.error('Usage: node scripts/e2e-comfyui.mjs <projectId>');
  process.exit(2);
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function saveGeneration(target, imageUrl, generation) {
  return jsonRequest(`/api/generated-scripts/${projectId}/image`, {
    method: 'PUT',
    body: JSON.stringify({ ...target, ...(imageUrl ? { imageUrl } : {}), generation }),
  });
}

async function waitForTask(taskId) {
  const started = Date.now();
  while (true) {
    const tasks = await jsonRequest(`/api/comfyui/tasks?projectId=${projectId}`);
    const task = tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found in queue`);
    if (task.status === 'succeeded') {
      return task;
    }
    if (task.status === 'failed') {
      const err = new Error(task.errorMsg || 'Task failed');
      err.task = task;
      throw err;
    }
    if (task.status === 'cancelled') {
      throw new Error('Task was cancelled');
    }
    if (Date.now() - started > 180000) { // 3 minutes timeout
      throw new Error(`Timeout waiting for task ${taskId}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

const scripts = await jsonRequest('/api/generated-scripts');
const project = scripts.find(item => item.id === projectId);
if (!project) throw new Error(`Project ${projectId} not found`);
if (project.newShots.length !== 5 || project.newCharacters.length !== 1) {
  throw new Error(`Expected 5 shots and 1 character; received ${project.newShots.length} shots and ${project.newCharacters.length} characters`);
}

const negativePrompt = 'low quality, blurry, deformed, extra limbs, bad anatomy, text, watermark';
const summary = [];

// Expected failure: validate that one bad item can be recorded and later items continue.
try {
  await jsonRequest('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({ prompt: '', platform: 'comfyui', projectId, targetType: 'shot', shotIndex: 0 }),
  });
  throw new Error('The intentional empty-prompt request unexpectedly succeeded');
} catch (error) {
  if (error.status !== 400) throw error;
  const failure = {
    provider: 'comfyui',
    status: 'failed',
    prompt: '',
    negativePrompt,
    width: 768,
    height: 512,
    projectId,
    targetType: 'shot',
    shotIndex: 0,
    createdAt: new Date().toISOString(),
    error: error.message,
  };
  await saveGeneration({ shotIndex: 0 }, undefined, failure);
  summary.push({ target: 'intentional-failure', status: 'recorded', error: error.message });
}

const character = project.newCharacters[0];
const identityAnchor = 'the same single black-haired cyberpunk woman, asymmetrical dark-blue highlights, blue glowing right cybernetic eye, dark technical jacket, encrypted metal collar and circuit pendant';
const characterPrompt = `${identityAnchor}, full body character concept art, neutral pose, cinematic SDXL, detailed face, consistent identity, plain dark studio background`;

const targets = [
  {
    label: 'character',
    target: { characterName: character.name },
    request: {
      prompt: characterPrompt,
      isCharacter: true,
      projectId,
      targetType: 'character',
      characterName: character.name,
      targetId: character.id,
      viewType: 'avatar',
    },
  },
  ...project.newShots.map((shot, shotIndex) => ({
    label: `shot-${shotIndex + 1}`,
    target: { shotIndex },
    request: {
      prompt: `${identityAnchor}. Cinematic storyboard frame ${shotIndex + 1}, ${shot.description}`,
      isCharacter: false,
      projectId,
      targetType: 'shot',
      shotIndex,
      targetId: shot.id,
      viewType: 'main',
    },
  })),
];

for (const item of targets) {
  const started = Date.now();
  try {
    const result = await jsonRequest('/api/generate-image', {
      method: 'POST',
      body: JSON.stringify({
        ...item.request,
        platform: 'comfyui',
        skipTranslation: true,
        negativePrompt,
      }),
    });
    
    if (!result.taskId) {
      throw new Error(`Did not receive taskId on submission`);
    }

    console.log(`Submitted ${item.label}, taskId: ${result.taskId}. Waiting for completion...`);
    const task = await waitForTask(result.taskId);
    
    // Check database update
    const updatedScripts = await jsonRequest('/api/generated-scripts');
    const updatedProj = updatedScripts.find(p => p.id === projectId);
    
    let imageUrl = '';
    if (item.request.targetType === 'character') {
      const char = updatedProj.newCharacters.find(c => c.name === item.request.characterName);
      imageUrl = char?.avatarUrl;
    } else {
      const shot = updatedProj.newShots[item.request.shotIndex];
      imageUrl = shot?.generatedImageUrl || shot?.imageUrl;
    }

    if (!imageUrl) {
      throw new Error(`Database record was not updated with the image URL for ${item.label}`);
    }

    summary.push({
      target: item.label,
      status: 'succeeded',
      seconds: Math.round((Date.now() - started) / 100) / 10,
      url: imageUrl,
      seed: task.seed,
      model: task.model,
      size: `${task.width}x${task.height}`,
    });
  } catch (error) {
    summary.push({ target: item.label, status: 'failed', error: error.message });
  }
}

console.log(JSON.stringify({ projectId, summary }, null, 2));
if (summary.some(item => item.target !== 'intentional-failure' && item.status !== 'succeeded')) process.exit(1);
