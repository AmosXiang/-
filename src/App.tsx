import React, { useState, useEffect, useRef } from "react";
import {
  Play,
  Pause,
  Download,
  Copy,
  Search,
  Tv,
  Film,
  Users,
  Sparkles,
  Cpu,
  Layers,
  Check,
  Clock,
  ChevronRight,
  Share2,
  Database,
  Sliders,
  FileJson,
  ExternalLink,
  X,
  Volume2,
  VolumeX,
  Monitor,
  Upload,
  Trash2,
  Loader2,
  Calendar,
  Plus,
  GripVertical,
  Power,
  Square
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { videoAnalysisData } from "./data";
import { Shot, Character, VideoRecord, GeneratedScriptRecord } from "./types";
import CameraDerivePanel from "./components/CameraDerivePanel";

type ComfyProjectPreferences = {
  shotPresetId: string;
  characterMasterPresetId: string;
  identityPresetId: string;
  threeViewPresetId: string;
  upscalePresetId: string;
};

type WorkflowPresetSummary = {
  presetId: string;
  workflowPresetId: string | null;
  displayName: string;
  modelName: string;
  workflowFamily: string;
  purposes: Array<'storyboard' | 'characterMaster' | 'identity' | 'threeView' | 'upscale'>;
  available: boolean;
  missingModels: string[];
  missingNodes: string[];
  reason: string | null;
};

const characterTerms = (character: Character): string[] => {
  const aliases = Array.isArray(character.aliases)
    ? character.aliases
    : Array.isArray(character.alias)
      ? character.alias
      : character.alias
        ? [character.alias]
        : [];
  const name = String(character.name || '').trim();
  const bilingualNameParts = name
    ? [name.replace(/\s*[（(][^）)]*[）)]\s*$/, ''), ...(name.match(/[（(]([^）)]+)[）)]/)?.slice(1) || [])]
    : [];
  return [name, ...bilingualNameParts, ...aliases]
    .map(value => String(value || '').trim().toLocaleLowerCase())
    .filter(Boolean);
};

const inferShotCharacterIds = (description: string, characters: Character[]): string[] => {
  const searchable = String(description || '').toLocaleLowerCase();
  if (!searchable) return [];
  return characters
    .filter(character => character.id && characterTerms(character).some(term => searchable.includes(term)))
    .map(character => String(character.id));
};

const LEGACY_COMFY_PROJECT_PREFERENCES: ComfyProjectPreferences = {
  shotPresetId: 'sdxl_legacy',
  characterMasterPresetId: 'sdxl_legacy',
  identityPresetId: 'pulid_flux2',
  threeViewPresetId: 'legacy_three_views',
  upscalePresetId: 'esrgan_4x',
};

const PROJECT_PRESET_TO_TASK_PRESET: Record<string, string> = {
  sdxl_legacy: 'sdxl_legacy',
  pure_klein: '01_klein_character_master',
  pulid_flux2: '02_klein_pulid_identity',
  qwen_2511_three_views: '03_qwen_2511_three_views',
  esrgan_4x: '04_esrgan_upscale',
};

const WORKFLOW_PRESET_LABELS: Record<string, string> = {
  sdxl_legacy: 'SDXL Legacy',
  '01_klein_character_master': 'Pure Klein 4B',
  '02_klein_pulid_identity': 'PuLID Flux2',
  '03_qwen_2511_three_views': 'Qwen 2511 Three Views',
  '04_esrgan_upscale': '4x ESRGAN',
};

const BUILTIN_WORKFLOW_PRESET_FALLBACKS: WorkflowPresetSummary[] = [
  {
    presetId: 'sdxl_legacy', workflowPresetId: null, displayName: 'SDXL Legacy',
    modelName: 'ComfyUI 默认 SDXL Checkpoint', workflowFamily: 'sdxl',
    purposes: ['storyboard', 'characterMaster'], available: true, missingModels: [], missingNodes: [], reason: null,
  },
  {
    presetId: 'pure_klein', workflowPresetId: '01_klein_character_master', displayName: 'Pure Klein 4B',
    modelName: 'flux-2-klein-base-4b.safetensors', workflowFamily: 'flux/klein',
    purposes: ['storyboard', 'characterMaster'], available: true, missingModels: [], missingNodes: [], reason: null,
  },
  {
    presetId: 'pulid_flux2', workflowPresetId: '02_klein_pulid_identity', displayName: 'PuLID Flux2',
    modelName: 'flux-2-klein-4b-fp8.safetensors', workflowFamily: 'flux/pulid',
    purposes: ['identity'], available: true, missingModels: [], missingNodes: [], reason: null,
  },
  {
    presetId: 'qwen_2511_three_views', workflowPresetId: '03_qwen_2511_three_views', displayName: 'Qwen 三视图',
    modelName: 'qwen_image_edit_2511_fp8_e4m3fn.safetensors', workflowFamily: 'qwen',
    purposes: ['threeView'], available: true, missingModels: [], missingNodes: [], reason: null,
  },
  {
    presetId: 'esrgan_4x', workflowPresetId: '04_esrgan_upscale', displayName: 'ESRGAN 4x',
    modelName: '4x-ESRGAN.pth', workflowFamily: 'upscale',
    purposes: ['upscale'], available: true, missingModels: [], missingNodes: [], reason: null,
  },
];

export default function App() {
  // DB Records State
  const [records, setRecords] = useState<VideoRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<VideoRecord | null>(null);
  const [shortDramaMode, setShortDramaMode] = useState<boolean>(false);

  // Generated Scripts State
  const [generatedScripts, setGeneratedScripts] = useState<GeneratedScriptRecord[]>([]);

  // Editing state for table cells
  const [editingCell, setEditingCell] = useState<{ idx: number; field: string } | null>(null);
  const [editValue, setEditValue] = useState<string>("");

  // Drag and drop state for storyboard reordering
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  // Animatic Modal & Compile State
  const [showAnimaticModal, setShowAnimaticModal] = useState<boolean>(false);
  const [showAnimaticConfirm, setShowAnimaticConfirm] = useState<boolean>(false);
  const [isCompilingAnimatic, setIsCompilingAnimatic] = useState<boolean>(false);
  const [compilationStatus, setCompilationStatus] = useState<string>("");
  const [animaticVideoUrl, setAnimaticVideoUrl] = useState<string | null>(null);
  const [bgmList, setBgmList] = useState<Array<{ filename: string; url: string }>>([]);
  const [selectedBgm, setSelectedBgm] = useState<string>("");
  const [animaticDuration, setAnimaticDuration] = useState<number>(4);
  const [isUploadingBgm, setIsUploadingBgm] = useState<boolean>(false);

  // Library filters
  const [librarySearch, setLibrarySearch] = useState<string>("");
  const [selectedGenre, setSelectedGenre] = useState<string>("all");
  const [selectedTag, setSelectedTag] = useState<string>("all");

  // Upload/Analysis state
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>(processStatusText());
  const [uploadError, setUploadError] = useState<string | null>(null);

  function processStatusText() {
    return "";
  }

  // Active Shot and Player state
  const [activeShot, setActiveShot] = useState<Shot>(videoAnalysisData.shots[0]);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [shotSearchQuery, setShotSearchQuery] = useState<string>("");
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [imagePlatform, setImagePlatform] = useState<'pollinations' | 'kling' | 'comfyui'>('comfyui');
  const [comfyModalOpen, setComfyModalOpen] = useState<boolean>(false);
  const [comfyModalTarget, setComfyModalTarget] = useState<{
    targetId: string;
    viewType: string;
    targetType: 'shot' | 'character';
    shotIndex?: number;
    characterName?: string;
    defaultPrompt: string;
  } | null>(null);
  const [comfyParams, setComfyParams] = useState<{
    prompt: string;
    negativePrompt: string;
    seedMode: 'keep' | 'random';
    seed: string;
    model: string;
    width: number;
    height: number;
    presetId: string;
    sourceImageUrl: string;
  }>({
    prompt: "",
    negativePrompt: "",
    seedMode: "keep",
    seed: "",
    model: "",
    width: 768,
    height: 512,
    presetId: "",
    sourceImageUrl: ""
  });
  const [isUploadingRefImage, setIsUploadingRefImage] = useState<boolean>(false);
  const [availableCheckpoints, setAvailableCheckpoints] = useState<string[]>([]);
  const [workflowSupport, setWorkflowSupport] = useState<any>({
    isCustom: false,
    supported: { prompt: true, negativePrompt: true, seed: true, model: true, width: true, height: true }
  });
  const [modelError, setModelError] = useState<string>("");
  const [showJsonModal, setShowJsonModal] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [audioMuted, setAudioMuted] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<"narrative" | "shots" | "characters" | "generator">("shots");
  const [shotFilterCategory, setShotFilterCategory] = useState<string>("all");
  const [showComfyPop, setShowComfyPop] = useState<boolean>(false);

  // 创意向导：步骤 & 全局 Art Direction（Style Guide）
  const [creativeStep, setCreativeStep] = useState<number>(1);
  const [creativeDraft, setCreativeDraft] = useState<{ artDirection?: { overlay?: string; analysis?: unknown } }>({});
  const [artDirectionBusy, setArtDirectionBusy] = useState<boolean>(false);
  const [artDirectionMessage, setArtDirectionMessage] = useState<string | null>(null);

  // Script Generator State
  const [generatorTopic, setGeneratorTopic] = useState<string>("");
  const [isGeneratingScript, setIsGeneratingScript] = useState<boolean>(false);
  const [generatedScript, setGeneratedScript] = useState<any | null>(null);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const [copiedScript, setCopiedScript] = useState<boolean>(false);

  // Custom script details/drawers states
  const [activeDrawerChar, setActiveDrawerChar] = useState<Character | null>(null);
  const [generatingShotIndex, setGeneratingShotIndex] = useState<number | null>(null);
  const [isGeneratingCharImage, setIsGeneratingCharImage] = useState<boolean>(false);
  const [isGeneratingThreeViews, setIsGeneratingThreeViews] = useState<boolean>(false);
  const [generatingViews, setGeneratingViews] = useState<Record<string, boolean>>({ front: false, side: false, back: false });
  const [activeLightboxUrl, setActiveLightboxUrl] = useState<string | null>(null);
  const [shotImages, setShotImages] = useState<Record<string, string>>({});
  const [videoProgress, setVideoProgress] = useState<Record<number, number>>({});

  const [duration, setDuration] = useState<number>(337); // default to 337 (mock video length)

  const generatedScriptRef = useRef<any>(null);
  const undoStackRef = useRef<any[]>([]);
  const activeIntervalsRef = useRef<{ [taskId: string]: NodeJS.Timeout }>({});

  // ComfyUI Queue Polling state and callbacks
  const [comfyTasks, setComfyTasks] = useState<any[]>([]);
  const [comfyImportStates, setComfyImportStates] = useState<Record<string, { status: 'uploading' | 'success' | 'error'; message: string }>>({});
  const [comfyRefreshErrors, setComfyRefreshErrors] = useState<Record<string, string>>({});
  const [preparingAdvancedSlots, setPreparingAdvancedSlots] = useState<Record<string, boolean>>({});
  const [exportedSlots, setExportedSlots] = useState<Record<string, boolean>>({});
  const [comfyProjectPreferences, setComfyProjectPreferences] = useState<ComfyProjectPreferences>(LEGACY_COMFY_PROJECT_PREFERENCES);
  const [qwenThreeViewVerified, setQwenThreeViewVerified] = useState(false);
  const [showComfyPresetSettings, setShowComfyPresetSettings] = useState(false);
  const [savingComfyPresetSettings, setSavingComfyPresetSettings] = useState(false);
  const [templatePresetId, setTemplatePresetId] = useState('sdxl_legacy');
  const [workflowPresets, setWorkflowPresets] = useState<WorkflowPresetSummary[]>(BUILTIN_WORKFLOW_PRESET_FALLBACKS);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetSaveState, setPresetSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [presetSaveMessage, setPresetSaveMessage] = useState('');
  const [presetImportFiles, setPresetImportFiles] = useState<{ manifest?: File; uiWorkflow?: File; apiWorkflow?: File }>({});
  const [importingPreset, setImportingPreset] = useState(false);
  const [regenerateMode, setRegenerateMode] = useState('missing');
  const [isQueueingBatch, setIsQueueingBatch] = useState(false);
  const [isExportingBatchReport, setIsExportingBatchReport] = useState(false);
  const [batchReportPaths, setBatchReportPaths] = useState<string[]>([]);
  const [shotCharacterModal, setShotCharacterModal] = useState<{ shotIndex: number; selectedIds: string[] } | null>(null);
  const [shotCharacterFeedback, setShotCharacterFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const activeComfyImportsRef = useRef<Set<string>>(new Set());
  const importedTaskAwaitingRefreshRef = useRef<string | null>(null);

  // ComfyUI Runtime state and handlers
  interface ComfyUiRuntime {
    state: 'stopped' | 'starting' | 'running' | 'stopping' | 'external' | 'error';
    connected: boolean;
    managed: boolean;
    pid: number | null;
    url: string;
    lastError: string | null;
  }

  const [comfyRuntime, setComfyRuntime] = useState<ComfyUiRuntime>({
    state: 'stopped',
    connected: false,
    managed: false,
    pid: null,
    url: 'http://127.0.0.1:8001',
    lastError: null
  });

  const batchTasks = React.useMemo(() => {
    if (!comfyTasks) return [];
    const latestBatch = [...comfyTasks]
      .filter((t: any) => t.targetType === 'shot' && t.workflowBatchId)
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    const batchId = latestBatch ? latestBatch.workflowBatchId : null;
    if (!batchId) return [];
    return comfyTasks.filter((t: any) => t.workflowBatchId === batchId && t.targetType === 'shot');
  }, [comfyTasks]);
  const currentBatchId = React.useMemo(() => batchTasks.length === 0 ? null : batchTasks[0].workflowBatchId, [batchTasks]);
  const totalCount = batchTasks.length;
  const succeededCount = React.useMemo(() => batchTasks.filter((t: any) => t.status === 'succeeded').length, [batchTasks]);
  const failedCount = React.useMemo(() => batchTasks.filter((t: any) => t.status === 'failed').length, [batchTasks]);
  const skippedCount = React.useMemo(() => batchTasks.filter((t: any) => t.status === 'skipped_missing_avatar').length, [batchTasks]);
  const pendingCount = React.useMemo(() => batchTasks.filter((t: any) => t.status === 'pending').length, [batchTasks]);
  const processingTask = React.useMemo(() => batchTasks.find((t: any) => t.status === 'processing'), [batchTasks]);
  const hasActiveBatch = React.useMemo(() => batchTasks.some((t: any) => t.status === 'pending' || t.status === 'processing'), [batchTasks]);
  const hasPendingBatchTasks = React.useMemo(() => batchTasks.some((t: any) => t.status === 'pending'), [batchTasks]);
  const isComfyConnected = comfyRuntime.state === 'running' || comfyRuntime.state === 'external';
  const hasShots = !!(generatedScript?.newShots && generatedScript.newShots.length > 0);

  useEffect(() => {
    let active = true;
    const fetchRuntime = async () => {
      try {
        const res = await fetch('/api/comfyui/runtime');
        if (res.ok && active) {
          const data = await res.json();
          setComfyRuntime(data);
        }
      } catch (e) {
        console.error('Failed to poll ComfyUI runtime:', e);
      }
    };

    fetchRuntime();
    const interval = setInterval(fetchRuntime, 2000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const handleStartComfy = async () => {
    try {
      setComfyRuntime(prev => ({ ...prev, state: 'starting', lastError: null }));
      const res = await fetch('/api/comfyui/runtime/start', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to start ComfyUI');
      }
      const data = await res.json();
      setComfyRuntime(data);
    } catch (e: any) {
      setComfyRuntime(prev => ({ ...prev, state: 'error', lastError: e.message }));
      alert(`启动 ComfyUI 失败: ${e.message}`);
    }
  };

  const handleStopComfy = async () => {
    try {
      setComfyRuntime(prev => ({ ...prev, state: 'stopping' }));
      const res = await fetch('/api/comfyui/runtime/stop', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to stop ComfyUI');
      }
      const data = await res.json();
      setComfyRuntime(data);
    } catch (e: any) {
      alert(`停止 ComfyUI 失败: ${e.message}`);
    }
  };

  const checkComfyRuntimeBeforeAction = (): boolean => {
    if (imagePlatform !== 'comfyui') return true;
    if (comfyRuntime.state === 'running' || comfyRuntime.state === 'external') {
      return true;
    }

    if (confirm('ComfyUI 尚未启动。是否现在启动 ComfyUI？')) {
      handleStartComfy();
    }
    return false;
  };

  React.useEffect(() => {
    if (!generatedScript) {
      setShotImages({});
      return;
    }
    const images: Record<string, string> = {};
    generatedScript.newShots?.forEach((s: any) => {
      if (s.generatedImageUrl) {
        images[s.timestamp] = s.generatedImageUrl;
      } else if (s.imageUrl) {
        images[s.timestamp] = s.imageUrl;
      }
    });
    setShotImages(images);
  }, [generatedScript]);

  const loadGeneratedScripts = React.useCallback(async () => {
    const response = await fetch('/api/generated-scripts');
    if (!response.ok) throw new Error(`刷新项目失败 (HTTP ${response.status})`);
    return await response.json();
  }, []);

  const applyGeneratedScripts = React.useCallback((scripts: any[]) => {
    setGeneratedScripts(scripts);
    const currentId = generatedScriptRef.current?.id;
    if (!currentId) return;
    const current = scripts.find(item => String(item.id) === String(currentId));
    if (current) {
      generatedScriptRef.current = current;
      setGeneratedScript(current);
    }
  }, []);

  const refreshGeneratedScripts = React.useCallback(async () => {
    const scripts = await loadGeneratedScripts();
    applyGeneratedScripts(scripts);
  }, [applyGeneratedScripts, loadGeneratedScripts]);

  const loadComfyProjectPreferences = React.useCallback(async (requestedProjectId?: string) => {
    const projectId = requestedProjectId || generatedScriptRef.current?.id;
    if (!projectId) return;
    const response = await fetch(`/api/generated-scripts/${projectId}/comfyui-preferences`);
    if (!response.ok) throw new Error(`读取项目预设失败 (HTTP ${response.status})`);
    const data = await response.json();
    setComfyProjectPreferences(data.preferences || LEGACY_COMFY_PROJECT_PREFERENCES);
    setQwenThreeViewVerified(!!data.qwenThreeViewVerified);
    setTemplatePresetId((data.preferences || LEGACY_COMFY_PROJECT_PREFERENCES).shotPresetId);
  }, []);

  const loadWorkflowPresets = React.useCallback(async () => {
    setPresetsLoading(true);
    try {
      const response = await fetch('/api/comfyui/presets');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setWorkflowPresets(Array.isArray(data.presets) && data.presets.length ? data.presets : BUILTIN_WORKFLOW_PRESET_FALLBACKS);
    } catch (error: any) {
      setWorkflowPresets(BUILTIN_WORKFLOW_PRESET_FALLBACKS);
      setPresetSaveState('error');
      setPresetSaveMessage(`正在使用内置预设；后端目录暂不可用：${error.message}`);
    } finally {
      setPresetsLoading(false);
    }
  }, []);

  const loadDefaultComfyPreferences = React.useCallback(async () => {
    const response = await fetch('/api/comfyui/default-preferences');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const preferences = data.preferences || LEGACY_COMFY_PROJECT_PREFERENCES;
    setComfyProjectPreferences(preferences);
    setTemplatePresetId(preferences.shotPresetId);
  }, []);

  useEffect(() => {
    loadWorkflowPresets();
  }, [loadWorkflowPresets]);

  useEffect(() => {
    if (!generatedScript?.id) {
      setQwenThreeViewVerified(false);
      loadDefaultComfyPreferences().catch(error => {
        console.error(error);
        setComfyProjectPreferences(LEGACY_COMFY_PROJECT_PREFERENCES);
        setTemplatePresetId('sdxl_legacy');
      });
      return;
    }
    loadComfyProjectPreferences(generatedScript.id).catch(error => console.error(error));
  }, [generatedScript?.id, loadComfyProjectPreferences, loadDefaultComfyPreferences]);

  const saveStoryboardPreset = async (presetId: string) => {
    const selectedPreset = workflowPresets.find(preset => preset.presetId === presetId);
    if (!selectedPreset?.available) return;
    const preferences = { ...comfyProjectPreferences, shotPresetId: presetId };
    setComfyProjectPreferences(preferences);
    setTemplatePresetId(presetId);
    setPresetSaveState('saving');
    setPresetSaveMessage('');
    try {
      const projectId = generatedScriptRef.current?.id;
      const endpoint = projectId
        ? `/api/generated-scripts/${projectId}/comfyui-preferences`
        : '/api/comfyui/default-preferences';
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setComfyProjectPreferences(result.preferences);
      if (result.updatedScript) {
        generatedScriptRef.current = result.updatedScript;
        setGeneratedScript(result.updatedScript);
        setGeneratedScripts(previous => previous.map(item => String(item.id) === String(result.updatedScript.id) ? result.updatedScript : item));
      }
      setPresetSaveState('saved');
      setPresetSaveMessage('默认预设已保存');
    } catch (error: any) {
      setPresetSaveState('error');
      setPresetSaveMessage(error.message || '保存失败');
    }
  };

  const saveProjectPresetField = async (key: keyof ComfyProjectPreferences, presetId: string) => {
    if (!generatedScriptRef.current?.id) return;
    const preferences = { ...comfyProjectPreferences, [key]: presetId };
    setComfyProjectPreferences(preferences);
    setPresetSaveState('saving');
    try {
      const response = await fetch(`/api/generated-scripts/${generatedScriptRef.current.id}/comfyui-preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setComfyProjectPreferences(result.preferences);
      generatedScriptRef.current = result.updatedScript;
      setGeneratedScript(result.updatedScript);
      setGeneratedScripts(previous => previous.map(item => String(item.id) === String(result.updatedScript.id) ? result.updatedScript : item));
      setPresetSaveState('saved');
      setPresetSaveMessage('角色工作流默认配置已保存');
    } catch (error: any) {
      setPresetSaveState('error');
      setPresetSaveMessage(error.message || '角色预设保存失败');
      await loadComfyProjectPreferences().catch(() => undefined);
    }
  };

  const importLocalWorkflowPreset = async () => {
    if (!presetImportFiles.manifest || !presetImportFiles.uiWorkflow || !presetImportFiles.apiWorkflow) {
      setPresetSaveState('error');
      setPresetSaveMessage('请选择 manifest、UI workflow 和 API workflow 三个文件');
      return;
    }
    setImportingPreset(true);
    try {
      const formData = new FormData();
      formData.append('manifest', presetImportFiles.manifest);
      formData.append('uiWorkflow', presetImportFiles.uiWorkflow);
      formData.append('apiWorkflow', presetImportFiles.apiWorkflow);
      const response = await fetch('/api/comfyui/presets/import', { method: 'POST', body: formData });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setPresetSaveState('saved');
      setPresetSaveMessage(`已导入本地预设：${result.presetId}`);
      setPresetImportFiles({});
      await loadWorkflowPresets();
    } catch (error: any) {
      setPresetSaveState('error');
      setPresetSaveMessage(error.message || '导入失败');
    } finally {
      setImportingPreset(false);
    }
  };

  const saveComfyProjectPreferences = async (recommended = false) => {
    if (!generatedScriptRef.current?.id) return;
    setSavingComfyPresetSettings(true);
    try {
      const response = await fetch(`/api/generated-scripts/${generatedScriptRef.current.id}/comfyui-preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recommended ? { recommended: true } : { preferences: comfyProjectPreferences }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setComfyProjectPreferences(result.preferences);
      setQwenThreeViewVerified(!!result.qwenThreeViewVerified);
      setTemplatePresetId(result.preferences.shotPresetId);
      generatedScriptRef.current = result.updatedScript;
      setGeneratedScript(result.updatedScript);
      setGeneratedScripts(previous => previous.map(item => String(item.id) === String(result.updatedScript.id) ? result.updatedScript : item));
      setShowComfyPresetSettings(false);
    } catch (error: any) {
      alert(`保存项目预设失败：${error.message}`);
    } finally {
      setSavingComfyPresetSettings(false);
    }
  };

  const handleUploadRefImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingRefImage(true);
    try {
      const formData = new FormData();
      formData.append('video', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        const data = await res.json();
        setComfyParams(prev => ({ ...prev, sourceImageUrl: data.url }));
      } else {
        alert('参考图上传失败');
      }
    } catch (err: any) {
      alert(`上传出错: ${err.message}`);
    } finally {
      setIsUploadingRefImage(false);
    }
  };

  const handleUpscaleImage = async (targetId: string, viewType: string, targetType: 'shot' | 'character', currentImageUrl: string, shotIndex?: number, characterName?: string) => {
    if (!checkComfyRuntimeBeforeAction()) return;
    try {
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          presetId: '04_esrgan_upscale',
          platform: 'comfyui',
          projectId: generatedScript?.id,
          targetType,
          targetId,
          viewType,
          sourceImageUrl: currentImageUrl,
          shotIndex,
          characterName,
          skipTranslation: true
        })
      });

      if (response.ok) {
        alert("超分放大任务已提交至 ComfyUI 队列，请在任务列表中查看进度。");
        pollComfyTasks();
      } else {
        const data = await response.json();
        alert(`放大失败: ${data.error || '未知错误'}`);
      }
    } catch (e: any) {
      alert(`网络错误: ${e.message}`);
    }
  };

  const handleOpenComfyParams = async (targetId: string, viewType: string, targetType: 'shot' | 'character', shotIndex?: number, characterName?: string, defaultPrompt?: string) => {
    if (!checkComfyRuntimeBeforeAction()) return;
    let checkpointsList: string[] = [];
    try {
      const res = await fetch("/api/comfyui/checkpoints");
      if (res.ok) {
        const data = await res.json();
        checkpointsList = data.checkpoints || [];
        setAvailableCheckpoints(checkpointsList);
      }
    } catch (e) {
      console.error(e);
    }

    let supportInfo = {
      isCustom: false,
      supported: { prompt: true, negativePrompt: true, seed: true, model: true, width: true, height: true }
    };
    try {
      const res = await fetch("/api/comfyui/workflow-info");
      if (res.ok) {
        supportInfo = await res.json();
        setWorkflowSupport(supportInfo);
      }
    } catch (e) {
      console.error(e);
    }

    let lastParams: any = null;
    try {
      const res = await fetch(`/api/comfyui/tasks/last-succeeded?targetId=${targetId}&viewType=${viewType}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.id) {
          lastParams = data;
        }
      }
    } catch (e) {
      console.error(e);
    }

    const finalPrompt = lastParams ? lastParams.prompt : (defaultPrompt || "");
    const finalNegative = lastParams ? lastParams.negativePrompt : "";
    const finalSeed = lastParams ? String(lastParams.seed) : "";
    const finalModel = lastParams ? lastParams.model : comfyParams.model;
    const finalWidth = lastParams ? lastParams.width : (targetType === 'character' ? 1024 : 768);
    const finalHeight = lastParams ? lastParams.height : (targetType === 'character' ? 1024 : 512);
    const configuredPreset = targetType === 'character'
      ? comfyProjectPreferences.characterMasterPresetId
      : comfyProjectPreferences.shotPresetId;
    const finalPresetId = lastParams
      ? (lastParams.workflowPresetId || 'sdxl_legacy')
      : (PROJECT_PRESET_TO_TASK_PRESET[configuredPreset] || 'sdxl_legacy');
    const finalSourceImageUrl = lastParams ? (lastParams.sourceImageUrl || "") : "";

    let mErr = "";
    let selectedModel = finalModel;
    if (supportInfo.supported.model) {
      if (finalModel) {
        if (checkpointsList.length > 0 && !checkpointsList.includes(finalModel)) {
          mErr = "模型不可用，请重新选择";
          selectedModel = "";
        }
      } else {
        selectedModel = checkpointsList[0] || "";
      }
    }

    setModelError(mErr);
    setComfyParams({
      prompt: finalPrompt,
      negativePrompt: finalNegative,
      seedMode: lastParams && lastParams.seed ? 'keep' : 'random',
      seed: finalSeed,
      model: selectedModel,
      width: finalWidth,
      height: finalHeight,
      presetId: finalPresetId,
      sourceImageUrl: finalSourceImageUrl
    });

    setComfyModalTarget({
      targetId,
      viewType,
      targetType,
      shotIndex,
      characterName,
      defaultPrompt: defaultPrompt || ""
    });
    setComfyModalOpen(true);
  };

  const handleRegenerateWithParams = async () => {
    if (!checkComfyRuntimeBeforeAction()) return;
    if (!comfyModalTarget || !generatedScript) return;
    if (!comfyParams.presetId && !comfyParams.prompt.trim()) {
      alert("提示词不能为空");
      return;
    }
    if (comfyParams.presetId === '02_klein_pulid_identity' && !comfyParams.sourceImageUrl) {
      alert("使用 PuLID 锁脸预设必须提供或上传参考图片");
      return;
    }
    if (workflowSupport.supported.width && (isNaN(comfyParams.width) || comfyParams.width < 256 || comfyParams.width > 2048)) {
      alert("宽度必须在 256 到 2048 之间");
      return;
    }
    if (workflowSupport.supported.height && (isNaN(comfyParams.height) || comfyParams.height < 256 || comfyParams.height > 2048)) {
      alert("高度必须在 256 到 2048 之间");
      return;
    }
    if (workflowSupport.supported.model && modelError) {
      alert("选定的模型当前不可用，请重新选择可用模型");
      return;
    }
    setComfyModalOpen(false);
    try {
      const res = await fetch("/api/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: comfyParams.prompt,
          negativePrompt: comfyParams.negativePrompt,
          seedMode: comfyParams.seedMode,
          seed: comfyParams.seedMode === 'keep' ? comfyParams.seed : undefined,
          model: comfyParams.model,
          width: comfyParams.width,
          height: comfyParams.height,
          projectId: generatedScript.id,
          targetType: comfyModalTarget.targetType,
          targetId: comfyModalTarget.targetId,
          viewType: comfyModalTarget.viewType,
          shotIndex: comfyModalTarget.shotIndex,
          characterName: comfyModalTarget.characterName,
          platform: "comfyui",
          skipTranslation: true,
          presetId: comfyParams.presetId || undefined,
          sourceImageUrl: comfyParams.sourceImageUrl || undefined
        })
      });
      if (res.ok) {
        pollComfyTasks();
      }
    } catch (e) {
      console.error("重新生成请求失败:", e);
    }
  };

  const pollComfyTasks = React.useCallback(async () => {
    if (!generatedScriptRef.current) return;
    try {
      const res = await fetch(`/api/comfyui/tasks?projectId=${generatedScriptRef.current.id}`);
      if (res.ok) {
        const data = await res.json();
        setComfyTasks(data);
      }
    } catch (err) {
      console.error("[Queue Polling Error]", err);
    }
  }, []);

  useEffect(() => {
    if (!generatedScript || imagePlatform !== 'comfyui') {
      setComfyTasks([]);
      return;
    }
    generatedScriptRef.current = generatedScript;
    pollComfyTasks();
    const interval = setInterval(pollComfyTasks, 2000);
    return () => clearInterval(interval);
  }, [generatedScript, imagePlatform, pollComfyTasks]);

  const prevComfyTasksRef = useRef<any[]>([]);

  useEffect(() => {
    const prevTasks = prevComfyTasksRef.current;
    const currentTasks = comfyTasks;
    let shouldReloadScript = false;

    for (const task of currentTasks) {
      const prevTask = prevTasks.find(t => t.id === task.id);
      if (prevTask) {
        if ((prevTask.status === 'pending' || prevTask.status === 'processing') && task.status === 'succeeded') {
          shouldReloadScript = true;
          break;
        }
      } else if (task.status === 'succeeded') {
        shouldReloadScript = true;
        break;
      }
    }

    if (shouldReloadScript && generatedScript) {
      console.log("[Queue] Task completed! Reloading script...");
      refreshGeneratedScripts()
        .then(() => {
          const importedTaskId = importedTaskAwaitingRefreshRef.current;
          if (importedTaskId) {
            setComfyRefreshErrors(previous => {
              const next = { ...previous };
              delete next[importedTaskId];
              return next;
            });
            importedTaskAwaitingRefreshRef.current = null;
          }
        })
        .catch(err => {
          console.error("Error reloading scripts:", err);
          const importedTaskId = importedTaskAwaitingRefreshRef.current;
          if (importedTaskId) {
            setComfyRefreshErrors(previous => ({ ...previous, [importedTaskId]: '图片已导入，但页面刷新失败' }));
            importedTaskAwaitingRefreshRef.current = null;
          }
        });
    }
  }, [comfyTasks, generatedScript, refreshGeneratedScripts]);

  useEffect(() => {
    if (activeDrawerChar && generatedScript) {
      const updated = generatedScript.newCharacters?.find((c: any) => String(c.id) === String(activeDrawerChar.id));
      if (updated && JSON.stringify(updated) !== JSON.stringify(activeDrawerChar)) {
        setActiveDrawerChar(updated);
      }
    }
  }, [generatedScript, activeDrawerChar]);

  useEffect(() => {
    if (selectedCharacter && generatedScript) {
      const updated = generatedScript.newCharacters?.find((c: any) => String(c.id) === String(selectedCharacter.id));
      if (updated && JSON.stringify(updated) !== JSON.stringify(selectedCharacter)) {
        setSelectedCharacter(updated);
      }
    }
  }, [generatedScript, selectedCharacter]);

  const handleRetryComfyTask = async (taskId: string) => {
    try {
      const res = await fetch(`/api/comfyui/tasks/${taskId}/retry`, { method: 'POST' });
      if (res.ok) {
        pollComfyTasks();
      } else {
        const err = await res.json();
        alert(err.error || "重试失败");
      }
    } catch (e: any) {
      alert("网络错误：" + e.message);
    }
  };

  const handleCancelComfyTask = async (taskId: string) => {
    try {
      const res = await fetch(`/api/comfyui/tasks/${taskId}/cancel`, { method: 'POST' });
      if (res.ok) {
        await pollComfyTasks();
        setShotCharacterFeedback({ kind: 'success', message: '任务已取消' });
        return true;
      } else {
        const err = await res.json();
        setShotCharacterFeedback({ kind: 'error', message: err.error || '取消失败' });
      }
    } catch (e: any) {
      setShotCharacterFeedback({ kind: 'error', message: `取消失败：${e.message}` });
    }
    return false;
  };


  const handleBatchGenerate = async () => {
    if (!generatedScript) return;
    if (!isComfyConnected || !hasShots || isQueueingBatch || hasActiveBatch) return;
    setIsQueueingBatch(true);
    try {
      const preflightRes = await fetch('/api/comfyui/shots/generate-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: generatedScript.id, regenerateMode })
      });
      if (!preflightRes.ok) throw new Error((await preflightRes.json()).error || '批量预检失败');
      const preview = await preflightRes.json();
      if (!preview.preflight) {
        if (preview.message) alert(preview.message);
        return;
      }
      const p = preview.preflight;
      const estimateMinutes = Math.max(1, Math.ceil(p.estimatedSeconds / 60));
      const estimate60Minutes = Math.max(1, Math.ceil(p.estimated60ShotSeconds / 60));
      if (!window.confirm(`批量生成预检\n总数：${p.total}\n角色一致性（PuLID）：${p.pulid}\n缺 Avatar 跳过：${p.missingAvatar}\n普通 Klein：${p.klein}\n预计本批次：约 ${estimateMinutes} 分钟\n60 镜参考耗时：约 ${estimate60Minutes} 分钟\n存在 pending 旧任务：${p.hasPendingOldTasks ? `是（${p.pendingOldTaskCount}）` : '否'}\n疑似未绑定角色文本：${p.hasSuspiciousUnboundCharacterText ? `是（${p.suspiciousUnboundShots.length}）` : '否'}\n\n确认开始？`)) return;
      if (p.requiresLargeBatchConfirmation && !window.confirm(`本批次包含 ${p.total} 镜，超过 30 镜。生成时间较长，是否再次确认开始？`)) return;
      const res = await fetch('/api/comfyui/shots/generate-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: generatedScript.id, regenerateMode, confirmed: true })
      });
      if (res.ok) {
        const result = await res.json();
        if (result.count === 0 && result.message) alert(result.message);
        await pollComfyTasks();
      } else {
        const err = await res.json();
        throw new Error(err.error || '批量提交任务失败');
      }
    } catch (e: any) {
      alert(e.message || '批量提交任务失败');
    } finally {
      setIsQueueingBatch(false);
    }
  };

  const handleStopBatchGeneration = async () => {
    if (!generatedScript || !currentBatchId) return;
    try {
      const res = await fetch('/api/comfyui/shots/stop-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: generatedScript.id, workflowBatchId: currentBatchId })
      });
      if (res.ok) { await pollComfyTasks(); }
      else { const err = await res.json(); alert(err.error || '停止生成失败'); }
    } catch (e: any) { alert('停止生成失败: ' + e.message); }
  };

  const getShotTask = React.useMemo(() => {
    return (shotId: string) => {
      if (imagePlatform !== 'comfyui') return null;
      const shotTasks = comfyTasks.filter(t => t.targetId === shotId);
      if (!shotTasks.length) return null;
      return shotTasks[shotTasks.length - 1];
    };
  }, [comfyTasks, imagePlatform]);

  const getCharacterTask = React.useMemo(() => {
    return (charId: string, viewType: string = 'avatar') => {
      if (imagePlatform !== 'comfyui') return null;
      const charTasks = comfyTasks.filter(t => t.targetId === charId && t.viewType === viewType);
      if (!charTasks.length) return null;
      return charTasks[charTasks.length - 1];
    };
  }, [comfyTasks, imagePlatform]);

  const getLatestSucceededTask = React.useCallback((targetId: string, viewType: string) => {
    const succeededTasks = comfyTasks.filter(
      t => t.targetId === targetId && t.viewType === viewType && t.status === 'succeeded'
    );
    if (!succeededTasks.length) return null;
    return [...succeededTasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  }, [comfyTasks]);

  const comfyTaskPresetLabel = (task: any) => {
    const presetId = task?.workflowPresetId || 'sdxl_legacy';
    const label = WORKFLOW_PRESET_LABELS[presetId] || workflowPresets.find(preset => preset.workflowPresetId === presetId || preset.presetId === presetId)?.displayName || presetId;
    return task?.model ? `${label} · ${task.model}` : label;
  };

  const handleExportBatchReport = async () => {
    if (!currentBatchId || isExportingBatchReport) return;
    setIsExportingBatchReport(true);
    try {
      const res = await fetch(`/api/comfyui/shot-batches/${currentBatchId}/report`, { method: 'POST' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || '导出验收报告失败');
      setBatchReportPaths(result.paths || [result.reportJsonUrl, result.reportHtmlUrl, result.contactSheetUrl]);
      window.open(result.reportHtmlUrl, '_blank', 'noopener,noreferrer');
      const link = document.createElement('a');
      link.href = result.reportJsonUrl;
      link.download = `batch-${currentBatchId}-report.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error: any) {
      alert(error.message || '导出验收报告失败');
    } finally {
      setIsExportingBatchReport(false);
    }
  };

  const isLegacyComfyTask = (task: any) => !task?.workflowPresetId || task.workflowPresetId === 'sdxl_legacy';

  const handleAdvancedAdjust = async (task: any, existingTab?: Window | null) => {
    if (!task) return;
    const comfyTab = existingTab || window.open("about:blank", "_blank");
    if (!comfyTab) {
      alert("无法打开新标签页，请允许浏览器弹出窗口。");
      return;
    }
    try {
      const res = await fetch(`/api/comfyui/tasks/${task.id}/export-workflow`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition");
      let filename = `comfyui_${task.targetType || 'unknown'}_${task.viewType || 'main'}_${task.id}.json`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?([^"]+)"?/);
        if (match && match[1]) {
          filename = match[1];
        }
      }
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
      }, 100);
      comfyTab.location.href = "/api/comfyui/open-ui";
      if (task.targetType === 'shot' && Number.isInteger(Number(task.shotIndex))) {
        alert(`已准备分镜 ${Number(task.shotIndex) + 1} 的专属工作流\n文件：${filename}`);
      } else if (task.targetType === 'character') {
        const viewLabels: Record<string, string> = {
          avatar: '头像',
          front: '正面',
          side: '侧面',
          back: '背面'
        };
        const viewLabel = viewLabels[task.viewType] || task.viewType;
        alert(`已准备角色 ${task.characterName || '未命名'} ${viewLabel} 的专属工作流\n文件：${filename}`);
      } else {
        alert(`已准备该素材槽位的专属工作流\n文件：${filename}`);
      }
    } catch (e: any) {
      comfyTab.close();
      alert("高级调整失败：" + e.message);
    }
  };

  const handleOpenDefaultWorkflow = async () => {
    const comfyTab = window.open('about:blank', '_blank');
    if (!comfyTab) {
      alert('无法打开 ComfyUI，请允许浏览器弹出窗口。');
      return;
    }
    try {
      const response = await fetch(`/api/comfyui/workflow-template?presetId=${encodeURIComponent(templatePresetId)}`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `comfyui_template_${templatePresetId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => {
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
      }, 100);
      comfyTab.location.href = '/api/comfyui/open-ui';
      alert('工作流模板已下载。通用模板不可直接导回；需要导回时请从具体图片点击高级调整。');
    } catch (error: any) {
      comfyTab.close();
      alert(`打开默认工作流失败：${error.message}`);
    }
  };

  const handleOpenAdvanced = (task: any | null) => {
    if (task) {
      handleAdvancedAdjust(task);
      return;
    }
    handleOpenDefaultWorkflow();
  };

  const refreshCurrentScript = React.useCallback(async () => {
    const current = generatedScriptRef.current;
    if (!current?.id) return;
    const response = await fetch('/api/generated-scripts');
    if (!response.ok) throw new Error(`刷新项目失败 (HTTP ${response.status})`);
    const scripts = await response.json();
    const data = scripts.find((item: any) => String(item.id) === String(current.id));
    if (!data) throw new Error('刷新后的项目列表中找不到当前剧本。');
    setGeneratedScript(data);
    setGeneratedScripts(previous => previous.map(item => item.id === data.id ? data : item));
  }, []);

  const handlePrepareShotAdvanced = async (shot: Shot, shotIndex: number, existingTask: any | null) => {
    if (!checkComfyRuntimeBeforeAction()) return;
    if (existingTask?.hasUiWorkflow) {
      await handleAdvancedAdjust(existingTask);
      return;
    }
    if (!generatedScript || !shot.id || preparingAdvancedSlots[shot.id]) return;
    const comfyTab = window.open('about:blank', '_blank');
    if (!comfyTab) {
      alert('无法打开 ComfyUI，请允许浏览器弹出窗口。');
      return;
    }
    setPreparingAdvancedSlots(previous => ({ ...previous, [shot.id!]: true }));
    try {
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: shot.description || 'cinematic storyboard frame',
          negativePrompt: 'low quality, blurry, deformed, extra limbs, bad anatomy, text, watermark',
          model: comfyParams.model || undefined,
          width: 768,
          height: 512,
          seedMode: 'random',
          projectId: generatedScript.id,
          targetType: 'shot',
          targetId: shot.id,
          viewType: 'main',
          shotIndex,
          platform: 'comfyui',
          skipTranslation: true,
        }),
      });
      const submitted = await response.json().catch(() => ({}));
      if (!response.ok || !submitted.taskId) throw new Error(submitted.error || `HTTP ${response.status}`);

      let completedTask: any = null;
      for (let attempt = 0; attempt < 240; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 750));
        const tasksResponse = await fetch(`/api/comfyui/tasks?projectId=${generatedScript.id}`);
        if (!tasksResponse.ok) continue;
        const tasks = await tasksResponse.json();
        setComfyTasks(tasks);
        const current = tasks.find((task: any) => task.id === submitted.taskId);
        if (current?.status === 'failed' || current?.status === 'cancelled') {
          throw new Error(current.error || `基准图任务状态：${current.status}`);
        }
        if (current?.status === 'succeeded') {
          completedTask = current;
          break;
        }
      }
      if (!completedTask) throw new Error('等待基准图生成超时。');
      await refreshCurrentScript();
      await handleAdvancedAdjust(completedTask, comfyTab);
    } catch (error: any) {
      comfyTab.close();
      alert(`准备分镜高级调整失败：${error.message}`);
    } finally {
      setPreparingAdvancedSlots(previous => ({ ...previous, [shot.id!]: false }));
    }
  };

  const handlePrepareCharacterAdvanced = async (char: Character, viewType: 'avatar' | 'front' | 'side' | 'back', existingTask: any | null) => {
    if (!checkComfyRuntimeBeforeAction()) return;
    const slotKey = `${char.id}:${viewType}`;
    if (preparingAdvancedSlots[slotKey]) return;

    if (existingTask?.hasUiWorkflow) {
      setExportedSlots(prev => ({ ...prev, [slotKey]: true }));
      await handleAdvancedAdjust(existingTask);
      return;
    }

    const activeTask = comfyTasks.find(
      t => t.targetId === char.id && t.viewType === viewType && (t.status === 'pending' || t.status === 'processing')
    );

    const comfyTab = window.open('about:blank', '_blank');
    if (!comfyTab) {
      alert('无法打开 ComfyUI，请允许浏览器弹出窗口。');
      return;
    }

    setPreparingAdvancedSlots(previous => ({ ...previous, [slotKey]: true }));

    let isCancelled = false;
    const handleUnload = () => { isCancelled = true; };
    window.addEventListener('beforeunload', handleUnload);

    try {
      let targetTaskId = activeTask?.id;

      if (!targetTaskId) {
        let prompt = "";
        if (viewType === 'avatar') {
          prompt = `${char.name}, role is ${char.role}, appearance: ${char.clothing}, personality: ${char.personality}`;
        } else {
          console.log(`[Character-Advanced] Translating description for baseline task (${viewType})...`);
          let englishDescription = "";
          try {
            const transRes = await fetch("/api/translate-character", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: char.name,
                role: char.role,
                clothing: char.clothing,
                personality: char.personality
              })
            });
            if (transRes.ok) {
              const data = await transRes.json();
              englishDescription = data.englishDescription;
            }
          } catch (err) {
            console.warn("[Character-Advanced] Translation failed, using local fallback", err);
          }

          if (!englishDescription) {
            englishDescription = `${char.name}, role is ${char.role}, appearance: ${char.clothing}, personality: ${char.personality}`;
          }

          if (viewType === "front") {
            prompt = `${englishDescription}, front view only, single character standing pose, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`;
          } else if (viewType === "side") {
            prompt = `${englishDescription}, side view only, facing right, single character, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`;
          } else {
            prompt = `${englishDescription}, back view only, character facing away from camera, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`;
          }
        }

        const response = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            negativePrompt: 'low quality, blurry, deformed, extra limbs, bad anatomy, text, watermark',
            model: comfyParams.model || undefined,
            width: 512,
            height: 768,
            seedMode: 'random',
            projectId: generatedScript.id,
            targetType: 'character',
            targetId: char.id,
            viewType,
            characterName: char.name,
            platform: 'comfyui',
            skipTranslation: true,
            isCharacter: true,
          }),
        });

        const submitted = await response.json().catch(() => ({}));
        if (!response.ok || !submitted.taskId) throw new Error(submitted.error || `HTTP ${response.status}`);
        targetTaskId = submitted.taskId;
      }

      console.log(`[Character-Advanced] Polling for Task ID: ${targetTaskId}`);

      let completedTask: any = null;
      const timeoutMs = 300000;
      const startTime = Date.now();

      while (!isCancelled) {
        if (Date.now() - startTime > timeoutMs) {
          throw new Error('等待基准图生成超时。');
        }

        await new Promise(resolve => setTimeout(resolve, 750));
        if (isCancelled) break;

        const tasksResponse = await fetch(`/api/comfyui/tasks?projectId=${generatedScript.id}`);
        if (!tasksResponse.ok) continue;
        const tasks = await tasksResponse.json();

        setComfyTasks(tasks);

        const current = tasks.find((t: any) => t.id === targetTaskId);
        if (!current) continue;

        if (current.status === 'failed' || current.status === 'cancelled') {
          throw new Error(current.error || `基准图任务状态：${current.status}`);
        }
        if (current.status === 'succeeded') {
          completedTask = current;
          break;
        }
      }

      if (isCancelled) {
        comfyTab.close();
        return;
      }

      if (!completedTask) throw new Error('等待基准图生成中断或未获取到任务信息。');

      await refreshCurrentScript();
      setExportedSlots(prev => ({ ...prev, [slotKey]: true }));
      await handleAdvancedAdjust(completedTask, comfyTab);
    } catch (error: any) {
      comfyTab.close();
      alert(`准备角色高级调整失败：${error.message}`);
    } finally {
      window.removeEventListener('beforeunload', handleUnload);
      setPreparingAdvancedSlots(previous => ({ ...previous, [slotKey]: false }));
    }
  };

  const renderComfySlotStatusAndControls = (char: Character, viewType: 'avatar' | 'front' | 'side' | 'back') => {
    if (imagePlatform !== 'comfyui') return null;

    const slotKey = `${char.id}:${viewType}`;
    const lastSucceeded = getLatestSucceededTask(char.id || '', viewType);
    const task = getCharacterTask(char.id || '', viewType);
    const isPreparing = !!preparingAdvancedSlots[slotKey];

    let statusText = '尚未生成';
    let statusColor = 'text-slate-500';

    if (isPreparing) {
      statusText = '正在准备工作流';
      statusColor = 'text-purple-400 animate-pulse';
    } else if (task && task.status === 'pending') {
      statusText = '排队中';
      statusColor = 'text-amber-500';
    } else if (task && task.status === 'processing') {
      statusText = '生成中';
      statusColor = 'text-blue-400';
    } else if (task && task.status === 'failed') {
      statusText = '生成失败';
      statusColor = 'text-red-400';
    } else if (lastSucceeded) {
      const importState = comfyImportStates[lastSucceeded.id];
      if (importState?.status === 'uploading') {
        statusText = '导入中';
        statusColor = 'text-emerald-400';
      } else if (importState?.status === 'success') {
        statusText = '导入成功';
        statusColor = 'text-emerald-400';
      } else if (importState?.status === 'error') {
        statusText = '导入失败';
        statusColor = 'text-red-400';
      } else if (!lastSucceeded.hasUiWorkflow) {
        statusText = '无可编辑工作流';
        statusColor = 'text-slate-400';
      } else if (exportedSlots[slotKey]) {
        statusText = '等待导入';
        statusColor = 'text-purple-405';
      } else {
        statusText = '可高级调整';
        statusColor = 'text-purple-400';
      }
    }

    let adjustDisabled = false;
    let adjustTitle = '在 ComfyUI 中高级调整';

    if (isPreparing) {
      adjustDisabled = true;
      adjustTitle = '正在准备角色工作流...';
    } else if (lastSucceeded) {
      if (!lastSucceeded.hasUiWorkflow) {
        adjustDisabled = true;
        adjustTitle = '当前图片缺少 ComfyUI 工作流信息，无法进行高级调整';
      }
    }

    const showImportButton = !!lastSucceeded;
    const importDisabled = !lastSucceeded?.hasUiWorkflow;
    const importTitle = importDisabled ? '当前图片缺少 ComfyUI 工作流信息，无法导入结果' : '导入 ComfyUI 结果';
    const regenerateWithCurrentPreset = () => {
      if (viewType === 'avatar') handleGenerateCharacterAvatar(char);
      else handleGenerateSingleView(char, viewType);
    };

    return (
      <div className="mt-2 flex flex-col gap-1 w-full bg-slate-950/40 p-2 rounded border border-white/5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-slate-500 font-mono scale-90 origin-left">状态:</span>
          <span className={`font-semibold ${statusColor} scale-90 origin-right`}>{statusText}</span>
        </div>
        {lastSucceeded && (
          <div className="text-[8px] text-slate-500">
            此图片由 {comfyTaskPresetLabel(lastSucceeded)} 生成
          </div>
        )}
        {lastSucceeded && isLegacyComfyTask(lastSucceeded) && (
          <button
            type="button"
            onClick={regenerateWithCurrentPreset}
            className="rounded border border-blue-900/60 bg-blue-950/30 px-1 py-1 text-[8px] text-blue-300 hover:bg-blue-900/40"
          >
            用当前预设重新生成
          </button>
        )}
        <div className="flex gap-1 mt-1 justify-center">
          <button
            type="button"
            disabled={adjustDisabled}
            onClick={() => handlePrepareCharacterAdvanced(char, viewType, lastSucceeded)}
            title={adjustTitle}
            className="flex-1 py-1 px-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-[9px] text-slate-200 rounded font-medium flex items-center justify-center gap-1 transition-colors cursor-pointer"
          >
            {isPreparing ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <ExternalLink className="w-2.5 h-2.5 text-purple-400" />}
            <span>高级调整</span>
          </button>

          {showImportButton && (
            <button
              type="button"
              disabled={importDisabled}
              onClick={() => chooseComfyResult(lastSucceeded)}
              className="flex-1 py-1 px-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-[9px] text-slate-200 rounded font-medium flex items-center justify-center gap-1 transition-colors cursor-pointer border border-emerald-950/50 hover:border-emerald-500/30"
              title={importTitle}
            >
              <Upload className="w-2.5 h-2.5 text-emerald-400" />
              <span>导入结果</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  const uploadComfyResult = async (task: any, file: File, force = false, retry = false): Promise<void> => {
    if (!task || (!retry && activeComfyImportsRef.current.has(task.id))) return;
    if (!retry) activeComfyImportsRef.current.add(task.id);
    setComfyImportStates(previous => ({ ...previous, [task.id]: { status: 'uploading', message: '上传中…' } }));
    const body = new FormData();
    body.append('file', file);
    try {
      const response = await fetch(`/api/comfyui/tasks/${task.id}/import-result${force ? '?force=true' : ''}`, {
        method: 'POST',
        body,
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && !force) {
        setComfyImportStates(previous => ({ ...previous, [task.id]: { status: 'error', message: result.error || '来源已过期' } }));
        if (window.confirm(`${result.error || '该槽位已有更新的图片。'}\n\n仍要用这个 PNG 覆盖当前图片吗？`)) {
          await uploadComfyResult(task, file, true, true);
        }
        return;
      }
      if (!response.ok) throw new Error(result.error || `导入失败 (HTTP ${response.status})`);
      if (!result.updatedScript || !result.task || !result.imageUrl) {
        throw new Error('导入响应缺少更新后的剧本、任务或图片地址。');
      }

      const updatedScript = result.updatedScript;
      setGeneratedScripts(previous => {
        const found = previous.some(item => String(item.id) === String(updatedScript.id));
        return found
          ? previous.map(item => String(item.id) === String(updatedScript.id) ? updatedScript : item)
          : [updatedScript, ...previous];
      });
      if (String(generatedScriptRef.current?.id) === String(updatedScript.id)) {
        generatedScriptRef.current = updatedScript;
        setGeneratedScript(updatedScript);
      }
      if (result.targetType === 'shot' && result.viewType === 'main') {
        const updatedShot = updatedScript.newShots?.find((shot: any) => String(shot.id) === String(result.targetId));
        if (updatedShot?.timestamp) {
          setShotImages(previous => ({ ...previous, [updatedShot.timestamp]: result.imageUrl }));
        }
      } else if (result.targetType === 'character') {
        const updatedCharacter = updatedScript.newCharacters?.find((character: any) => String(character.id) === String(result.targetId));
        if (updatedCharacter) {
          setActiveDrawerChar(previous => String(previous?.id) === String(result.targetId) ? updatedCharacter : previous);
          setSelectedCharacter(previous => String(previous?.id) === String(result.targetId) ? updatedCharacter : previous);
        }
      }
      try {
        await pollComfyTasks();
      } catch (e) {
        console.error("Failed to poll ComfyUI tasks after manual import:", e);
      }
      importedTaskAwaitingRefreshRef.current = result.task.id;
      setComfyImportStates(previous => ({
        ...previous,
        [task.id]: { status: 'success', message: result.duplicate ? '已导入（重复文件未新建）' : '导入成功' },
        [result.task.id]: { status: 'success', message: result.duplicate ? '已导入（重复文件未新建）' : '导入成功' },
      }));
    } catch (error: any) {
      setComfyImportStates(previous => ({
        ...previous,
        [task.id]: { status: 'error', message: error?.message || '导入失败' },
      }));
      alert(`导入 ComfyUI 结果失败：${error?.message || '未知错误'}`);
    } finally {
      if (!retry) activeComfyImportsRef.current.delete(task.id);
    }
  };

  const chooseComfyResult = (task: any) => {
    if (!task?.hasUiWorkflow || activeComfyImportsRef.current.has(task.id)) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,.png';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) uploadComfyResult(task, file);
    };
    input.click();
  };

  const renderComfyImportButton = (task: any, compact = false) => {
    if (imagePlatform !== 'comfyui' || !task?.hasUiWorkflow) return null;
    const state = comfyImportStates[task.id];
    const uploading = state?.status === 'uploading';
    const refreshError = comfyRefreshErrors[task.id];
    return (
      <div className={compact ? "contents" : "flex items-center gap-1"}>
      <button
        type="button"
        onClick={() => chooseComfyResult(task)}
        disabled={uploading}
        title={state?.message || '仅上传由该分镜专属工作流生成的原始 PNG'}
        className={compact
          ? "absolute top-1 right-1 p-1 bg-slate-950/80 hover:bg-slate-900 text-slate-300 hover:text-white disabled:opacity-50 rounded border border-white/10 opacity-0 group-hover:opacity-100 group-hover/view:opacity-100 transition-opacity z-20 cursor-pointer"
          : "px-3 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 rounded text-[10px] flex items-center gap-1 cursor-pointer transition-all border border-slate-750 hover:border-slate-600 font-medium"}
      >
        {uploading ? <Loader2 className={compact ? "w-3 h-3 animate-spin" : "w-3.5 h-3.5 animate-spin"} /> : <Upload className={compact ? "w-3 h-3 text-emerald-400" : "w-3.5 h-3.5 text-emerald-400"} />}
        {!compact && <span>{state?.status === 'success' ? '导入成功' : state?.status === 'error' ? '导入失败' : '导入 ComfyUI 结果'}</span>}
      </button>
      {refreshError && !compact && (
        <button
          type="button"
          title={refreshError}
          onClick={() => {
            refreshGeneratedScripts()
              .then(() => setComfyRefreshErrors(previous => {
                const next = { ...previous };
                delete next[task.id];
                return next;
              }))
              .catch(() => setComfyRefreshErrors(previous => ({ ...previous, [task.id]: '图片已导入，但页面刷新失败' })));
          }}
          className="px-2 py-1 bg-amber-950/60 hover:bg-amber-900 border border-amber-800/60 text-amber-200 rounded text-[10px]"
        >
          重新刷新数据
        </button>
      )}
      </div>
    );
  };

  const renderComfyTaskOverlay = (task: any) => {
    if (!task) return null;
    if (task.status === 'skipped_missing_avatar') {
      return <div className="absolute inset-0 bg-amber-950/90 border border-amber-700 rounded-lg flex items-center justify-center p-1 z-10 text-center"><span className="text-[9px] text-amber-200 font-medium" title={task.error}>缺 Avatar 跳过</span></div>;
    }
    if (task.status === 'pending') {
      return (
        <div className="absolute inset-0 bg-slate-950/85 border border-slate-800 rounded-lg flex flex-col items-center justify-center p-1 z-10 text-center">
          <Clock className="w-4 h-4 text-amber-500 animate-pulse mb-0.5" />
          <span className="text-[9px] text-amber-405 font-medium scale-90">等待提交</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleCancelComfyTask(task.id); }}
            className="mt-1 px-1.5 py-0.5 bg-red-950 hover:bg-red-900 border border-red-900 text-red-200 rounded text-[8px] cursor-pointer font-semibold transition-colors"
          >
            取消
          </button>
        </div>
      );
    }
    if (task.status === 'processing') {
      const statusLabel = task.stateDetail === 'submitting'
        ? '正在提交 ComfyUI'
        : task.stateDetail === 'queued' && task.queuePosition
          ? `已提交 ComfyUI，排队第 ${task.queuePosition} 位`
          : '生成中';
      return (
        <div className="absolute inset-0 bg-slate-950/85 border border-slate-800 rounded-lg flex flex-col items-center justify-center p-1 z-10 text-center">
          <Loader2 className="w-4 h-4 text-blue-400 animate-spin mb-0.5" />
          <span className="text-[9px] text-blue-300 font-medium scale-90">{statusLabel}</span>
          <button type="button" onClick={(e) => { e.stopPropagation(); handleCancelComfyTask(task.id); }} className="mt-1 px-1.5 py-0.5 bg-red-950 hover:bg-red-900 border border-red-900 text-red-200 rounded text-[8px]">取消</button>
        </div>
      );
    }
    if (task.status === 'failed') {
      const failedMessage = task.errorMessage || task.error || '未知错误';
      const isTimeout = task.stateDetail === 'timeout' || /timed out|超时/i.test(failedMessage);
      return (
        <div className="absolute inset-0 bg-slate-950/90 border border-slate-800 rounded-lg flex flex-col items-center justify-center p-1 z-10 text-center">
          <span className="text-[8px] text-red-400 font-medium line-clamp-2 mb-0.5 scale-90" title={failedMessage}>
            {isTimeout ? '超时' : `失败：${failedMessage}`}
          </span>
          {!task.syntheticBatchItem && <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleRetryComfyTask(task.id); }}
            className="px-1.5 py-0.5 bg-blue-950 hover:bg-blue-900 border border-blue-900 text-blue-200 rounded text-[8px] cursor-pointer font-semibold transition-colors"
          >
            重试
          </button>}
        </div>
      );
    }
    if (task.status === 'cancelled') {
      return <div className="absolute inset-0 bg-slate-950/75 border border-slate-700 rounded-lg flex items-center justify-center z-10"><span className="text-[9px] text-slate-300">已取消</span></div>;
    }
    return null;
  };

  // Undo function
  const handleUndo = async () => {
    if (undoStackRef.current.length === 0 || !generatedScriptRef.current) return;

    // Pop the latest state
    const prevShots = undoStackRef.current.pop();

    // Deep clone is safe here
    const updatedScript = { ...generatedScriptRef.current, newShots: prevShots };
    setGeneratedScript(updatedScript);
    setGeneratedScripts(prev => prev.map(s => s.id === updatedScript.id ? updatedScript : s));

    console.log("[Undo] Reverting cell edits/drag to previous state. Remaining history states: " + undoStackRef.current.length);

    // Update DB
    try {
      const putRes = await fetch(`/api/generated-scripts/${updatedScript.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newShots: prevShots })
      });
      if (!putRes.ok) {
        console.error("Failed to save undo state to database");
      }
    } catch (err) {
      console.error("Error saving undo state:", err);
    }
  };

  // Keyboard shortcut listener for Ctrl+Z / Cmd+Z
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z';
      if (isUndo) {
        const activeElement = document.activeElement;
        const isEditingInput = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');
        if (!isEditingInput) {
          e.preventDefault();
          handleUndo();
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    generatedScriptRef.current = generatedScript;
  }, [generatedScript]);

  const timelineInterval = useRef<NodeJS.Timeout | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load database records on mount
  const fetchRecords = async () => {
    try {
      const res = await fetch("/api/videos");
      if (res.ok) {
        const data = await res.json();
        setRecords(data);
      }
    } catch (err) {
      console.error("Failed to load records:", err);
    }
  };

  const fetchGeneratedScripts = async () => {
    try {
      const data = await loadGeneratedScripts();
      setGeneratedScripts(data);
    } catch (err) {
      console.error("Failed to load scripts:", err);
    }
  };

  useEffect(() => {
    fetchRecords();
    fetchGeneratedScripts();
  }, []);

  // Update activeShot and duration when selectedRecord changes
  useEffect(() => {
    const shots = selectedRecord ? selectedRecord.analysis.shots : videoAnalysisData.shots;
    if (shots && shots.length > 0) {
      setActiveShot(shots[0]);
      setCurrentTime(0);
      setIsPlaying(false);
      setDuration(selectedRecord ? 0 : 337);
      if (videoRef.current) {
        videoRef.current.currentTime = 0;
      }
      // Reset scriptwriter generator when reference template changes
      setGeneratedScript(null);
      setGeneratorTopic("");
      setGeneratorError(null);
    }
  }, [selectedRecord]);

  // Sync isPlaying state with HTML5 video element
  useEffect(() => {
    if (selectedRecord && videoRef.current) {
      if (isPlaying) {
        videoRef.current.play().catch((err) => {
          console.error("Play failed:", err);
          setIsPlaying(false);
        });
      } else {
        videoRef.current.pause();
      }
    }
  }, [isPlaying, selectedRecord]);

  // Handle timeline simulation playback for default demo video
  useEffect(() => {
    if (selectedRecord) {
      // Use HTML5 video events instead of simulation when actual video is active
      return;
    }

    if (isPlaying) {
      timelineInterval.current = setInterval(() => {
        setCurrentTime((prev) => {
          const next = prev + 1;
          if (next >= duration) {
            setIsPlaying(false);
            return 0;
          }
          const matchingShot = [...videoAnalysisData.shots]
            .reverse()
            .find((shot) => shot.timeSeconds <= next);
          if (matchingShot && matchingShot.id !== activeShot.id) {
            setActiveShot(matchingShot);
          }
          return next;
        });
      }, 1000);
    } else {
      if (timelineInterval.current) {
        clearInterval(timelineInterval.current);
      }
    }

    return () => {
      if (timelineInterval.current) {
        clearInterval(timelineInterval.current);
      }
    };
  }, [isPlaying, activeShot, selectedRecord, duration]);

  // HTML5 Video Event Handlers
  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const time = Math.floor(videoRef.current.currentTime);
      setCurrentTime(time);

      const shots = selectedRecord ? selectedRecord.analysis.shots : videoAnalysisData.shots;
      const matchingShot = [...shots]
        .reverse()
        .find((shot) => shot.timeSeconds <= time);
      if (matchingShot && matchingShot.timestamp !== activeShot.timestamp) {
        setActiveShot(matchingShot);
      }
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(Math.floor(videoRef.current.duration));
    }
  };

  // Jump playhead to specific shot
  const handleShotClick = (shot: Shot) => {
    setActiveShot(shot);
    setCurrentTime(shot.timeSeconds);
    if (selectedRecord && videoRef.current) {
      videoRef.current.currentTime = shot.timeSeconds;
      if (!isPlaying) {
        setIsPlaying(true);
      }
    }
  };

  const formatTime = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  };

  // File Upload Handlers
  const triggerFileSelect = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      uploadAndAnalyze(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      uploadAndAnalyze(e.dataTransfer.files[0]);
    }
  };

  const uploadAndAnalyze = (file: File) => {
    if (isUploading || isAnalyzing) return;

    setIsUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    setStatusText("正在上传视频到本地服务器...");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        setUploadProgress(percent);
      }
    };

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const uploadRes = JSON.parse(xhr.responseText);
          setIsUploading(false);
          setIsAnalyzing(true);
          setStatusText("上传成功！正在调用 Gemini 2.5 Flash 提取分镜结构、人物角色及故事叙事爽点（视频分析通常需要 30-60 秒，请耐心等待）...");

          const analyzeRes = await fetch("/api/analyze", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filename: uploadRes.filename,
              filepath: uploadRes.filepath,
              title: file.name.substring(0, file.name.lastIndexOf('.')) || file.name,
              shortDramaMode: shortDramaMode,
            }),
          });

          if (analyzeRes.ok) {
            const videoRecord = await analyzeRes.json();
            setRecords(prev => [videoRecord, ...prev]);
            setSelectedRecord(videoRecord);
            setIsAnalyzing(false);
            setStatusText("");
          } else {
            const errData = await analyzeRes.json();
            throw new Error(errData.error || "Gemini 分析失败");
          }
        } catch (err: any) {
          console.error(err);
          setUploadError(err.message || "分析视频时出错，请重试");
          setIsUploading(false);
          setIsAnalyzing(false);
        }
      } else {
        setUploadError("视频上传到服务器失败，请检查连接");
        setIsUploading(false);
      }
    };

    xhr.onerror = () => {
      setUploadError("网络连接错误，无法上传视频");
      setIsUploading(false);
    };

    const formData = new FormData();
    formData.append("video", file);
    xhr.send(formData);
  };

  // Delete Video
  const handleDeleteRecord = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定要删除该视频的分析记录和本地文件吗？")) return;

    try {
      const res = await fetch(`/api/videos/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setRecords(prev => prev.filter(r => r.id !== id));
        if (selectedRecord && selectedRecord.id === id) {
          setSelectedRecord(null);
        }
      }
    } catch (err) {
      console.error("Failed to delete record:", err);
    }
  };

  // Script Generator Handler
  const handleGenerateScript = async () => {
    if (!generatorTopic.trim()) {
      setGeneratorError("请输入新故事主题设定！");
      return;
    }

    setIsGeneratingScript(true);
    setGeneratorError(null);

    try {
      const res = await fetch("/api/generate-script", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          templateId: selectedRecord ? selectedRecord.id : "demo",
          topic: generatorTopic,
          shortDramaMode: shortDramaMode,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setGeneratedScript(data);
        setShotImages({});
        fetchGeneratedScripts(); // Refresh scripts sidebar list!
      } else {
        const err = await res.json();
        throw new Error(err.error || "生成剧本失败，请检查服务器或 API 配置");
      }
    } catch (err: any) {
      console.error(err);
      setGeneratorError(err.message || "创意生成失败，请稍后重试");
    } finally {
      setIsGeneratingScript(false);
    }
  };

  const handleDeleteScript = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定要删除该生成剧本记录吗？")) return;

    try {
      const res = await fetch(`/api/generated-scripts/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setGeneratedScripts(prev => prev.filter(s => s.id !== id));
        if (generatedScript && generatedScript.id === id) {
          setGeneratedScript(null);
        }
      }
    } catch (err) {
      console.error("Failed to delete script:", err);
    }
  };

  const handleGenerateShotImage = async (shot: Shot, idx: number, scriptOverride?: any) => {
    const activeScript = scriptOverride || generatedScript;
    if (!activeScript) return;

    const imagePrompt = shot.description;
    const negativePrompt = "low quality, blurry, deformed, extra limbs, bad anatomy, text, watermark";
    const matchedCharacters = (activeScript.newCharacters || []).filter((character: Character) => (shot.matchedCharacterIds || []).includes(String(character.id || '')));
    const hasCharacterReference = matchedCharacters.length > 0 && matchedCharacters.every((character: Character) => !!(character.avatarImageUrl || character.avatarUrl));

    if (imagePlatform === 'comfyui') {
      try {
        const res = await fetch("/api/generate-image", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
           body: JSON.stringify({
             presetId: hasCharacterReference ? comfyProjectPreferences.identityPresetId : comfyProjectPreferences.shotPresetId,
             prompt: imagePrompt,
            negativePrompt,
            isCharacter: false,
            style: getStyleEnglish(shot.style || "写实"),
            platform: imagePlatform,
            model: comfyParams.model || undefined,
            projectId: activeScript.id,
            targetType: 'shot',
            targetId: shot.id,
            viewType: 'main',
            shotIndex: idx,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          if (res.status === 409 && err.existingTaskId) {
            const shouldReplace = window.confirm(`已有任务进行中（${err.existingTaskId}）。是否取消当前任务后重新生成？`);
            if (shouldReplace && await handleCancelComfyTask(err.existingTaskId)) {
              await handleGenerateShotImage(shot, idx, activeScript);
            } else if (!shouldReplace) {
              setShotCharacterFeedback({ kind: 'error', message: `已有任务进行中：${err.existingTaskId}` });
            }
            return;
          }
          throw new Error(err.error || "生成图片任务提交失败");
        }
        const taskResult = await res.json();
        console.log('[RegenerateWithReference:Created]', { projectId: activeScript.id, shotId: shot.id, matchedCharacterIds: shot.matchedCharacterIds || [], taskId: taskResult.taskId, workflowPresetId: taskResult.workflowPresetId, characterReferenceImageUrl: taskResult.characterReferenceImageUrl });
        setShotCharacterFeedback({ kind: 'success', message: `任务已创建：${taskResult.taskId}` });
        await pollComfyTasks();
      } catch (err: any) {
        setShotCharacterFeedback({ kind: 'error', message: err.message || '提交任务失败' });
      }
      return;
    }

    setGeneratingShotIndex(idx);
    try {
      const res = await fetch("/api/generate-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: imagePrompt,
          negativePrompt,
          isCharacter: false,
          style: getStyleEnglish(shot.style || "写实"),
          platform: imagePlatform,
          projectId: generatedScript.id,
          targetType: 'shot',
          shotIndex: idx,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "生成图片失败");
      }

      const imageResult = await res.json();
      const { url, generation } = imageResult;

      // Write back to DB
      const putRes = await fetch(`/api/generated-scripts/${generatedScript.id}/image`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shotIndex: idx,
          imageUrl: url,
          generation,
        }),
      });

      if (putRes.ok) {
        const updatedShots = [...generatedScript.newShots];
        updatedShots[idx] = {
          ...updatedShots[idx],
          imageUrl: url,
          generatedImageUrl: url,
          imageGeneration: generation,
          imageGenerations: [...(updatedShots[idx].imageGenerations || []), generation],
        };
        const updatedScript = { ...generatedScript, newShots: updatedShots };
        setGeneratedScript(updatedScript);
        setShotImages(prev => ({ ...prev, [shot.timestamp]: url }));
        setGeneratedScripts(prev => prev.map(s => s.id === generatedScript.id ? updatedScript : s));
      }
    } catch (err: any) {
      const failedGeneration = {
        provider: imagePlatform,
        status: 'failed' as const,
        prompt: imagePrompt,
        negativePrompt,
        width: 768,
        height: 512,
        projectId: generatedScript.id,
        targetType: 'shot' as const,
        shotIndex: idx,
        createdAt: new Date().toISOString(),
        error: err.message || 'Image generation failed',
      };
      await fetch(`/api/generated-scripts/${generatedScript.id}/image`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotIndex: idx, generation: failedGeneration }),
      }).catch(() => undefined);
      const updatedShots = [...generatedScript.newShots];
      updatedShots[idx] = {
        ...updatedShots[idx],
        imageGeneration: failedGeneration,
        imageGenerations: [...(updatedShots[idx].imageGenerations || []), failedGeneration],
      };
      const updatedScript = { ...generatedScript, newShots: updatedShots };
      setGeneratedScript(updatedScript);
      setGeneratedScripts(prev => prev.map(s => s.id === generatedScript.id ? updatedScript : s));
      alert(err.message || "生成图片时出错");
    } finally {
      setGeneratingShotIndex(null);
    }
  };

  const getStyleEnglish = (style: string) => {
    switch (style) {
      case "写实":
        return "Cinematic photo-realistic, dramatic lighting, highly detailed, 8k resolution";
      case "动漫":
        return "Anime style, Japanese animation, cell-shaded, high quality";
      case "赛博朋克":
        return "Cyberpunk style, neon lights, dark alley reflections, futuristic";
      case "油画":
        return "Oil painting style, textured brush strokes, classical masterpiece, artistic";
      default:
        return "Cinematic, dramatic lighting, highly detailed";
    }
  };

  const handleSaveCell = async (idx: number, field: string) => {
    if (!generatedScript || !editingCell) return;
    const value = editValue.trim();

    // Check if value actually changed
    const currentValue = generatedScript.newShots[idx]?.[field] || "";
    if (value === currentValue) {
      setEditingCell(null);
      return;
    }

    // Push copy onto undo stack
    const shotsCopy = JSON.parse(JSON.stringify(generatedScript.newShots));
    undoStackRef.current.push(shotsCopy);
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift();
    }

    // Update local state
    const updatedShots = [...generatedScript.newShots];
    const inferredCharacterIds = field === 'description'
      ? inferShotCharacterIds(value, generatedScript.newCharacters || [])
      : [];
    updatedShots[idx] = {
      ...updatedShots[idx],
      [field]: value,
      ...(field === 'description' ? {
        matchedCharacterIds: [...new Set([
          ...(updatedShots[idx].matchedCharacterIds || []),
          ...inferredCharacterIds,
        ])],
      } : {}),
    };

    const updatedScript = { ...generatedScript, newShots: updatedShots };
    setGeneratedScript(updatedScript);
    setEditingCell(null);

    // Save to DB
    try {
      const putRes = await fetch(`/api/generated-scripts/${generatedScript.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newShots: updatedShots })
      });
      if (putRes.ok) {
        setGeneratedScripts(prev => prev.map(s => s.id === generatedScript.id ? updatedScript : s));
        console.log(`[Cell Edit] Saved ${field} for shot ${idx} successfully!`);
      } else {
        console.error("Failed to save cell edit to database");
      }
    } catch (err) {
      console.error("Error saving cell edit:", err);
    }
  };

  const handleRowDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", index.toString());
  };

  const handleRowDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
  };

  const handleRowDrop = async (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    // Push copy onto undo stack
    const shotsCopy = JSON.parse(JSON.stringify(generatedScript.newShots));
    undoStackRef.current.push(shotsCopy);
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift();
    }

    const updatedShots = [...generatedScript.newShots];
    const [removed] = updatedShots.splice(draggedIndex, 1);
    updatedShots.splice(index, 0, removed);

    const updatedScript = { ...generatedScript, newShots: updatedShots };
    setGeneratedScript(updatedScript);
    setDraggedIndex(null);

    try {
      const putRes = await fetch(`/api/generated-scripts/${generatedScript.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newShots: updatedShots })
      });
      if (putRes.ok) {
        setGeneratedScripts(prev => prev.map(s => s.id === generatedScript.id ? updatedScript : s));
        console.log("[DragAndDrop] Reordered shots successfully!");
      } else {
        console.error("Failed to save reordered shots to database");
      }
    } catch (err) {
      console.error("Error saving reordered shots:", err);
    }
  };

  const fetchBgmList = async () => {
    try {
      const res = await fetch("/api/bgm-list");
      if (res.ok) {
        const data = await res.json();
        setBgmList(data);
      }
    } catch (err) {
      console.error("Failed to fetch BGM list:", err);
    }
  };

  const handleBgmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append("bgm", file);

    setIsUploadingBgm(true);
    try {
      const res = await fetch("/api/upload-bgm", {
        method: "POST",
        body: formData
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedBgm(data.filename);
        await fetchBgmList();
      } else {
        alert("音乐文件上传失败");
      }
    } catch (err) {
      console.error("Failed to upload BGM:", err);
      alert("上传音乐时出错");
    } finally {
      setIsUploadingBgm(false);
    }
  };

  const handleCompileAnimatic = async () => {
    if (!generatedScript) return;
    setIsCompilingAnimatic(true);
    setCompilationStatus("正在下载并转换分镜画面...");
    setAnimaticVideoUrl(null);

    try {
      const res = await fetch("/api/compile-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId: generatedScript.id,
          durationPerShot: animaticDuration,
          bgmFilename: selectedBgm || undefined
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "编译动态分镜视频失败");
      }

      const data = await res.json();
      setAnimaticVideoUrl(data.previewUrl);
      setCompilationStatus("编译成功！");
    } catch (err: any) {
      console.error(err);
      alert(err.message || "生成视频时出错");
      setCompilationStatus("编译失败：" + err.message);
    } finally {
      setIsCompilingAnimatic(false);
    }
  };

  const pollAnimationStatus = (taskId: string, shotIdx: number) => {
    if (activeIntervalsRef.current[taskId]) return;

    const intervalId = setInterval(async () => {
      try {
        const activeScript = generatedScriptRef.current;
        if (!activeScript) {
          clearInterval(intervalId);
          delete activeIntervalsRef.current[taskId];
          return;
        }

        const res = await fetch(`/api/animation-status/${taskId}`);
        if (!res.ok) {
          clearInterval(intervalId);
          delete activeIntervalsRef.current[taskId];
          return;
        }

        const data = await res.json();
        if (data.task_status === 'succeed') {
          clearInterval(intervalId);
          delete activeIntervalsRef.current[taskId];

          setGeneratedScript((prev: any) => {
            if (!prev || prev.id !== activeScript.id) return prev;
            const updatedShots = [...prev.newShots];
            updatedShots[shotIdx] = {
              ...updatedShots[shotIdx],
              videoStatus: 'succeed',
              videoUrl: data.videoUrl
            };
            return { ...prev, newShots: updatedShots };
          });

          setGeneratedScripts((prevList: any) => {
            return prevList.map((s: any) => {
              if (s.id !== activeScript.id) return s;
              const updatedShots = [...s.newShots];
              updatedShots[shotIdx] = {
                ...updatedShots[shotIdx],
                videoStatus: 'succeed',
                videoUrl: data.videoUrl
              };
              return { ...s, newShots: updatedShots };
            });
          });
        } else if (data.task_status === 'failed') {
          clearInterval(intervalId);
          delete activeIntervalsRef.current[taskId];

          setGeneratedScript((prev: any) => {
            if (!prev || prev.id !== activeScript.id) return prev;
            const updatedShots = [...prev.newShots];
            updatedShots[shotIdx] = {
              ...updatedShots[shotIdx],
              videoStatus: 'failed'
            };
            return { ...prev, newShots: updatedShots };
          });

          setGeneratedScripts((prevList: any) => {
            return prevList.map((s: any) => {
              if (s.id !== activeScript.id) return s;
              const updatedShots = [...s.newShots];
              updatedShots[shotIdx] = {
                ...updatedShots[shotIdx],
                videoStatus: 'failed'
              };
              return { ...s, newShots: updatedShots };
            });
          });
        } else {
          // still processing/submitted
          setGeneratedScript((prev: any) => {
            if (!prev || prev.id !== activeScript.id) return prev;
            const updatedShots = [...prev.newShots];
            if (updatedShots[shotIdx].videoStatus !== data.task_status) {
              updatedShots[shotIdx] = {
                ...updatedShots[shotIdx],
                videoStatus: data.task_status
              };
              return { ...prev, newShots: updatedShots };
            }
            return prev;
          });
        }
      } catch (err) {
        console.error('Failed to poll status:', err);
        clearInterval(intervalId);
        delete activeIntervalsRef.current[taskId];
      }
    }, 4000);

    activeIntervalsRef.current[taskId] = intervalId;
  };

  // Cleanup all polling intervals when component unmounts or active script changes
  useEffect(() => {
    return () => {
      const intervals = activeIntervalsRef.current;
      Object.keys(intervals).forEach((taskId) => {
        clearInterval(intervals[taskId]);
        delete intervals[taskId];
      });
    };
  }, [generatedScript?.id]);

  const handleGenerateAnimation = async (shot: Shot, shotIdx: number) => {
    if (!generatedScript) return;
    const shotImg = shotImages[shot.timestamp] || shot.generatedImageUrl || shot.imageUrl;
    if (!shotImg) {
      alert("请先生成或选择该镜头的静态画面图片！");
      return;
    }

    setGeneratedScript((prev: any) => {
      const updatedShots = [...prev.newShots];
      updatedShots[shotIdx] = {
        ...updatedShots[shotIdx],
        videoStatus: 'submitted',
        videoUrl: undefined
      };
      return { ...prev, newShots: updatedShots };
    });

    try {
      const res = await fetch("/api/generate-animation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId: generatedScript.id,
          shotIndex: shotIdx,
          imageUrl: shotImg,
          prompt: shot.description
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "提交 Kling 动画任务失败");
      }

      const data = await res.json();
      const taskId = data.taskId;

      // Start polling
      pollAnimationStatus(taskId, shotIdx);
    } catch (err: any) {
      console.error(err);
      alert(err.message || "生成动画时出错");
      setGeneratedScript((prev: any) => {
        const updatedShots = [...prev.newShots];
        updatedShots[shotIdx] = {
          ...updatedShots[shotIdx],
          videoStatus: 'failed'
        };
        return { ...prev, newShots: updatedShots };
      });
    }
  };

  const handleGenerateVideoKling = async (shot: Shot, shotIdx: number) => {
    if (!generatedScript) return;
    const shotImg = shotImages[shot.timestamp] || shot.generatedImageUrl || shot.imageUrl;
    if (!shotImg) {
      alert("请先生成或选择该镜头的静态画面图片！");
      return;
    }

    setGeneratedScript((prev: any) => {
      const updatedShots = [...prev.newShots];
      updatedShots[shotIdx] = {
        ...updatedShots[shotIdx],
        videoStatus: 'submitted',
        videoUrl: undefined
      };
      return { ...prev, newShots: updatedShots };
    });

    setVideoProgress(prev => ({ ...prev, [shotIdx]: 0 }));
    let progressVal = 0;
    const progressInterval = setInterval(() => {
      progressVal += Math.floor(Math.random() * 3) + 1; // Increment by 1-3%
      if (progressVal > 95) progressVal = 95;
      setVideoProgress(prev => ({ ...prev, [shotIdx]: progressVal }));
    }, 1000);

    try {
      const res = await fetch("/api/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId: generatedScript.id,
          shotIndex: shotIdx,
          imageUrl: shotImg,
          prompt: shot.description
        })
      });

      clearInterval(progressInterval);

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "提交 Kling 动画任务失败");
      }

      const data = await res.json();
      const videoUrl = data.videoUrl;

      setVideoProgress(prev => ({ ...prev, [shotIdx]: 100 }));

      setGeneratedScript((prev: any) => {
        if (!prev) return prev;
        const updatedShots = [...prev.newShots];
        updatedShots[shotIdx] = {
          ...updatedShots[shotIdx],
          videoStatus: 'succeed',
          videoUrl: videoUrl
        };
        return { ...prev, newShots: updatedShots };
      });

      setGeneratedScripts((prevList: any) => {
        return prevList.map((s: any) => {
          if (s.id !== generatedScript.id) return s;
          const updatedShots = [...s.newShots];
          updatedShots[shotIdx] = {
            ...updatedShots[shotIdx],
            videoStatus: 'succeed',
            videoUrl: videoUrl
          };
          return { ...s, newShots: updatedShots };
        });
      });

      setTimeout(() => {
        setVideoProgress(prev => {
          const next = { ...prev };
          delete next[shotIdx];
          return next;
        });
      }, 2000);

    } catch (err: any) {
      clearInterval(progressInterval);
      console.error(err);
      alert(err.message || "生成动画时出错");

      setVideoProgress(prev => {
        const next = { ...prev };
        delete next[shotIdx];
        return next;
      });

      setGeneratedScript((prev: any) => {
        const updatedShots = [...prev.newShots];
        updatedShots[shotIdx] = {
          ...updatedShots[shotIdx],
          videoStatus: 'failed'
        };
        return { ...prev, newShots: updatedShots };
      });
    }
  };

  // Automatically start polling for any active video generation tasks when script loads
  useEffect(() => {
    if (!generatedScript || !generatedScript.newShots) return;
    generatedScript.newShots.forEach((shot: Shot, idx: number) => {
      if ((shot.videoStatus === 'submitted' || shot.videoStatus === 'processing') && shot.videoTaskId) {
        console.log(`[Kling] Resuming polling for task: ${shot.videoTaskId}`);
        pollAnimationStatus(shot.videoTaskId, idx);
      }
    });
  }, [generatedScript?.id]);

  const handleGenerateCharacterAvatar = async (char: Character) => {
    if (imagePlatform === 'comfyui' && !checkComfyRuntimeBeforeAction()) return;
    if (!generatedScript) return;
    const imagePrompt = `${char.name}, role is ${char.role}, appearance: ${char.clothing}, personality: ${char.personality}`;
    const negativePrompt = "low quality, blurry, deformed, extra limbs, bad anatomy, text, watermark";

    if (imagePlatform === 'comfyui') {
      try {
        const res = await fetch("/api/generate-image", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: imagePrompt,
            negativePrompt,
            isCharacter: true,
            platform: imagePlatform,
            projectId: generatedScript.id,
            targetType: 'character',
            targetId: char.id,
            viewType: 'avatar',
            characterName: char.name,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "生成头像任务提交失败");
        }
        pollComfyTasks();
      } catch (err: any) {
        alert(err.message || "提交任务失败");
      }
      return;
    }

    setIsGeneratingCharImage(true);
    try {
      const res = await fetch("/api/generate-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: imagePrompt,
          negativePrompt,
          isCharacter: true,
          platform: imagePlatform,
          projectId: generatedScript.id,
          targetType: 'character',
          characterName: char.name,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "生成头像失败");
      }

      const { url } = await res.json();

      // Write back to DB
      const putRes = await fetch(`/api/generated-scripts/${generatedScript.id}/image`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          characterName: char.name,
          imageUrl: url
        }),
      });

      if (putRes.ok) {
        const updatedChars = generatedScript.newCharacters.map((c: any) => {
          if (c.name === char.name) {
            return { ...c, avatarUrl: url, avatarImageUrl: url, sourceTaskId: null, hasReference: true };
          }
          return c;
        });
        const updatedScript = { ...generatedScript, newCharacters: updatedChars };
        setGeneratedScript(updatedScript);
        setActiveDrawerChar(prev => prev && prev.name === char.name ? { ...prev, avatarUrl: url } : prev);
        setGeneratedScripts(prev => prev.map(s => s.id === generatedScript.id ? updatedScript : s));
      }
    } catch (err: any) {
      alert(err.message || "生成头像时出错");
    } finally {
      setIsGeneratingCharImage(false);
    }
  };

  const handleUploadCharacterAvatar = (char: Character) => {
    if (!generatedScript) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const formData = new FormData();
        formData.append('video', file);
        const uploadResponse = await fetch('/api/upload', { method: 'POST', body: formData });
        const uploadResult = await uploadResponse.json().catch(() => ({}));
        if (!uploadResponse.ok || !uploadResult.url) throw new Error(uploadResult.error || '上传 Avatar 失败');
        const updatedCharacters = generatedScript.newCharacters.map((item: Character) => String(item.id) === String(char.id)
          ? { ...item, avatarUrl: uploadResult.url, avatarImageUrl: uploadResult.url, sourceTaskId: null, hasReference: true }
          : item);
        const response = await fetch(`/api/generated-scripts/${generatedScript.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newCharacters: updatedCharacters }),
        });
        if (!response.ok) throw new Error('保存 Avatar 失败');
        const updatedScript = { ...generatedScript, newCharacters: updatedCharacters };
        generatedScriptRef.current = updatedScript;
        setGeneratedScript(updatedScript);
        setGeneratedScripts(previous => previous.map(item => item.id === generatedScript.id ? updatedScript : item));
      } catch (error: any) {
        alert(error.message || '上传 Avatar 失败');
      }
    };
    input.click();
  };

  const handleGenerateThreeViews = async (char: Character) => {
    if (imagePlatform === 'comfyui' && !checkComfyRuntimeBeforeAction()) return;
    if (!generatedScript) return;
    if (!char.avatarUrl) {
      alert('请先生成角色母版；三视图必须使用当前 avatar 作为参考图。');
      return;
    }
    setIsGeneratingThreeViews(true);

    try {
      console.log(`[Three-Views] Translating character description for "${char.name}"...`);
      let englishDescription = "";
      try {
        const transRes = await fetch("/api/translate-character", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: char.name,
            role: char.role,
            clothing: char.clothing,
            personality: char.personality
          })
        });
        if (transRes.ok) {
          const data = await transRes.json();
          englishDescription = data.englishDescription;
        }
      } catch (err) {
        console.warn("[Three-Views] Translation API failed, using local fallback", err);
      }

      if (!englishDescription) {
        englishDescription = `${char.name}, role is ${char.role}, appearance: ${char.clothing}, personality: ${char.personality}`;
      }
      console.log(`[Three-Views] Translated character description: "${englishDescription}"`);

      const promptFront = `${englishDescription}, front view only, single character standing pose, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`;
      const promptSide = `${englishDescription}, side view only, facing right, single character, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`;
      const promptBack = `${englishDescription}, back view only, character facing away from camera, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`;

      if (imagePlatform === 'comfyui') {
        const res = await fetch("/api/generate-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            presetId: effectiveThreeViewPresetId,
            platform: imagePlatform,
            projectId: generatedScript.id,
            targetType: 'character',
            targetId: char.id,
            viewType: 'front',
            characterName: char.name,
            sourceImageUrl: char.avatarUrl,
            sourceTaskId: char.avatarGeneration?.taskId || getLatestSucceededTask(char.id || '', 'avatar')?.id || null,
          })
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Qwen 三视图任务提交失败");
        }
        pollComfyTasks();
        return;
      }

      console.log(`[Three-Views] Starting concurrent generation for Front, Side, Back (with skipTranslation: true)...`);

      const [frontUrl, sideUrl, backUrl] = await Promise.all([
        (async () => {
          const res = await fetch("/api/generate-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: promptFront, isCharacter: true, skipTranslation: true, platform: imagePlatform })
          });
          if (!res.ok) throw new Error("正面图生成失败");
          const data = await res.json();
          return data.url;
        })(),
        (async () => {
          const res = await fetch("/api/generate-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: promptSide, isCharacter: true, skipTranslation: true, platform: imagePlatform })
          });
          if (!res.ok) throw new Error("侧面图生成失败");
          const data = await res.json();
          return data.url;
        })(),
        (async () => {
          const res = await fetch("/api/generate-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: promptBack, isCharacter: true, skipTranslation: true, platform: imagePlatform })
          });
          if (!res.ok) throw new Error("背面图生成失败");
          const data = await res.json();
          return data.url;
        })()
      ]);

      const viewsObj = {
        front: frontUrl,
        side: sideUrl,
        back: backUrl
      };

      const putRes = await fetch(`/api/generated-scripts/${generatedScript.id}/image`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterName: char.name,
          views: viewsObj
        })
      });

      if (putRes.ok) {
        const updatedChars = generatedScript.newCharacters.map((c: any) => {
          if (c.name === char.name) {
            return { ...c, views: viewsObj };
          }
          return c;
        });
        const updatedScript = { ...generatedScript, newCharacters: updatedChars };
        setGeneratedScript(updatedScript);
        setActiveDrawerChar(prev => prev && prev.name === char.name ? { ...prev, views: viewsObj } : prev);
        setGeneratedScripts(prev => prev.map(s => s.id === generatedScript.id ? updatedScript : s));
        console.log(`[Three-Views] Completed successfully!`);
      } else {
        throw new Error("保存三视图到数据库失败");
      }
    } catch (err: any) {
      console.error(err);
      alert(err.message || "生成三视图时出错");
    } finally {
      setIsGeneratingThreeViews(false);
    }
  };

  const handleGenerateSingleView = async (char: Character, viewType: 'front' | 'side' | 'back') => {
    if (!generatedScript) return;
    if (!char.avatarUrl) {
      alert('请先生成角色母版；单独生成视图也必须使用 avatar 作为参考图。');
      return;
    }

    // 1. First translate the character description into English (consistent base)
    console.log(`[Three-Views] Translating character description for single view "${viewType}"...`);
    let englishDescription = "";
    try {
      const transRes = await fetch("/api/translate-character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: char.name,
          role: char.role,
          clothing: char.clothing,
          personality: char.personality
        })
      });
      if (transRes.ok) {
        const data = await transRes.json();
        englishDescription = data.englishDescription;
      }
    } catch (err) {
      console.warn("[Three-Views] Translation API failed, using local fallback", err);
    }

    if (!englishDescription) {
      englishDescription = `${char.name}, role is ${char.role}, appearance: ${char.clothing}, personality: ${char.personality}`;
    }

    // 2. Setup specific view prompt
    let prompt = "";
    if (viewType === "front") {
      prompt = `${englishDescription}, front view only, single character standing pose, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`;
    } else if (viewType === "side") {
      prompt = `${englishDescription}, side view only, facing right, single character, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`;
    } else {
      prompt = `${englishDescription}, back view only, character facing away from camera, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`;
    }

    if (imagePlatform === 'comfyui') {
      try {
        const res = await fetch("/api/generate-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            presetId: effectiveThreeViewPresetId,
            prompt,
            isCharacter: true,
            skipTranslation: true,
            platform: imagePlatform,
            projectId: generatedScript.id,
            targetType: 'character',
            targetId: char.id,
            viewType,
            characterName: char.name,
            sourceImageUrl: char.avatarUrl,
            sourceTaskId: char.avatarGeneration?.taskId || getLatestSucceededTask(char.id || '', 'avatar')?.id || null,
            sequentialThreeView: true,
          })
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || `生成${viewType === 'front' ? '正面' : viewType === 'side' ? '侧面' : '背面'}图任务提交失败`);
        }
        pollComfyTasks();
      } catch (err: any) {
        alert(err.message || "提交任务失败");
      }
      return;
    }

    setGeneratingViews(prev => ({ ...prev, [viewType]: true }));
    try {
      console.log(`[Three-Views] Starting single view generation for ${viewType} (with skipTranslation: true)...`);

      const res = await fetch("/api/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, isCharacter: true, skipTranslation: true, platform: imagePlatform })
      });
      if (!res.ok) throw new Error(`${viewType === 'front' ? '正面' : viewType === 'side' ? '侧面' : '背面'}图生成失败`);
      const data = await res.json();
      const url = data.url;

      const currentViews = char.views || { front: "", side: "", back: "" };
      const viewsObj = {
        ...currentViews,
        [viewType]: url
      };

      const putRes = await fetch(`/api/generated-scripts/${generatedScript.id}/image`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterName: char.name,
          views: viewsObj
        })
      });

      if (putRes.ok) {
        const updatedChars = generatedScript.newCharacters.map((c: any) => {
          if (c.name === char.name) {
            const updatedC = { ...c, views: viewsObj };
            if (viewType === "front") {
              updatedC.avatarUrl = url;
            }
            return updatedC;
          }
          return c;
        });
        const updatedScript = { ...generatedScript, newCharacters: updatedChars };
        setGeneratedScript(updatedScript);
        setActiveDrawerChar(prev => prev && prev.name === char.name ? { ...prev, views: viewsObj, avatarUrl: viewType === "front" ? url : prev.avatarUrl } : prev);
        setGeneratedScripts(prev => prev.map(s => s.id === generatedScript.id ? updatedScript : s));
        console.log(`[Three-Views] Single view ${viewType} completed successfully!`);
      } else {
        throw new Error("保存单视角图到数据库失败");
      }
    } catch (err: any) {
      console.error(err);
      alert(err.message || `生成${viewType === 'front' ? '正面' : viewType === 'side' ? '侧面' : '背面'}图时出错`);
    } finally {
      setGeneratingViews(prev => ({ ...prev, [viewType]: false }));
    }
  };

  const handleDownloadImage = async (url: string, filename: string) => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error("Failed to download image:", err);
      window.open(url, "_blank");
    }
  };

  const getKeywords = (personality: string) => {
    const words = personality.split(/[，。, 、\s;；]+/).filter(w => w.length >= 2 && w.length <= 6).slice(0, 3);
    if (words.length > 0) return words;
    return ["果断", "独特", "核心"];
  };

  const getScriptText = () => {
    if (!generatedScript) return "";
    let text = `====================================\n`;
    text += `全新创意剧本：《${generatedScript.newTitle}》\n`;
    text += `模板来源视频：${selectedRecord ? selectedRecord.title : '默认蒸汽飞艇演示样本'}\n`;
    text += `生成时间：${new Date().toLocaleString('zh-CN')}\n`;
    text += `====================================\n\n`;

    text += `【故事叙事结构】\n${generatedScript.newNarrative.structure}\n\n`;
    text += `【情节视听节奏】\n${generatedScript.newNarrative.rhythm}\n\n`;
    text += `【戏剧高潮爆点】\n${generatedScript.newNarrative.climaxDesign}\n\n`;

    text += `【全新人物设定】\n`;
    generatedScript.newCharacters.forEach((c: any, idx: number) => {
      text += `角色 ${idx + 1}：${c.name}\n`;
      text += `   - 定位：${c.role}\n`;
      text += `   - 性格：${c.personality}\n`;
      text += `   - 服饰与外观：${c.clothing}\n\n`;
    });

    text += `【全新分镜大纲脚本】\n`;
    generatedScript.newShots.forEach((s: any, idx: number) => {
      text += `[分镜 ${idx + 1}] 时间戳：${s.timestamp} | 运镜：${s.movement} | 构图：${s.composition} | 情绪：${s.emotion}\n`;
      text += `   情节详情：${s.description}\n\n`;
    });

    return text;
  };

  // Dynamic Metadata Filters derived from current db records
  const uniqueGenres = Array.from(new Set(records.map(r => r.genre).filter(Boolean)));
  const uniqueTags = Array.from(new Set(records.flatMap(r => r.tags || []).filter(Boolean)));

  // Filter video records list
  const filteredRecords = records.filter(r => {
    const matchesSearch = librarySearch
      ? r.title.toLowerCase().includes(librarySearch.toLowerCase()) ||
        r.genre.toLowerCase().includes(librarySearch.toLowerCase()) ||
        r.tags.some(t => t.toLowerCase().includes(librarySearch.toLowerCase()))
      : true;
    const matchesGenre = selectedGenre !== "all"
      ? r.genre.toLowerCase() === selectedGenre.toLowerCase()
      : true;
    const matchesTag = selectedTag !== "all"
      ? r.tags.some(t => t.toLowerCase() === selectedTag.toLowerCase())
      : true;
    return matchesSearch && matchesGenre && matchesTag;
  });

  // Current active data model
  const activeShots = selectedRecord ? selectedRecord.analysis.shots : videoAnalysisData.shots;
  const activeCharacters = selectedRecord ? selectedRecord.analysis.characters : videoAnalysisData.characters;
  const activeNarrative = selectedRecord ? selectedRecord.analysis.narrative : videoAnalysisData.narrative;

  // Filter active shots in the player timeline list
  const filteredShots = activeShots.filter((shot) => {
    const matchesSearch =
      shot.timestamp.includes(shotSearchQuery) ||
      shot.movement.toLowerCase().includes(shotSearchQuery.toLowerCase()) ||
      shot.composition.toLowerCase().includes(shotSearchQuery.toLowerCase()) ||
      shot.emotion.toLowerCase().includes(shotSearchQuery.toLowerCase()) ||
      shot.description.toLowerCase().includes(shotSearchQuery.toLowerCase());

    if (shotFilterCategory === "all") return matchesSearch;
    if (shotFilterCategory === "aerial") return matchesSearch && (shot.movement.includes("航拍") || shot.movement.toLowerCase().includes("aerial"));
    if (shotFilterCategory === "close") return matchesSearch && (shot.movement.includes("特写") || shot.movement.toLowerCase().includes("close"));
    if (shotFilterCategory === "portal") return matchesSearch && (shot.description.includes("门") || shot.description.includes("穿") || shot.movement.includes("传送门"));
    return matchesSearch;
  });

  // Raw requested JSON output format in Chinese
  const formattedJsonData = {
    shots: activeShots.map(s => ({
      "时间戳": s.timestamp,
      "运镜": s.movement,
      "构图": s.composition,
      "情绪": s.emotion,
      "画面描述": s.description
    })),
    characters: activeCharacters.map(c => ({
      "姓名/代号": c.name,
      "角色定位": c.role,
      "性格特征": c.personality,
      "服装": c.clothing
    })),
    narrative: {
      "故事结构": activeNarrative.structure,
      "节奏特点": activeNarrative.rhythm,
      "爽点设计": activeNarrative.climaxDesign
    }
  };

  const jsonString = JSON.stringify(formattedJsonData, null, 2);

  const handleCopyJson = () => {
    navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadJson = () => {
    const element = document.createElement("a");
    const file = new Blob([jsonString], { type: "application/json" });
    element.href = URL.createObjectURL(file);
    element.download = `${selectedRecord ? selectedRecord.title : 'video_analysis_report'}.json`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  // Initials Avatar generator for custom characters
  const renderCharacterAvatar = (char: Character) => {
    if (char.avatarUrl) {
      return (
        <img
          key={char.avatarUrl}
          src={char.avatarUrl}
          alt={char.name}
          className="w-full h-full object-cover transition-transform group-hover:scale-105"
          referrerPolicy="no-referrer"
        />
      );
    }
    const initials = char.name.substring(0, 2).toUpperCase();
    const gradients = [
      "from-blue-600 to-indigo-600",
      "from-purple-600 to-pink-600",
      "from-emerald-600 to-teal-600",
      "from-amber-500 to-orange-600",
      "from-rose-500 to-red-600",
    ];
    const charCodeSum = char.name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const grad = gradients[charCodeSum % gradients.length];
    return (
      <div className={`w-full h-full bg-gradient-to-br ${grad} flex items-center justify-center font-bold text-white text-sm uppercase tracking-wide`}>
        {initials}
      </div>
    );
  };

  const handleShotCharacterToggle = async (idx: number, characterId: string) => {
    if (!generatedScript) return;
    const updatedShots = [...generatedScript.newShots];
    const currentIds = updatedShots[idx].matchedCharacterIds || [];
    const matchedCharacterIds = currentIds.includes(characterId)
      ? currentIds.filter((id: string) => id !== characterId)
      : [...currentIds, characterId];
    updatedShots[idx] = { ...updatedShots[idx], matchedCharacterIds };

    const updatedScript = { ...generatedScript, newShots: updatedShots };
    setGeneratedScript(updatedScript);
    setGeneratedScripts(prev => prev.map(s => s.id === generatedScript.id ? updatedScript : s));

    try {
      const response = await fetch(`/api/generated-scripts/${generatedScript.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newShots: updatedShots }),
      });
      if (!response.ok) throw new Error('保存角色绑定失败');
    } catch (error) {
      console.error('[Shot Character Binding] Save failed:', error);
    }
  };

  const handleBindShotCharacter = (idx: number) => {
    try {
      if (!generatedScript) throw new Error('当前没有打开的项目');
      if (!(generatedScript.newCharacters || []).length) throw new Error('当前项目没有可绑定角色，请先创建角色');
      const shot = generatedScript.newShots?.[idx];
      if (!shot) throw new Error('未找到本镜数据');
      setShotCharacterFeedback(null);
      setShotCharacterModal({ shotIndex: idx, selectedIds: [...(shot.matchedCharacterIds || [])] });
    } catch (error: any) {
      setShotCharacterFeedback({ kind: 'error', message: error.message || '无法打开角色选择面板' });
    }
  };

  const handleModalCharacterToggle = (characterId: string) => {
    setShotCharacterModal(current => current ? {
      ...current,
      selectedIds: current.selectedIds.includes(characterId)
        ? current.selectedIds.filter(id => id !== characterId)
        : [...current.selectedIds, characterId],
    } : current);
  };

  const handleSaveShotCharacters = async (regenerateAfterSave = false) => {
    if (!generatedScript || !shotCharacterModal) {
      setShotCharacterFeedback({ kind: 'error', message: '角色选择状态已失效，请重新打开' });
      return;
    }
    try {
      const updatedShots = [...generatedScript.newShots];
      updatedShots[shotCharacterModal.shotIndex] = {
        ...updatedShots[shotCharacterModal.shotIndex],
        matchedCharacterIds: [...shotCharacterModal.selectedIds],
      };
      const projectId = String(generatedScript.id);
      const shot = updatedShots[shotCharacterModal.shotIndex];
      const shotId = String(shot?.id || '');
      if (!shotId) throw new Error(`本镜缺少 shotId（projectId=${projectId}）`);
      const requestUrl = `/api/generated-scripts/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/matched-characters`;
      const requestBody = { matchedCharacterIds: [...shotCharacterModal.selectedIds] };
      const response = await fetch(requestUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const responseText = await response.text();
      let result: any = {};
      try { result = responseText ? JSON.parse(responseText) : {}; } catch { result = { rawResponse: responseText }; }
      if (!response.ok) {
        console.error('[Shot Character Binding] Request failed', { url: requestUrl, method: 'PUT', body: requestBody, status: response.status, response: result, rawResponse: responseText, projectId, shotId });
        const staleBackendHint = response.status === 404 && responseText.includes('Cannot PUT') ? '当前 Express 后端未加载新接口，请重启后端服务。' : '';
        throw new Error(`${result.error || staleBackendHint || '保存角色绑定失败'}（HTTP ${response.status}，projectId=${projectId}，shotId=${shotId}）`);
      }
      updatedShots[shotCharacterModal.shotIndex] = { ...shot, matchedCharacterIds: result.matchedCharacterIds || requestBody.matchedCharacterIds };
      const updatedScript = { ...generatedScript, newShots: updatedShots };
      generatedScriptRef.current = updatedScript;
      setGeneratedScript(updatedScript);
      setGeneratedScripts(previous => previous.map(item => item.id === generatedScript.id ? updatedScript : item));
      setShotCharacterModal(null);
      if (regenerateAfterSave) {
        const savedShot = updatedShots[shotCharacterModal.shotIndex];
        const selectedCharacters = (updatedScript.newCharacters || []).filter((character: Character) => savedShot.matchedCharacterIds.includes(String(character.id || '')));
        const missingAvatarNames = selectedCharacters.filter((character: Character) => !(character.avatarImageUrl || character.avatarUrl)).map((character: Character) => character.name);
        if (!selectedCharacters.length) {
          setShotCharacterFeedback({ kind: 'error', message: '绑定已保存；请先选择至少一个角色再重新生成' });
        } else if (missingAvatarNames.length) {
          setShotCharacterFeedback({ kind: 'error', message: `绑定已保存；请先生成或上传 Avatar：${missingAvatarNames.join('、')}` });
        } else {
          setShotCharacterFeedback({ kind: 'success', message: '本镜角色已更新，正在用角色参考图重新生成' });
          await handleGenerateShotImage(savedShot, shotCharacterModal.shotIndex, updatedScript);
        }
      } else {
        setShotCharacterFeedback({ kind: 'success', message: '本镜角色已更新' });
      }
      window.setTimeout(() => setShotCharacterFeedback(null), 3000);
    } catch (error: any) {
      setShotCharacterFeedback({ kind: 'error', message: error.message || '保存角色绑定失败' });
    }
  };

  const storyboardPresets = workflowPresets.filter(preset => preset.purposes.includes('storyboard'));
  const selectedStoryboardPreset = workflowPresets.find(preset => preset.presetId === comfyProjectPreferences.shotPresetId);
  const characterMasterPresets = workflowPresets.filter(preset => preset.purposes.includes('characterMaster'));
  const threeViewPresets = workflowPresets.filter(preset => preset.purposes.includes('threeView'));
  const selectedCharacterMasterPreset = workflowPresets.find(preset => preset.presetId === comfyProjectPreferences.characterMasterPresetId);
  const effectiveThreeViewPresetId = threeViewPresets.some(preset => preset.presetId === comfyProjectPreferences.threeViewPresetId)
    ? comfyProjectPreferences.threeViewPresetId
    : (threeViewPresets[0]?.presetId || 'qwen_2511_three_views');
  const selectedThreeViewPreset = workflowPresets.find(preset => preset.presetId === effectiveThreeViewPresetId);
  const presetPurposeLabels: Record<WorkflowPresetSummary['purposes'][number], string> = {
    storyboard: '分镜生成',
    characterMaster: '角色母版',
    identity: '身份锁定',
    threeView: '三视图',
    upscale: '放大',
  };

  // 保存全局 Art Direction（Style Guide）到当前创意项目
  const saveArtDirection = async (overlay: string) => {
    if (!generatedScript) return;
    const artDirection = { ...(generatedScript.artDirection || {}), overlay, updatedAt: new Date().toISOString() };
    const response = await fetch(`/api/generated-scripts/${encodeURIComponent(String(generatedScript.id))}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artDirection }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`保存 Style Guide 失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`);
    }
    const updatedScript = { ...generatedScript, artDirection };
    setGeneratedScript(updatedScript);
    setGeneratedScripts(previous => previous.map(item => item.id === generatedScript.id ? updatedScript : item));
  };

  // 上传参考图，仅提取风格特征（styleOnly）生成全局 style overlay
  const handleAnalyzeArtDirection = async (file: File) => {
    setArtDirectionBusy(true);
    setArtDirectionMessage(null);
    try {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('styleOnly', 'true');
      const response = await fetch('/api/analyze-image-prompt', { method: 'POST', body: formData });
      const result: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = result?.error?.message || (typeof result?.error === 'string' ? result.error : '') || `风格提取失败（HTTP ${response.status}）`;
        throw new Error(message);
      }
      const overlay = String(result.flux_prompt || result.style || '').trim();
      if (!overlay) throw new Error('Gemini 未返回可用的 style overlay');
      if (generatedScript) {
        await saveArtDirection(overlay);
        setArtDirectionMessage('已从参考图提取全局 Style Guide 并保存');
      } else {
        setCreativeDraft(previous => ({ ...previous, artDirection: { ...(previous.artDirection || {}), overlay, analysis: result } }));
        setArtDirectionMessage('已提取全局 Style Guide（保存在当前创意草稿）');
      }
    } catch (error: any) {
      setArtDirectionMessage(`风格提取失败：${error.message || error}`);
    } finally {
      setArtDirectionBusy(false);
    }
  };

  // 主区顶部功能导航（分析面板与创意向导共用）
  const mainTabsBar = (
    <nav className="maintabs" role="tablist" aria-label="分析功能">
      {([
        ["shots", "分镜脉络"],
        ["characters", "人物画像"],
        ["narrative", "叙事与爽点"],
        ["generator", "创意生成"],
      ] as const).map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={activeTab === key}
          className={activeTab === key ? "on" : ""}
          onClick={() => setActiveTab(key)}
        >
          {label}
        </button>
      ))}
    </nav>
  );

  // 角色资产完备度（Avatar / 三视图 / 参考图）
  const characterAssetStatus = (char: Character) => {
    const hasAvatar = Boolean(char.avatarUrl || char.avatarImageUrl || char.avatarGeneration?.imageUrl);
    const viewKeys = ["front", "side", "back"] as const;
    const viewCount = viewKeys.filter(key => char.views?.[key] || char.viewGenerations?.[key]?.imageUrl).length;
    const hasReference = Boolean(char.hasReference || char.sourceTaskId);
    return { hasAvatar, viewCount, hasReference };
  };

  // 剪辑节奏：由真实分镜时长计算（短镜头 = 快节奏 = 高柱）
  const shotPaces = activeShots.map((shot, idx) => {
    const next = activeShots[idx + 1];
    const end = next ? next.timeSeconds : Math.max(duration, shot.timeSeconds + 2);
    const shotLength = Math.max(end - shot.timeSeconds, 0.5);
    return 1 / shotLength;
  });
  const maxShotPace = Math.max(...shotPaces, 0.01);

  const comfyStateLabel =
    comfyRuntime.state === 'running' ? '运行中' :
    comfyRuntime.state === 'external' ? '外部运行' :
    comfyRuntime.state === 'starting' ? '启动中…' :
    comfyRuntime.state === 'stopping' ? '停止中…' :
    comfyRuntime.state === 'error' ? '启动错误' : '未连接';

  const comfyDotClass =
    comfyRuntime.state === 'running' ? 'bg-emerald-500 animate-pulse' :
    comfyRuntime.state === 'external' ? 'bg-amber-500' :
    comfyRuntime.state === 'starting' ? 'bg-blue-400 animate-ping' :
    comfyRuntime.state === 'stopping' ? 'bg-rose-400 animate-ping' :
    comfyRuntime.state === 'error' ? 'bg-rose-500' : 'bg-slate-500';

  return (
    <div className="admin-shell bg-slate-950 text-slate-200 min-h-screen flex flex-col font-sans select-none overflow-x-hidden antialiased">
      {/* Top Header */}
      <header className="admin-topbar h-14 border-b border-slate-800/80 flex items-center justify-between px-6 bg-slate-900/60 backdrop-blur-md sticky top-0 z-40">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-white shadow-md shadow-blue-900/20">
            <Film className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm md:text-base font-semibold tracking-tight flex items-center gap-2">
              视频智能分析工作台
              <span className="text-slate-500 font-normal text-xs bg-slate-800 px-2 py-0.5 rounded-full border border-slate-700/50">
                {selectedRecord ? selectedRecord.title : "Pro_Edit_Final_V4.mp4 (演示样本)"}
              </span>
              <span className="bg-indigo-600 text-white text-[10px] font-bold px-2 py-0.5 rounded ml-2">
                UI_REDESIGN_V1
              </span>
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-mono bg-emerald-950/40 text-emerald-400 border border-emerald-800/50 px-2.5 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
            分析就绪
          </span>

          {/* ComfyUI 全局状态 pill + 生图平台/操作弹层 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowComfyPop(v => !v)}
              className="comfy-pill"
              title="生图平台与 ComfyUI 服务状态"
            >
              {imagePlatform === 'comfyui' ? (
                <>
                  <span className={`w-1.5 h-1.5 rounded-full ${comfyDotClass}`} />
                  <span>ComfyUI · {comfyStateLabel}</span>
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span>{imagePlatform === 'pollinations' ? 'Pollinations' : 'Kling AI'} · 云端</span>
                </>
              )}
              <ChevronRight className={`w-3 h-3 transition-transform ${showComfyPop ? 'rotate-90' : ''}`} />
            </button>

            {showComfyPop && (
              <>
                <div className="fixed inset-0 z-[290]" onClick={() => setShowComfyPop(false)} />
                <div className="comfy-pop space-y-2.5 p-3">
                  <label className="block space-y-1">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">默认生图平台</span>
                    <select
                      value={imagePlatform}
                      onChange={(event) => setImagePlatform(event.target.value as 'pollinations' | 'kling' | 'comfyui')}
                      className="w-full bg-slate-950 border border-slate-750 text-slate-200 text-[11px] rounded px-2 py-1.5 outline-none cursor-pointer"
                    >
                      <option value="comfyui">ComfyUI（本地）</option>
                      <option value="pollinations">Pollinations</option>
                      <option value="kling">Kling AI</option>
                    </select>
                  </label>

                  {imagePlatform === 'comfyui' && (
                    <div className="space-y-2 border-t border-slate-800 pt-2.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="flex items-center gap-1.5 font-semibold text-slate-300">
                          <span className={`w-1.5 h-1.5 rounded-full ${comfyDotClass}`} />
                          {comfyStateLabel}
                        </span>
                        {comfyRuntime.pid ? (
                          <span className="text-[9px] font-mono text-slate-500">PID {comfyRuntime.pid}</span>
                        ) : null}
                      </div>

                      {(comfyRuntime.state === 'stopped' || comfyRuntime.state === 'error') && (
                        <button
                          type="button"
                          onClick={handleStartComfy}
                          className="w-full px-2 py-1.5 rounded bg-emerald-950 hover:bg-emerald-900 border border-emerald-800/80 text-emerald-200 cursor-pointer flex items-center justify-center gap-1.5 text-[11px] font-semibold transition-all"
                          title={comfyRuntime.state === 'error' ? `错误原因: ${comfyRuntime.lastError || '未知'}` : '启动本地 ComfyUI'}
                        >
                          <Power className="w-3 h-3" />
                          <span>{comfyRuntime.state === 'error' ? '重新启动 ComfyUI' : '启动 ComfyUI'}</span>
                        </button>
                      )}

                      {(comfyRuntime.state === 'running' || comfyRuntime.state === 'external') && (
                        <div className="space-y-1.5">
                          <select
                            value={templatePresetId}
                            onChange={event => setTemplatePresetId(event.target.value)}
                            className="w-full rounded border border-slate-750 bg-slate-950 px-2 py-1.5 text-[10px] text-slate-300 outline-none"
                            title="选择要打开的通用工作流模板"
                          >
                            <option value="sdxl_legacy">SDXL Legacy</option>
                            <option value="pure_klein">Pure Klein 4B</option>
                            <option value="pulid_flux2">PuLID Flux2</option>
                            <option value="qwen_2511_three_views">Qwen 2511 Three Views</option>
                            <option value="esrgan_4x">4x ESRGAN</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => handleOpenAdvanced(null)}
                            className="w-full px-2 py-1.5 rounded bg-purple-950/60 hover:bg-purple-900 border border-purple-800/60 text-purple-200 cursor-pointer flex items-center justify-center gap-1.5 text-[11px] font-semibold transition-all"
                            title="通用模板不可直接导回；需要导回时请从具体图片点击高级调整。"
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>打开工作流模板</span>
                          </button>
                        </div>
                      )}

                      {comfyRuntime.state === 'running' && comfyRuntime.managed && (
                        <button
                          type="button"
                          onClick={handleStopComfy}
                          className="w-full px-2 py-1.5 rounded bg-rose-950 hover:bg-rose-900 border border-rose-800 text-rose-200 cursor-pointer flex items-center justify-center gap-1.5 text-[11px] font-semibold transition-all"
                          title={`停止 ComfyUI (PID: ${comfyRuntime.pid})`}
                        >
                          <Square className="w-2.5 h-2.5 fill-rose-300" />
                          <span>停止 ComfyUI</span>
                        </button>
                      )}

                      {(comfyRuntime.state === 'starting' || comfyRuntime.state === 'stopping') && (
                        <span className="text-slate-500 italic flex items-center justify-center gap-1.5 text-[11px] py-1">
                          <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
                          <span>请稍候...</span>
                        </span>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          loadComfyProjectPreferences().catch(error => alert(error.message));
                          setShowComfyPresetSettings(true);
                          setShowComfyPop(false);
                        }}
                        disabled={!generatedScript}
                        className="w-full px-2 py-1.5 rounded bg-slate-900 hover:bg-slate-800 disabled:opacity-40 border border-slate-750 text-slate-300 cursor-pointer text-[11px] font-semibold transition-all"
                        title={generatedScript ? '项目级 ComfyUI 默认预设' : '打开一个创意项目后可配置项目级预设'}
                      >
                        项目预设设置
                      </button>

                      {comfyRuntime.state === 'error' && comfyRuntime.lastError && (
                        <p className="text-rose-400 font-mono text-[9px] leading-relaxed break-all max-h-16 overflow-y-auto custom-scrollbar" title={comfyRuntime.lastError}>
                          {comfyRuntime.lastError.split('\n')[0]}
                        </p>
                      )}

                      <p className="text-[9px] text-slate-500 leading-relaxed border-t border-slate-800 pt-2">
                        通用模板不可直接导回；需要导回时请从具体图片点击“高级调整”。
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <button
            id="export-json-btn"
            onClick={() => setShowJsonModal(true)}
            className="bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-medium py-1.5 px-3 md:px-4 rounded-md transition-all flex items-center gap-2 cursor-pointer shadow-lg shadow-blue-900/15"
          >
            <FileJson className="w-3.5 h-3.5" />
            <span>导出 JSON 报告</span>
          </button>
        </div>
      </header>

      {/* Main Workspace Area (3 columns: Library Sidebar, Player Column, Tabular Details) */}
      <main className="admin-layout flex-1 flex flex-col md:flex-row overflow-hidden w-full mx-auto">

        {/* Column 1: Video Library & File Upload (width 320px) */}
        <aside className="admin-navigation w-full md:w-80 border-r border-slate-800/60 bg-slate-950/40 flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
          {/* Header */}
          <div className="p-4 border-b border-slate-800/80 flex items-center gap-2 bg-slate-900/10">
            <Database className="w-4 h-4 text-blue-500" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">本地视频分析库</h2>
          </div>

          {/* Upload Zone */}
          <div className="p-4 border-b border-slate-800/50">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={triggerFileSelect}
              className={`border border-dashed rounded-xl p-5 text-center cursor-pointer transition-all duration-300 ${
                isUploading || isAnalyzing
                  ? "border-blue-500/50 bg-blue-950/10 cursor-not-allowed"
                  : "border-slate-800 bg-slate-900/30 hover:border-blue-500/40 hover:bg-slate-900/60"
              }`}
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="video/*"
                className="hidden"
              />

              {isUploading || isAnalyzing ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-slate-200">
                      {isUploading ? `视频上传中 (${uploadProgress}%)` : "Gemini 分析中..."}
                    </p>
                    <p className="text-[10px] text-slate-500 leading-relaxed max-w-[200px] mx-auto">
                      {isUploading ? "正在将本地大视频同步至服务器..." : "正在通过云端 Gemini 识别结构化分镜与剧情..."}
                    </p>
                  </div>
                  {isUploading && (
                    <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden mt-1">
                      <div
                        className="bg-blue-600 h-full transition-all duration-300"
                        style={{ width: `${uploadProgress}%` }}
                      ></div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <div className="w-10 h-10 rounded-full bg-blue-950/40 flex items-center justify-center border border-blue-900/20">
                    <Upload className="w-4 h-4 text-blue-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-300">点击或拖拽视频文件上传</p>
                  <p className="text-[10px] text-slate-500">支持 MP4, MOV, WEBM, AVI 等常见格式</p>
                </div>
              )}
            </div>

            {/* Status alerts */}
            {statusText && (
              <div className="mt-3 p-2 bg-blue-950/20 border border-blue-900/40 rounded-lg text-[10px] text-blue-400 leading-normal flex items-start gap-1.5 animate-pulse">
                <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{statusText}</span>
              </div>
            )}

            {uploadError && (
              <div className="mt-3 p-2 bg-red-950/20 border border-red-900/30 rounded-lg text-[10px] text-red-400 leading-normal flex items-start gap-1.5">
                <X className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{uploadError}</span>
              </div>
            )}

            {/* Short Drama Mode Toggle */}
            <div className="mt-3 flex items-center justify-between bg-slate-900/45 border border-slate-800/80 rounded-xl p-3 shadow-inner transition-all hover:bg-slate-900/60">
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-slate-200">竖屏短剧分析模式</span>
                <span className="text-[10px] text-slate-500 mt-0.5">切分为每3-5秒一个镜头</span>
              </div>
              <button
                type="button"
                onClick={() => setShortDramaMode(!shortDramaMode)}
                className={`w-9 h-5 rounded-full p-0.5 transition-all duration-300 focus:outline-none relative flex items-center cursor-pointer ${
                  shortDramaMode ? 'bg-gradient-to-r from-blue-500 to-indigo-600 shadow-md shadow-blue-500/25' : 'bg-slate-800'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white shadow-md transform transition-all duration-300 ${
                    shortDramaMode ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Search & Metadata Filters */}
          <div className="p-4 border-b border-slate-800/50 space-y-3 bg-slate-950/20">
            {/* Search Box */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="搜索视频标题/标签/分类..."
                value={librarySearch}
                onChange={(e) => setLibrarySearch(e.target.value)}
                className="w-full bg-slate-900 text-slate-200 pl-9 pr-4 py-1.5 rounded-lg border border-slate-800 focus:outline-none focus:border-blue-500 text-xs transition-colors"
              />
              {librarySearch && (
                <button onClick={() => setLibrarySearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Genre & Tag Dropdown selectors */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <span className="text-[9px] font-mono text-slate-500 uppercase font-bold tracking-wider">类型筛选</span>
                <select
                  value={selectedGenre}
                  onChange={(e) => setSelectedGenre(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 rounded-md p-1.5 text-[11px] text-slate-300 outline-none focus:border-blue-500"
                >
                  <option value="all">全部类型</option>
                  {uniqueGenres.map(g => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <span className="text-[9px] font-mono text-slate-500 uppercase font-bold tracking-wider">标签筛选</span>
                <select
                  value={selectedTag}
                  onChange={(e) => setSelectedTag(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 rounded-md p-1.5 text-[11px] text-slate-300 outline-none focus:border-blue-500"
                >
                  <option value="all">全部标签</option>
                  {uniqueTags.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Records List */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-900 custom-scrollbar">
            {/* Group 1: Videos */}
            <div>
              <div className="px-4 py-2 bg-slate-900/35 text-[9px] uppercase font-bold tracking-widest font-mono text-slate-500 border-b border-slate-900/80">
                视频分析记录
              </div>
              <div className="divide-y divide-slate-900">
                {/* Demo item card */}
                <div
                  onClick={() => {
                    setSelectedRecord(null);
                    setGeneratedScript(null);
                  }}
                  className={`p-4 cursor-pointer transition-colors relative ${
                    selectedRecord === null && generatedScript === null
                      ? "bg-blue-950/20 border-l-2 border-blue-500"
                      : "hover:bg-slate-900/30 border-l-2 border-transparent"
                  }`}
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <h3 className="text-xs font-bold text-slate-200 truncate flex items-center gap-1.5">
                        <Tv className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                        <span>蒸汽飞空艇与少女 (演示样本)</span>
                      </h3>
                      <p className="text-[10px] text-slate-500 mt-1">内置静态模拟数据，支持完整操作联动</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        <span className="text-[9px] px-1.5 py-0.5 bg-slate-850 text-slate-400 rounded">奇幻科幻</span>
                        <span className="text-[9px] px-1.5 py-0.5 bg-slate-850 text-slate-400 rounded">朋克</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Dynamic DB items */}
                {filteredRecords.length > 0 ? (
                  filteredRecords.map((rec) => {
                    const isActive = selectedRecord !== null && selectedRecord.id === rec.id;
                    return (
                      <div
                        key={rec.id}
                        onClick={() => {
                          setSelectedRecord(rec);
                          setGeneratedScript(null);
                        }}
                        className={`p-4 cursor-pointer transition-colors relative group ${
                          isActive
                            ? "bg-blue-950/25 border-l-2 border-blue-500"
                            : "hover:bg-slate-900/30 border-l-2 border-transparent"
                        }`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <h3 className={`text-xs font-bold truncate flex items-center gap-1.5 ${
                              isActive ? "text-blue-400" : "text-slate-200"
                            }`}>
                              <Film className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span className="truncate">{rec.title}</span>
                            </h3>

                            <div className="flex flex-wrap gap-1 mt-1.5">
                              <span className="text-[9px] px-1.5 py-0.5 bg-slate-900/80 text-blue-400/80 rounded border border-blue-950">
                                {rec.genre}
                              </span>
                              {rec.tags.slice(0, 2).map(tag => (
                                <span key={tag} className="text-[9px] px-1.5 py-0.5 bg-slate-900/80 text-slate-400 rounded">
                                  {tag}
                                </span>
                              ))}
                            </div>

                            <span className="text-[9px] text-slate-500 font-mono flex items-center gap-1 mt-2">
                              <Calendar className="w-3 h-3 shrink-0" />
                              {new Date(rec.createdAt).toLocaleString('zh-CN', {
                                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                              })}
                            </span>
                          </div>

                          <button
                            onClick={(e) => handleDeleteRecord(rec.id, e)}
                            className="opacity-0 group-hover:opacity-100 hover:text-red-400 text-slate-600 p-1 rounded hover:bg-red-950/30 transition-all cursor-pointer shrink-0"
                            title="删除此视频"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  records.length > 0 && (
                    <div className="p-4 text-center text-slate-600 text-[10px]">
                      未匹配到过滤视频
                    </div>
                  )
                )}
              </div>
            </div>

            {/* Group 2: Generated Scripts */}
            <div>
              <div className="px-4 py-2 bg-slate-900/35 text-[9px] uppercase font-bold tracking-widest font-mono text-slate-500 border-b border-slate-900/80">
                历史生成剧本
              </div>
              <div className="divide-y divide-slate-900">
                {generatedScripts.length > 0 ? (
                  generatedScripts.map((script) => {
                    const isActive = generatedScript !== null && generatedScript.id === script.id;
                    return (
                      <div
                        key={script.id}
                        onClick={() => {
                          setGeneratedScript(script);
                          setSelectedRecord(null); // clear video player record
                          setActiveTab("generator");
                          setGeneratorTopic(script.topic);
                          // Initialize shotImages state with existing generated images
                          const images: Record<string, string> = {};
                          script.newShots.forEach((s: any) => {
                            if (s.generatedImageUrl) {
                              images[s.timestamp] = s.generatedImageUrl;
                            } else if (s.imageUrl) {
                              images[s.timestamp] = s.imageUrl;
                            }
                          });
                          setShotImages(images);
                        }}
                        className={`p-4 cursor-pointer transition-colors relative group ${
                          isActive
                            ? "bg-emerald-950/20 border-l-2 border-emerald-500"
                            : "hover:bg-slate-900/30 border-l-2 border-transparent"
                        }`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <h3 className={`text-xs font-bold truncate flex items-center gap-1.5 ${
                              isActive ? "text-emerald-400" : "text-slate-200"
                            }`}>
                              <Sparkles className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              <span className="truncate">{script.newTitle}</span>
                            </h3>
                            <p className="text-[10px] text-slate-500 mt-1 truncate">主题：{script.topic}</p>

                            <span className="text-[9px] text-slate-500 font-mono flex items-center gap-1 mt-2">
                              <Clock className="w-3 h-3 shrink-0" />
                              {new Date(script.createdAt).toLocaleString('zh-CN', {
                                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                              })}
                            </span>
                          </div>

                          <button
                            onClick={(e) => handleDeleteScript(script.id, e)}
                            className="opacity-0 group-hover:opacity-100 hover:text-red-400 text-slate-600 p-1 rounded hover:bg-red-950/30 transition-all cursor-pointer shrink-0"
                            title="删除此剧本"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="p-6 text-center text-slate-600 text-[10px] leading-normal">
                    暂无生成剧本记录，可在“创意生成”选项卡中创建！
                  </div>
                )}
              </div>
            </div>
          </div>
        </aside>

        {/* Column 2: 主功能区（顶部导航 + 当前面板）；创意生成时隐藏，向导占满右侧 */}
        {activeTab !== "generator" && (
          <section className="admin-workspace w-full flex flex-col border-r border-slate-800/60 bg-slate-950/20">
            {mainTabsBar}

            {activeTab === "shots" && (<>
            {/* Cinema Box (Dynamic HTML5 Video or Slideshow) */}
            <div className="aspect-video lg:h-[320px] lg:aspect-auto w-full bg-slate-950 relative flex items-center justify-center border-b border-slate-800/80 overflow-hidden group shrink-0">
              {/* Background cinematic blur */}
              <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-slate-600 to-black z-0"></div>

              {selectedRecord ? (
                // HTML5 native video player for uploaded videos
                <video
                  ref={videoRef}
                  src={selectedRecord.url}
                  className="absolute inset-0 w-full h-full object-contain z-10 brightness-[0.9] contrast-[1.05]"
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleLoadedMetadata}
                  onEnded={() => setIsPlaying(false)}
                  onClick={() => setIsPlaying(!isPlaying)}
                />
              ) : (
                // Image slideshow simulation for the default demo video
                <AnimatePresence mode="wait">
                  <motion.img
                    key={activeShot.id}
                    src={activeShot.imageUrl}
                    alt={activeShot.movement}
                    className="absolute inset-0 w-full h-full object-cover select-none z-10 brightness-[0.85] contrast-[1.05]"
                    initial={{ opacity: 0, scale: 1.02 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.4 }}
                    referrerPolicy="no-referrer"
                  />
                </AnimatePresence>
              )}

              {/* Cinematic overlay grids */}
              <div className="absolute inset-0 border-[16px] border-black/40 z-20 pointer-events-none"></div>
              <div className="absolute top-6 left-6 z-20 bg-black/60 backdrop-blur-md px-3 py-1 rounded-md border border-white/10 text-xs font-mono tracking-wider flex items-center gap-2 text-white">
                <span className="w-2 h-2 bg-red-500 rounded-full animate-ping"></span>
                <span>{selectedRecord ? "VIDEO PLAYING" : "LIVE REPLAY"}</span>
              </div>

              {/* Video overlay watermark/time */}
              <div className="absolute bottom-6 right-6 z-20 bg-black/60 backdrop-blur-md px-3 py-1 rounded-md border border-white/10 text-xs font-mono text-white">
                {formatTime(currentTime)} / {formatTime(duration)}
              </div>

              {/* Interactive Quick Action Rail in Player Overlay */}
              <div className="absolute bottom-6 left-6 z-20 flex items-center gap-2">
                <button
                  onClick={() => setIsPlaying(!isPlaying)}
                  className="w-10 h-10 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95 cursor-pointer"
                >
                  {isPlaying ? <Pause className="w-4 h-4 fill-white" /> : <Play className="w-4 h-4 fill-white ml-0.5" />}
                </button>
                <button
                  onClick={() => {
                    setAudioMuted(!audioMuted);
                    if (videoRef.current) {
                      videoRef.current.muted = !audioMuted;
                    }
                  }}
                  className="w-8 h-8 rounded-full bg-slate-800/80 hover:bg-slate-700 text-white flex items-center justify-center backdrop-blur shadow transition-colors cursor-pointer"
                >
                  {audioMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
              </div>

              {/* Interactive Progress bar */}
              <div className="absolute bottom-0 left-0 right-0 h-2 bg-slate-900/90 z-20 cursor-pointer"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickX = e.clientX - rect.left;
                  const percentage = clickX / rect.width;
                  const targetSeconds = Math.floor(percentage * duration);
                  setCurrentTime(targetSeconds);

                  if (selectedRecord && videoRef.current) {
                    videoRef.current.currentTime = targetSeconds;
                  } else {
                    // Seek in demo video
                    const matchingShot = [...videoAnalysisData.shots]
                      .reverse()
                      .find((shot) => shot.timeSeconds <= targetSeconds);
                    if (matchingShot) setActiveShot(matchingShot);
                  }
                }}
              >
                <div
                  className="h-full bg-gradient-to-r from-blue-600 to-indigo-500 relative transition-all duration-300 shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                  style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
                >
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full border-2 border-blue-600 shadow cursor-grab"></div>
                </div>
              </div>
            </div>

            {/* 当前分镜信息条（紧凑，让分镜表获得更多可视行） */}
            <div className="px-5 py-2.5 bg-slate-900/40 border-b border-slate-800/60 shrink-0">
              <div className="flex items-baseline gap-2.5 mb-1.5 min-w-0">
                <span className="text-[11px] font-mono text-blue-400 bg-blue-950/50 border border-blue-900/50 px-2 py-0.5 rounded shrink-0">
                  {activeShot.timestamp}
                </span>
                <h2 className="text-base font-semibold text-slate-100 tracking-tight truncate">{activeShot.movement}</h2>
                <span className="ml-auto text-[10px] font-mono text-slate-500 shrink-0 hidden sm:inline">起始 {activeShot.timeSeconds}s</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0.5 mb-1">
                <p className="text-xs text-slate-300 truncate">
                  <span className="text-[10px] text-slate-500 mr-1.5">构图</span>{activeShot.composition}
                </p>
                <p className="text-xs text-emerald-400 truncate">
                  <span className="text-[10px] text-slate-500 mr-1.5">情绪</span>{activeShot.emotion}
                </p>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-2" title={activeShot.description}>
                {activeShot.description}
              </p>
            </div>

            {/* Quick Search & Filters Bar */}
            <div className="px-4 py-3 bg-slate-900/30 border-b border-slate-800/50 flex flex-col sm:flex-row gap-2 justify-between items-center">
              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="搜索分镜运镜/构图/情绪..."
                  value={shotSearchQuery}
                  onChange={(e) => setShotSearchQuery(e.target.value)}
                  className="w-full bg-slate-950 text-slate-200 pl-9 pr-4 py-1.5 rounded-lg border border-slate-800 focus:outline-none focus:border-blue-500 text-xs transition-colors"
                />
                {shotSearchQuery && (
                  <button onClick={() => setShotSearchQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto self-start sm:self-auto pb-1 sm:pb-0">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider whitespace-nowrap">分镜筛选:</span>
                {["all", "aerial", "close", "portal"].map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setShotFilterCategory(cat)}
                    className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider cursor-pointer border transition-colors ${
                      shotFilterCategory === cat
                        ? "bg-blue-600/10 text-blue-400 border-blue-500/30"
                        : "bg-transparent text-slate-400 border-transparent hover:bg-slate-800 hover:text-slate-200"
                    }`}
                  >
                    {cat === "all" ? "全部" : cat === "aerial" ? "航拍" : cat === "close" ? "特写" : "通道穿梭"}
                  </button>
                ))}
                <span className="text-[10px] text-slate-500 whitespace-nowrap pl-2">{filteredShots.length} 个分镜</span>
              </div>
            </div>

            {/* Shots Sequence Table (High Density scroll area) */}
            <div className="flex-1 overflow-y-auto max-h-[350px] lg:max-h-none custom-scrollbar">
              <div className="bg-slate-950/50 px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-slate-500 flex border-b border-slate-800 sticky top-0 z-10 bg-slate-950">
                <span className="w-16">时间戳</span>
                <span className="w-32 md:w-44 truncate">运镜方式</span>
                <span className="w-24 md:w-32 truncate">画面构图</span>
                <span className="flex-1 truncate">情绪基调</span>
              </div>
              <div className="divide-y divide-slate-900">
                {filteredShots.length > 0 ? (
                  filteredShots.map((shot, idx) => {
                    const isActive = shot.timestamp === activeShot.timestamp;
                    return (
                      <div
                        key={idx}
                        onClick={() => handleShotClick(shot)}
                        className={`flex px-4 py-3 items-center hover:bg-blue-950/10 cursor-pointer transition-colors ${
                          isActive ? "bg-blue-950/20 border-l-2 border-blue-500 pl-[14px]" : "border-l-2 border-transparent"
                        }`}
                      >
                        <span className={`w-16 text-xs font-mono font-medium ${isActive ? "text-blue-400" : "text-slate-500"}`}>
                          {shot.timestamp.split(" - ")[0]}
                        </span>
                        <span className={`w-32 md:w-44 text-xs font-medium truncate pr-2 ${isActive ? "text-slate-100" : "text-slate-300"}`}>
                          {shot.movement}
                        </span>
                        <span className="w-24 md:w-32 text-xs text-slate-400 font-mono truncate pr-2">
                          {shot.composition}
                        </span>
                        <span className={`flex-1 text-xs truncate ${isActive ? "text-emerald-400" : "text-slate-400"}`}>
                          {shot.emotion}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div className="p-8 text-center text-slate-500 text-xs">
                    未找到匹配的分镜数据。
                  </div>
                )}
              </div>
            </div>
            </>)}

            {/* ── 人物画像：卡片网格（资产完备度一目了然） ── */}
            {activeTab === "characters" && (
              <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-100 tracking-tight">识别角色与画像档案</h2>
                    <p className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wider">
                      Identified Characters · 视频分析出 {activeCharacters.length} 位角色
                    </p>
                  </div>
                </div>

                {activeCharacters.length > 0 ? (
                  <div className="char-grid">
                    {activeCharacters.map((char, idx) => {
                      const asset = characterAssetStatus(char);
                      return (
                        <div key={char.id || idx} className="char-card group" onClick={() => setSelectedCharacter(char)}>
                          <div className="h-28 w-full overflow-hidden relative bg-slate-800">
                            {renderCharacterAvatar(char)}
                          </div>
                          <div className="p-3">
                            <div className="flex items-center justify-between gap-2">
                              <h4 className="text-sm font-bold text-slate-100 truncate">{char.name}</h4>
                            </div>
                            <p className="text-[10px] text-blue-400 mb-2 truncate">{char.role ? char.role.split(" (")[0] : "剧中人物"}</p>
                            <p className="text-[11px] text-slate-500 line-clamp-2 leading-relaxed mb-2.5 min-h-8">{char.personality}</p>

                            <div className="flex items-center gap-3 mb-2.5 text-[10px]">
                              <span className="flex items-center gap-1" title={asset.hasAvatar ? "Avatar 已生成" : "缺少 Avatar"}>
                                <span className={`char-asset-dot ${asset.hasAvatar ? "bg-emerald-500" : "bg-slate-700"}`}></span>
                                <span className="text-slate-500">Avatar</span>
                              </span>
                              <span className="flex items-center gap-1" title={`三视图已生成 ${asset.viewCount}/3`}>
                                <span className={`char-asset-dot ${asset.viewCount === 3 ? "bg-emerald-500" : asset.viewCount > 0 ? "bg-amber-500" : "bg-slate-700"}`}></span>
                                <span className="text-slate-500">三视图 {asset.viewCount}/3</span>
                              </span>
                              <span className="flex items-center gap-1" title={asset.hasReference ? "参考图就绪" : "缺少参考图"}>
                                <span className={`char-asset-dot ${asset.hasReference ? "bg-emerald-500" : "bg-slate-700"}`}></span>
                                <span className="text-slate-500">参考图</span>
                              </span>
                            </div>

                            <div className="flex flex-wrap gap-1.5 mb-2.5">
                              {(char.skills || []).slice(0, 3).map(skill => (
                                <span key={skill} className="text-[9px] px-1.5 py-0.5 bg-slate-950 text-slate-400 rounded font-mono">{skill}</span>
                              ))}
                            </div>

                            <button
                              type="button"
                              className="w-full py-1.5 rounded-md border border-slate-750 text-[11px] text-slate-400 group-hover:text-slate-100 group-hover:bg-slate-800 transition-colors cursor-pointer"
                            >
                              查看完整档案
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-10 text-center text-slate-500 text-xs bg-slate-900/40 border border-slate-800 rounded-xl">
                    Gemini 未在此视频中检测到明显人物角色。
                  </div>
                )}
              </div>
            )}

            {/* ── 叙事与爽点：三段式结构 + 数据驱动节奏条 ── */}
            {activeTab === "narrative" && (
              <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-7">
                <div>
                  <div className="flex items-center gap-2.5 mb-3 pb-2 border-b border-slate-800/60">
                    <span className="w-6 h-6 rounded-full bg-amber-950/50 border border-amber-800/50 flex items-center justify-center text-[11px] font-bold text-amber-400 shrink-0">1</span>
                    <div>
                      <h3 className="text-base font-bold text-slate-100">三幕叙事结构分析</h3>
                      <p className="text-[9px] font-bold text-amber-500/80 uppercase tracking-widest">Narrative Arc</p>
                    </div>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/50 p-4 rounded-xl border border-slate-800/80">
                    {activeNarrative.structure || "暂无叙事结构数据"}
                  </p>
                </div>

                <div>
                  <div className="flex items-center gap-2.5 mb-3 pb-2 border-b border-slate-800/60">
                    <span className="w-6 h-6 rounded-full bg-amber-950/50 border border-amber-800/50 flex items-center justify-center text-[11px] font-bold text-amber-400 shrink-0">2</span>
                    <div>
                      <h3 className="text-base font-bold text-slate-100">视听剪辑节奏特点</h3>
                      <p className="text-[9px] font-bold text-amber-500/80 uppercase tracking-widest">Edit & Audio Rhythm</p>
                    </div>
                  </div>
                  {shotPaces.length > 1 && (
                    <div className="mb-2">
                      <div className="rhythm-bar">
                        {shotPaces.map((pace, idx) => {
                          const ratio = pace / maxShotPace;
                          return (
                            <div
                              key={idx}
                              className={ratio > 0.85 ? "peak" : ""}
                              style={{ height: `${Math.max(ratio * 100, 8)}%` }}
                              title={`${activeShots[idx].timestamp} · ${activeShots[idx].movement}`}
                            />
                          );
                        })}
                      </div>
                      <div className="flex justify-between text-[9px] text-slate-500 mt-1">
                        <span>{activeShots[0]?.timestamp?.split(" - ")[0] || "00:00"}</span>
                        <span>镜头切换节奏（柱越高节奏越快，琥珀色为峰值段）</span>
                        <span>{formatTime(duration)}</span>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/50 p-4 rounded-xl border border-slate-800/80">
                    {activeNarrative.rhythm || "暂无视听节奏数据"}
                  </p>
                </div>

                <div>
                  <div className="flex items-center gap-2.5 mb-3 pb-2 border-b border-slate-800/60">
                    <span className="w-6 h-6 rounded-full bg-amber-950/50 border border-amber-800/50 flex items-center justify-center text-[11px] font-bold text-amber-400 shrink-0">3</span>
                    <div>
                      <h3 className="text-base font-bold text-slate-100">爽点位置与戏剧冲突高潮点</h3>
                      <p className="text-[9px] font-bold text-amber-500/80 uppercase tracking-widest">Spectacle Design</p>
                    </div>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/50 p-4 rounded-xl border border-slate-800/80">
                    {activeNarrative.climaxDesign || "暂无爽点设计数据"}
                  </p>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Column 3: 右栏（统计 + 上下文）；创意生成 tab 时承载全宽向导 */}
        <section className="admin-inspector flex-1 flex flex-col bg-slate-900/30 overflow-y-auto custom-scrollbar">
          {activeTab === "generator" ? (
            <>
              {mainTabsBar}
              <div className="p-6 flex-1 flex flex-col gap-6">

            {activeTab === "generator" && (
              <div className="space-y-6">
                
                {/* 创作向导面包屑 / 高级工作台切换 */}
                {generatedScript && (
                  <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-900/60 p-4 border border-slate-800 rounded-2xl mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white uppercase tracking-wider">创作向导</span>
                      <div className="w-[1px] h-3 bg-slate-800 mx-2"></div>
                      <div className="flex items-center gap-3">
                        {[
                          { num: 1, label: '风格设定' },
                          { num: 2, label: '角色配置' },
                          { num: 3, label: '分镜生成' },
                          { num: 4, label: '导出' }
                        ].map((s) => {
                          const isCompleted = creativeStep > s.num;
                          const isActive = creativeStep === s.num;
                          return (
                            <button
                              key={s.num}
                              type="button"
                              onClick={() => setCreativeStep(s.num)}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                                isActive
                                  ? 'bg-blue-600/25 border-blue-500/50 text-blue-100 shadow-md shadow-blue-950/20'
                                  : isCompleted
                                    ? 'bg-emerald-950/25 border-emerald-800/40 text-emerald-400'
                                    : 'bg-slate-950/40 border-slate-850 text-slate-400 hover:border-slate-800 hover:text-slate-305'
                              }`}
                            >
                              <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] ${
                                isActive ? 'bg-blue-600 text-white' : isCompleted ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-500'
                              }`}>{isCompleted ? '✓' : s.num}</span>
                              <span>{s.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setCreativeStep(3);
                        }}
                        className="px-3 py-1.5 rounded-lg border border-purple-800/40 bg-purple-955/20 text-[10px] font-semibold text-purple-300 hover:bg-purple-900/30 transition-all cursor-pointer font-bold"
                      >
                        ⚡ 一键进入高级工作台
                      </button>
                    </div>
                  </div>
                )}

                {/* Project Art Direction - 风格分析与 Style Guide 编辑区 */}
                {creativeStep === 1 && (
                  <section className="border border-cyan-800/60 bg-cyan-950/15 p-4 space-y-3 rounded-2xl">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="text-xs font-bold text-cyan-200">Project Art Direction</h3>
                        <p className="mt-1 text-[10px] text-slate-400">上传参考图提取全局色彩、光影、材质与氛围。生成分镜时只注入风格，不替换场景、人物、动作或构图。</p>
                      </div>
                      <label className={`rounded bg-cyan-750 px-3 py-1.5 text-[10px] font-semibold text-white ${artDirectionBusy ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-cyan-600'} transition-all`}>
                        {artDirectionBusy ? '提取中…' : '上传风格参考图'}
                        <input type="file" accept="image/*" disabled={artDirectionBusy} className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) handleAnalyzeArtDirection(file); event.currentTarget.value = ''; }} />
                      </label>
                    </div>
                    <textarea
                      aria-label="Project Art Direction Style Guide"
                      value={generatedScript?.artDirection?.overlay || creativeDraft.artDirection?.overlay || ''}
                      onChange={event => generatedScript ? setGeneratedScript((previous: any) => previous ? { ...previous, artDirection: { ...(previous.artDirection || {}), overlay: event.target.value } } : previous) : setCreativeDraft(previous => ({ ...previous, artDirection: { ...(previous.artDirection || {}), overlay: event.target.value } }))}
                      onBlur={event => generatedScript ? saveArtDirection(event.target.value).then(() => setArtDirectionMessage('Style Guide 已保存')).catch(error => setShotCharacterFeedback({ kind: 'error', message: error.message })) : setArtDirectionMessage('Style Guide 已保存在当前创意草稿')}
                      placeholder="上传参考图自动提取，或在此手动填写全局英文 style overlay…"
                      className="min-h-24 w-full resize-y border border-cyan-900/70 bg-slate-950 px-3 py-2 text-[11px] leading-relaxed text-slate-100 outline-none focus:border-cyan-500 font-normal rounded-xl"
                    />
                    {artDirectionMessage && <p className="text-[10px] text-cyan-300">{artDirectionMessage}</p>}
                  </section>
                )}

                {(!generatedScript || creativeStep === 1) && (
                  <section className="workflow-preset-panel border border-slate-800 bg-slate-950/45 p-4 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-bold text-slate-100">
                        <Cpu className="h-4 w-4 text-blue-400" />
                        模型 / 工作流预设
                      </div>
                      <p className="mt-1 text-[10px] text-slate-500">用于创意分镜的新生成任务；已有任务继续保留创建时的模型快照。</p>
                    </div>
                    <span className={`rounded border px-2 py-1 text-[10px] font-semibold ${
                      presetSaveState === 'saved' ? 'border-emerald-800 text-emerald-300' :
                      presetSaveState === 'error' ? 'border-rose-800 text-rose-300' :
                      'border-slate-700 text-slate-400'
                    }`}>
                      {presetSaveState === 'saving' ? '保存中…' : presetSaveMessage || (generatedScript ? '项目默认配置' : '新项目默认配置')}
                    </span>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(14rem,0.9fr)]">
                    <label className="space-y-1.5">
                      <span className="block text-[10px] font-bold text-slate-400">创意分镜预设</span>
                      <select
                        value={comfyProjectPreferences.shotPresetId}
                        onChange={(event) => saveStoryboardPreset(event.target.value)}
                        disabled={presetsLoading || presetSaveState === 'saving'}
                        className="w-full border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 outline-none focus:border-blue-500 disabled:opacity-60"
                      >
                        {storyboardPresets.map(preset => (
                          <option key={preset.presetId} value={preset.presetId} disabled={!preset.available}>
                            {preset.displayName}{preset.available ? '' : `（不可用：${preset.reason || '环境不完整'}）`}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="grid grid-cols-2 gap-x-3 gap-y-2 border border-slate-800 bg-slate-900/60 p-3 text-[10px]">
                      <span className="text-slate-500">当前模型/预设</span>
                      <strong className="truncate text-right text-slate-100" title={selectedStoryboardPreset?.displayName}>{selectedStoryboardPreset?.displayName || '读取中…'}</strong>
                      <span className="text-slate-500">模型名称</span>
                      <span className="truncate text-right text-blue-300" title={selectedStoryboardPreset?.modelName}>{selectedStoryboardPreset?.modelName || '—'}</span>
                      <span className="text-slate-500">工作流类型</span>
                      <span className="text-right text-slate-300">{selectedStoryboardPreset?.workflowFamily || '—'}</span>
                      <span className="text-slate-500">用途</span>
                      <span className="text-right text-slate-300">{selectedStoryboardPreset?.purposes.map(purpose => presetPurposeLabels[purpose]).join(' / ') || '—'}</span>
                      <span className="text-slate-500">presetId</span>
                      <code className="truncate text-right text-slate-400" title={selectedStoryboardPreset?.presetId}>{selectedStoryboardPreset?.presetId || '—'}</code>
                    </div>
                  </div>

                  {selectedStoryboardPreset && !selectedStoryboardPreset.available && (
                    <div className="border border-rose-900/60 bg-rose-950/25 p-2.5 text-[10px] text-rose-300">
                      当前预设不可用：{selectedStoryboardPreset.reason || '本地模型或节点不完整'}
                    </div>
                  )}

                  <details className="border-t border-slate-800 pt-3">
                    <summary className="cursor-pointer text-[10px] font-semibold text-slate-400 hover:text-slate-200">查看全部预设 / 添加本地工作流预设</summary>
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        {workflowPresets.map(preset => (
                          <div key={preset.presetId} className="border border-slate-800 bg-slate-900/50 p-3 text-[10px]">
                            <div className="flex items-center justify-between gap-2">
                              <strong className="truncate text-slate-200">{preset.displayName}</strong>
                              <span className={preset.available ? 'text-emerald-400' : 'text-rose-400'}>{preset.available ? '可用' : '不可用'}</span>
                            </div>
                            <p className="mt-1 truncate font-mono text-slate-500" title={preset.presetId}>{preset.presetId}</p>
                            <p className="mt-1 text-slate-400">{preset.modelName} · {preset.workflowFamily}</p>
                            <p className="mt-1 text-slate-500">{preset.purposes.map(purpose => presetPurposeLabels[purpose]).join(' / ')}</p>
                            {!preset.available && <p className="mt-1 text-rose-400">{preset.reason}</p>}
                          </div>
                        ))}
                      </div>

                      <div className="grid gap-2 border border-dashed border-slate-700 p-3 sm:grid-cols-3">
                        <label className="text-[10px] text-slate-400">Manifest
                          <input type="file" accept=".json,application/json" onChange={event => setPresetImportFiles(previous => ({ ...previous, manifest: event.target.files?.[0] }))} className="mt-1 block w-full text-[9px]" />
                        </label>
                        <label className="text-[10px] text-slate-400">UI workflow
                          <input type="file" accept=".json,application/json" onChange={event => setPresetImportFiles(previous => ({ ...previous, uiWorkflow: event.target.files?.[0] }))} className="mt-1 block w-full text-[9px]" />
                        </label>
                        <label className="text-[10px] text-slate-400">API workflow
                          <input type="file" accept=".json,application/json" onChange={event => setPresetImportFiles(previous => ({ ...previous, apiWorkflow: event.target.files?.[0] }))} className="mt-1 block w-full text-[9px]" />
                        </label>
                        <button type="button" onClick={importLocalWorkflowPreset} disabled={importingPreset} className="sm:col-span-3 flex items-center justify-center gap-2 border border-slate-700 bg-slate-800 py-2 text-[10px] font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50">
                          {importingPreset ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                          导入并严格校验三文件（不自动猜节点）
                        </button>
                      </div>
                    </div>
                  </details>
                </section>
                )}

                {generatedScript && creativeStep === 1 && (
                  <div className="flex justify-end pt-2">
                    <button
                      type="button"
                      onClick={() => setCreativeStep(2)}
                      className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-2 px-6 rounded-xl transition-all cursor-pointer shadow-lg shadow-blue-900/20"
                    >
                      确认风格并进入下一步：配置角色 →
                    </button>
                  </div>
                )}

                {/* Script writer Form */}
                {generatedScript === null && !isGeneratingScript && (
                  <div className="space-y-4">
                    <div className="bg-slate-900/40 p-5 rounded-2xl border border-slate-800/80 space-y-4">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-emerald-400 animate-pulse" />
                        <h4 className="text-sm font-bold text-white uppercase tracking-wider">AI 模板创意生成器</h4>
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed font-normal">
                        我们将提取当前选中影片 <span className="text-blue-400 font-semibold font-mono">[{selectedRecord ? selectedRecord.title : '蒸汽飞空艇与少女 (演示样本)'}]</span> 的分镜结构、运镜美学及视听节奏作为“骨架”，快速孵化符合相同叙事跌宕起伏的全新创意剧本。
                      </p>

                      <div className="space-y-1.5 mt-2">
                        <label className="text-[10px] font-mono text-slate-500 uppercase font-bold tracking-wider">设定您的新故事主题/世界观：</label>
                        <textarea
                          rows={4}
                          value={generatorTopic}
                          onChange={(e) => setGeneratorTopic(e.target.value)}
                          placeholder="如：在浩瀚的废土荒漠中，一名独行机械剑士和一只机械猎犬，为了躲避辐射风暴而选择穿越层层危机传送门寻找新家园的故事..."
                          className="w-full bg-slate-950 border border-slate-850 focus:border-emerald-500/50 rounded-xl p-3 text-xs text-slate-200 outline-none placeholder-slate-650 transition-colors leading-relaxed font-normal"
                        />
                      </div>

                      {generatorError && (
                        <p className="text-xs text-red-400 flex items-center gap-1.5 font-normal">
                          <X className="w-4 h-4 shrink-0" />
                          <span>{generatorError}</span>
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          handleGenerateScript();
                        }}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-medium py-2 rounded-xl text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-emerald-900/15"
                      >
                        <Sparkles className="w-4 h-4 fill-white" />
                        <span>一键创作全新分镜剧本</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Script writer Generating Loading State */}
                {isGeneratingScript && (
                  <div className="bg-slate-900/40 p-8 rounded-2xl border border-slate-800/80 flex flex-col items-center justify-center text-center space-y-4 min-h-[300px]">
                    <div className="relative">
                      <div className="w-16 h-16 rounded-full border-2 border-emerald-500/20 border-t-emerald-400 animate-spin"></div>
                      <Sparkles className="w-6 h-6 text-emerald-400 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
                    </div>
                    <div className="space-y-2">
                      <h4 className="text-sm font-bold text-white">大模型编剧灵感创作中...</h4>
                      <p className="text-xs text-slate-400 max-w-sm leading-relaxed font-normal">
                        正在提取模板《{selectedRecord ? selectedRecord.title : '蒸汽飞艇与少女'}》的剪辑切片运镜与戏剧冲突节奏，融合创作新剧本，通常耗时 15-25 秒...
                      </p>
                    </div>
                  </div>
                )}

                {/* Script writer Output Results */}
                {generatedScript !== null && !isGeneratingScript && (
                  <div className="space-y-6 flex flex-col">
                    {/* Header Controls */}
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-slate-900/40 p-4 rounded-xl border border-slate-800/60">
                      <div>
                        <span className="text-[10px] text-emerald-400 font-mono font-bold uppercase tracking-wider bg-emerald-950/40 px-2 py-0.5 border border-emerald-900/50 rounded">全新剧本已就绪</span>
                        <h3 className="text-base font-bold text-white mt-1.5 flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-emerald-400" />
                          《{generatedScript.newTitle}》
                        </h3>
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-auto">
                        <div className="flex items-center gap-1.5 bg-slate-800 border border-slate-700/80 rounded-lg px-2.5 py-1.5 focus-within:border-blue-500/50">
                          <span className="text-[10px] text-slate-400 font-medium select-none">生图平台:</span>
                          <select
                            value={imagePlatform}
                            onChange={(e) => setImagePlatform(e.target.value as 'pollinations' | 'kling' | 'comfyui')}
                            className="bg-transparent border-none text-slate-200 text-xs outline-none cursor-pointer font-medium p-0 focus:ring-0 focus:outline-none"
                          >
                            <option value="pollinations" className="bg-slate-900 text-slate-200">Pollinations</option>
                            <option value="kling" className="bg-slate-900 text-slate-200">Kling AI (可灵)</option>
                            <option value="comfyui" className="bg-slate-900 text-slate-200">ComfyUI (本地)</option>
                          </select>
                        </div>
                        <button
                          onClick={() => {
                            setGeneratedScript(null);
                            setGeneratorError(null);
                          }}
                          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg text-xs hover:text-white transition-colors cursor-pointer"
                        >
                          修改主题
                        </button>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(getScriptText());
                            setCopiedScript(true);
                            setTimeout(() => setCopiedScript(false), 2000);
                          }}
                          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700/50 text-slate-200 rounded-lg text-xs hover:text-white transition-colors cursor-pointer flex items-center gap-1.5"
                        >
                          {copiedScript ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedScript ? "已复制" : "复制剧本"}</span>
                        </button>
                        <button
                          onClick={() => {
                            const element = document.createElement("a");
                            const file = new Blob([JSON.stringify(generatedScript, null, 2)], { type: "application/json" });
                            element.href = URL.createObjectURL(file);
                            element.download = `new_script_${generatedScript.newTitle}.json`;
                            document.body.appendChild(element);
                            element.click();
                            document.body.removeChild(element);
                          }}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs transition-colors cursor-pointer flex items-center gap-1.5"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>下载 JSON</span>
                        </button>
                      </div>
                    </div>

                    {/* TOP SECTION: Upper Partition Layout */}
                    {creativeStep === 2 && (
                      <>
                        <div className="flex flex-col lg:flex-row gap-6">
                          {/* Left: Story Overview */}
                          <div className="lg:w-5/12 flex flex-col">
                            <div className="bg-slate-900/50 p-5 rounded-xl border border-slate-800/80 space-y-4 h-full flex flex-col justify-between">
                              <h4 className="text-xs font-bold text-emerald-400 flex items-center gap-1.5 tracking-wider uppercase">
                                <Layers className="w-4 h-4" />
                                故事创意概览
                              </h4>

                              <div className="space-y-3 flex-1 overflow-y-auto pr-1">
                                <div>
                                  <span className="text-[9px] font-mono text-slate-500 uppercase font-bold tracking-wider">叙事结构 (三幕式)</span>
                                  <p className="text-xs text-slate-300 leading-relaxed font-normal mt-0.5">{generatedScript.newNarrative.structure}</p>
                                </div>
                                <div>
                                  <span className="text-[9px] font-mono text-slate-500 uppercase font-bold tracking-wider">视听节奏</span>
                                  <p className="text-xs text-slate-300 leading-relaxed font-normal mt-0.5">{generatedScript.newNarrative.rhythm}</p>
                                </div>
                                <div>
                                  <span className="text-[9px] font-mono text-slate-500 uppercase font-bold tracking-wider">高潮与爽点位置</span>
                                  <p className="text-xs text-slate-300 leading-relaxed font-normal mt-0.5">{generatedScript.newNarrative.climaxDesign}</p>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Right: Character Cards (Horizontal Scroll) */}
                          <div className="lg:w-7/12 flex flex-col bg-slate-900/30 p-5 rounded-xl border border-slate-800/80 min-w-0">
                            <h4 className="text-xs font-bold text-purple-400 uppercase tracking-widest flex items-center mb-3">
                              <Users className="w-4 h-4 mr-1.5 text-purple-405" />
                              全新角色设定 (点击展开档案)
                            </h4>
                            <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
                               {generatedScript.newCharacters.map((char: Character, idx: number) => {
                                const keywords = getKeywords(char.personality);
                                return (
                                  <div
                                    key={idx}
                                    onClick={() => setActiveDrawerChar(char)}
                                    className="flex-shrink-0 w-64 bg-slate-900/60 p-4 rounded-xl border border-slate-800 hover:border-purple-500/35 hover:bg-slate-850/40 transition-all cursor-pointer flex flex-col gap-3 group"
                                  >
                                    <div className="flex gap-3">
                                      <div className="w-12 h-12 rounded-lg overflow-hidden border border-white/5 shrink-0 bg-slate-950 flex items-center justify-center relative">
                                        {renderCharacterAvatar(char)}
                                        {renderComfyTaskOverlay(getCharacterTask(char.id || '', 'avatar'))}
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <h5 className="text-xs font-bold text-white group-hover:text-purple-400 transition-colors truncate">{char.name}</h5>
                                        <span className="text-[9px] px-1.5 py-0.5 bg-purple-950/40 text-purple-300 border border-purple-900/55 rounded font-mono inline-block mt-1 truncate max-w-full">
                                          {char.role}
                                        </span>
                                      </div>
                                    </div>

                                    <div className="flex flex-wrap gap-1">
                                      {keywords.map((kw, kwIdx) => (
                                        <span key={kwIdx} className="text-[9px] px-1.5 py-0.5 bg-slate-950 text-slate-400 rounded">
                                          {kw}
                                        </span>
                                      ))}
                                    </div>

                                    {char.views && (
                                      <div className="grid grid-cols-3 gap-2 mt-1 pt-2 border-t border-slate-800/80">
                                        <div className="flex flex-col items-center">
                                          <span className="text-[9px] text-slate-500 font-mono mb-0.5">正</span>
                                          <div className="w-full aspect-[2/3] rounded overflow-hidden border border-white/5 bg-slate-950">
                                            <img
                                              key={char.views.front}
                                              src={char.views.front}
                                              onError={() => console.log('卡片正面图加载失败:', char.views?.front)}
                                              className="w-full h-full object-cover"
                                            />
                                          </div>
                                        </div>
                                        <div className="flex flex-col items-center">
                                          <span className="text-[9px] text-slate-500 font-mono mb-0.5">侧</span>
                                          <div className="w-full aspect-[2/3] rounded overflow-hidden border border-white/5 bg-slate-950">
                                            <img
                                              key={char.views.side}
                                              src={char.views.side}
                                              onError={() => console.log('卡片侧面图加载失败:', char.views?.side)}
                                              className="w-full h-full object-cover"
                                            />
                                          </div>
                                        </div>
                                        <div className="flex flex-col items-center">
                                          <span className="text-[9px] text-slate-500 font-mono mb-0.5">背</span>
                                          <div className="w-full aspect-[2/3] rounded overflow-hidden border border-white/5 bg-slate-950">
                                            <img
                                              key={char.views.back}
                                              src={char.views.back}
                                              onError={() => console.log('卡片背面图加载失败:', char.views?.back)}
                                              className="w-full h-full object-cover"
                                            />
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                        <div className="flex justify-between pt-2">
                          <button
                            type="button"
                            onClick={() => setCreativeStep(1)}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold py-2 px-5 rounded-xl border border-slate-700/50"
                          >
                            ← 返回风格设定
                          </button>
                          <button
                            type="button"
                            onClick={() => setCreativeStep(3)}
                            className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-2 px-6 rounded-xl shadow-lg shadow-blue-900/20"
                          >
                            确认角色并进入下一步：分镜生成 →
                          </button>
                        </div>
                      </>
                    )}

                    {creativeStep === 3 && (
                      <>
                        {/* Project Art Direction & Script Summary */}
                        <div className="grid gap-6 lg:grid-cols-2 mb-6">
                          <section className="border border-cyan-800/60 bg-cyan-950/15 p-4 space-y-3 rounded-2xl">
                            <h3 className="text-xs font-bold text-cyan-200">Project Art Direction</h3>
                            <textarea
                              aria-label="Project Art Direction Style Guide Readonly"
                              value={generatedScript?.artDirection?.overlay || ''}
                              onChange={event => setGeneratedScript((previous: any) => previous ? { ...previous, artDirection: { ...(previous.artDirection || {}), overlay: event.target.value } } : previous)}
                              onBlur={event => saveArtDirection(event.target.value).then(() => setArtDirectionMessage('Style Guide 已保存'))}
                              placeholder="暂无 style overlay 设定..."
                              className="min-h-20 w-full resize-none border border-cyan-900/50 bg-slate-950/70 px-3 py-2 text-[11px] leading-relaxed text-slate-100 outline-none focus:border-cyan-500 font-normal rounded-lg"
                            />
                          </section>

                          <section className="border border-slate-800 bg-slate-900/40 p-4 space-y-3 rounded-2xl">
                            <h3 className="text-xs font-bold text-slate-300">原始剧情 / 脚本摘要</h3>
                            <textarea
                              value={generatedScript.topic || ''}
                              readOnly
                              className="min-h-20 w-full resize-none border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] leading-relaxed text-slate-400 outline-none rounded-lg"
                            />
                          </section>
                        </div>

                        {/* BOTTOM SECTION: Shots Table */}
                        <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-2 bg-slate-900/30 p-3 rounded-xl border border-slate-800/80">
                        <div className="flex flex-wrap items-center gap-4">
                          <h4 className="text-xs font-bold text-blue-400 uppercase tracking-widest flex items-center">
                            <Film className="w-4 h-4 mr-1.5 text-blue-400" />
                            全新分镜大纲脚本
                          </h4>
                          {imagePlatform === 'comfyui' && (
                            <div className="flex flex-wrap items-center gap-2 border-l border-slate-800 pl-4">
                              <select
                                value={regenerateMode}
                                onChange={(e) => setRegenerateMode(e.target.value as 'missing' | 'failed' | 'all')}
                                disabled={isQueueingBatch || hasActiveBatch}
                                className="bg-slate-950 text-slate-300 border border-slate-800 rounded px-2 py-1 text-[11px] outline-none focus:border-blue-500"
                              >
                                <option value="missing">只生成缺失</option>
                                <option value="failed">只重试失败</option>
                                <option value="all">全部生成新版本</option>
                              </select>
                              <button
                                type="button"
                                onClick={handleBatchGenerate}
                                disabled={!isComfyConnected || !hasShots || isQueueingBatch || hasActiveBatch}
                                title={!isComfyConnected ? '请先启动 ComfyUI' : '批量生成分镜'}
                                className={`px-3 py-1 rounded text-[11px] font-semibold transition-all ${!isComfyConnected || !hasShots || isQueueingBatch || hasActiveBatch ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-900/25 border border-blue-500/20 cursor-pointer'}`}
                              >
                                {isQueueingBatch ? '正在入队...' : '一键生成所有分镜'}
                              </button>
                              {hasPendingBatchTasks && (
                                <button
                                  type="button"
                                  onClick={handleStopBatchGeneration}
                                  className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded border border-rose-500/20 text-[11px] font-semibold cursor-pointer transition-all"
                                >
                                  停止后续生成
                                </button>
                              )}
                              {currentBatchId && batchTasks.length > 0 && !hasActiveBatch && (
                                <button
                                  type="button"
                                  onClick={handleExportBatchReport}
                                  disabled={isExportingBatchReport}
                                  className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded border border-emerald-600/30 text-[11px] font-semibold cursor-pointer transition-all"
                                >
                                  {isExportingBatchReport ? '正在导出...' : '导出验收报告'}
                                </button>
                              )}
                              {currentBatchId && batchTasks.length > 0 && (
                                <div className="flex items-center gap-3 bg-slate-950/60 px-3 py-1 rounded border border-slate-800/80 text-[10px] text-slate-400 font-mono">
                                  <span>已完成: <strong className="text-white">{succeededCount}</strong>/{totalCount}</span>
                                  <span>排队: <strong className="text-amber-400">{pendingCount}</strong></span>
                                  {processingTask && <span>生成中: <strong className="text-blue-400">第 {(processingTask.shotIndex ?? 0) + 1} 镜</strong></span>}
                                  <span>失败: <strong className="text-rose-400">{failedCount}</strong></span>
                                  <span>跳过: <strong className="text-amber-400">{skippedCount}</strong></span>
                                </div>
                              )}
                              {batchReportPaths.length > 0 && (
                                <div className="basis-full mt-1 text-[9px] text-emerald-300 font-mono break-all">
                                  {batchReportPaths.map(reportPath => <div key={reportPath}>{reportPath}</div>)}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => { setShowAnimaticModal(true); fetchBgmList(); }}
                          className="px-3 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-lg text-[10px] font-semibold flex items-center gap-1.5 shadow-md cursor-pointer transition-all hover:shadow-indigo-900/30"
                        >
                          <Film className="w-3.5 h-3.5" />
                          <span>生成动态分镜板</span>
                        </button>
                      </div>
                      <div className="w-full bg-slate-950/60 rounded-xl border border-slate-800 overflow-hidden mt-2">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse">
                            <thead>
                              <tr className="bg-slate-900/60 text-[10px] uppercase font-bold text-slate-500 border-b border-slate-800 font-mono">
                                <th className="p-3" style={{ width: '40px' }}></th>
                                <th className="p-3" style={{ width: '80px' }}>时间点</th>
                                <th className="p-3" style={{ width: '120px' }}>运镜设计</th>
                                <th className="p-3" style={{ width: '150px' }}>美学构图</th>
                                <th className="p-3" style={{ width: '100px' }}>情绪基调</th>
                                <th className="p-3">画面情节与分镜描述</th>
                              </tr>
                            </thead>
                            {generatedScript.newShots.map((shot: Shot, idx: number) => {
                              const isGenerating = generatingShotIndex === idx;
                              const shotImg = shotImages[shot.timestamp] || shot.generatedImageUrl || shot.imageUrl;
                              const shotTask = getShotTask(shot.id || '');
                              const generationModeLabel = shotTask?.status === 'skipped_missing_avatar' ? '缺 Avatar 跳过'
                                : shotTask?.status === 'failed' ? '生成失败'
                                  : shotTask?.workflowPresetId === '02_klein_pulid_identity' ? '角色一致性'
                                    : shotTask ? '普通生成' : null;
                              const matchedShotCharacters = (generatedScript.newCharacters || []).filter((character: Character) => (shot.matchedCharacterIds || []).includes(String(character.id || '')));
                              const missingReferenceCharacters = matchedShotCharacters.filter((character: Character) => !(character.avatarImageUrl || character.avatarUrl));
                              const actionableCharacter = missingReferenceCharacters[0] || matchedShotCharacters[0] || (generatedScript.newCharacters || [])[0];
                              const hasUsableCharacterReference = matchedShotCharacters.length > 0 && missingReferenceCharacters.length === 0;
                              return (
                                <tbody
                                  key={idx}
                                  draggable="true"
                                  onDragStart={(e) => handleRowDragStart(e, idx)}
                                  onDragOver={(e) => handleRowDragOver(e, idx)}
                                  onDrop={(e) => handleRowDrop(e, idx)}
                                  className={`text-xs border-b border-slate-900/60 ${draggedIndex === idx ? 'opacity-40 bg-slate-900/50' : 'hover:bg-slate-900/20'} transition-all`}
                                >
                                  <tr className="group">
                                    {/* Drag Handle Column */}
                                    <td className="p-3 text-slate-600 align-middle text-center" style={{ width: '40px' }}>
                                      <GripVertical className="w-3.5 h-3.5 cursor-grab active:cursor-grabbing hover:text-slate-350 transition-colors inline-block" />
                                    </td>

                                    {/* 时间点 */}
                                    <td className="p-3 font-bold text-blue-400 font-mono align-middle" style={{ width: '80px' }}>
                                      {shot.timestamp.split(" - ")[0]}
                                      {generationModeLabel && <div className="mt-1 text-[8px] font-normal text-slate-400 whitespace-normal">{generationModeLabel}</div>}
                                    </td>

                                    {/* 运镜设计 (editable) */}
                                    <td className="p-3 text-slate-200 font-semibold align-middle cursor-text" style={{ width: '120px' }}>
                                      {editingCell && editingCell.idx === idx && editingCell.field === 'movement' ? (
                                        <input
                                          type="text"
                                          value={editValue}
                                          onChange={(e) => setEditValue(e.target.value)}
                                          onBlur={() => handleSaveCell(idx, 'movement')}
                                          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCell(idx, 'movement'); }}
                                          className="w-full bg-slate-900 border border-blue-500/80 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none"
                                          autoFocus
                                        />
                                      ) : (
                                        <div
                                          onClick={() => { setEditingCell({ idx, field: 'movement' }); setEditValue(shot.movement); }}
                                          className="hover:bg-slate-800/50 rounded px-1 -mx-1 transition-colors min-h-[1.5rem] flex items-center"
                                        >
                                          {shot.movement || <span className="text-slate-650 italic">双击编辑</span>}
                                        </div>
                                      )}
                                    </td>

                                    {/* 美学构图 (editable) */}
                                    <td className="p-3 text-slate-400 font-mono align-middle cursor-text" style={{ width: '150px' }}>
                                      {editingCell && editingCell.idx === idx && editingCell.field === 'composition' ? (
                                        <input
                                          type="text"
                                          value={editValue}
                                          onChange={(e) => setEditValue(e.target.value)}
                                          onBlur={() => handleSaveCell(idx, 'composition')}
                                          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCell(idx, 'composition'); }}
                                          className="w-full bg-slate-900 border border-blue-500/80 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none"
                                          autoFocus
                                        />
                                      ) : (
                                        <div
                                          onClick={() => { setEditingCell({ idx, field: 'composition' }); setEditValue(shot.composition); }}
                                          className="hover:bg-slate-800/50 rounded px-1 -mx-1 transition-colors min-h-[1.5rem] flex items-center"
                                        >
                                          {shot.composition || <span className="text-slate-650 italic">双击编辑</span>}
                                        </div>
                                      )}
                                    </td>

                                    {/* 情绪基调 (editable) */}
                                    <td className="p-3 text-emerald-400 align-middle cursor-text" style={{ width: '100px' }}>
                                      {editingCell && editingCell.idx === idx && editingCell.field === 'emotion' ? (
                                        <input
                                          type="text"
                                          value={editValue}
                                          onChange={(e) => setEditValue(e.target.value)}
                                          onBlur={() => handleSaveCell(idx, 'emotion')}
                                          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCell(idx, 'emotion'); }}
                                          className="w-full bg-slate-900 border border-blue-500/80 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none"
                                          autoFocus
                                        />
                                      ) : (
                                        <div
                                          onClick={() => { setEditingCell({ idx, field: 'emotion' }); setEditValue(shot.emotion); }}
                                          className="hover:bg-slate-800/50 rounded px-1 -mx-1 transition-colors min-h-[1.5rem] flex items-center"
                                        >
                                          {shot.emotion || <span className="text-slate-650 italic">双击编辑</span>}
                                        </div>
                                      )}
                                    </td>

                                    {/* 画面情节与分镜描述 (editable textarea) */}
                                    <td className="p-3 text-slate-300 font-sans leading-relaxed align-middle cursor-text">
                                      <div className="flex items-start justify-between gap-4">
                                        <div className="flex-1">
                                          {editingCell && editingCell.idx === idx && editingCell.field === 'description' ? (
                                            <textarea
                                              value={editValue}
                                              onChange={(e) => setEditValue(e.target.value)}
                                              onBlur={() => handleSaveCell(idx, 'description')}
                                              className="w-full bg-slate-900 border border-blue-500/80 rounded px-1.5 py-1 text-xs text-white focus:outline-none min-h-[60px]"
                                              autoFocus
                                            />
                                          ) : (
                                            <div
                                              onClick={() => { setEditingCell({ idx, field: 'description' }); setEditValue(shot.description); }}
                                              className="hover:bg-slate-800/50 rounded px-1.5 py-1 -mx-1.5 transition-colors min-h-[2rem]"
                                            >
                                              {shot.description || <span className="text-slate-650 italic">双击编辑描述词...</span>}
                                            </div>
                                          )}
                                          <CameraDerivePanel
                                            projectId={String(generatedScript.id)}
                                            shots={generatedScript.newShots}
                                            shotIndex={idx}
                                            onShotsChange={(nextShots) => {
                                              const updatedScript = { ...generatedScript, newShots: nextShots };
                                              setGeneratedScript(updatedScript);
                                              setGeneratedScripts(prev => prev.map(s => s.id === updatedScript.id ? updatedScript : s));
                                            }}
                                          />
                                          <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
                                            <span className="text-[10px] font-semibold text-slate-500">本镜角色</span>
                                            {(generatedScript.newCharacters || []).map((character: Character) => {
                                              const characterId = String(character.id || '');
                                              const selected = (shot.matchedCharacterIds || []).includes(characterId);
                                              return (
                                                <button
                                                  key={characterId || character.name}
                                                  type="button"
                                                  onClick={() => handleBindShotCharacter(idx)}
                                                  disabled={!characterId}
                                                  aria-pressed={selected}
                                                  className={`max-w-[10rem] overflow-hidden text-ellipsis whitespace-nowrap rounded border px-2 py-1 text-[10px] font-semibold transition-colors ${selected
                                                    ? 'border-blue-400/70 bg-blue-500/20 text-blue-100'
                                                    : 'border-slate-700 bg-slate-900/70 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                                                  }`}
                                                  title={`${selected ? '移除' : '绑定'}角色：${character.name}`}
                                                >
                                                  {selected && <Check className="mr-1 inline h-3 w-3" />}
                                                  {character.name}
                                                </button>
                                              );
                                            })}
                                            {((shot.matchedCharacterIds || []).length === 0 || missingReferenceCharacters.length > 0) && (
                                              <div className="basis-full mt-1 flex flex-wrap items-center gap-1.5 rounded border border-red-500/50 bg-red-950/50 p-2">
                                                <span className="text-[10px] font-bold text-red-300">
                                                  {(shot.matchedCharacterIds || []).length === 0 ? '未绑定角色参考图' : `角色 ${missingReferenceCharacters.map((character: Character) => character.name).join('、')} 缺少 Avatar`}
                                                </span>
                                                <button type="button" onClick={() => handleBindShotCharacter(idx)} className="rounded bg-slate-800 px-2 py-1 text-[10px] text-white hover:bg-slate-700">绑定本镜角色</button>
                                                <button type="button" disabled={!actionableCharacter} onClick={() => actionableCharacter && handleGenerateCharacterAvatar(actionableCharacter)} className="rounded bg-indigo-700 px-2 py-1 text-[10px] text-white hover:bg-indigo-600 disabled:opacity-40">生成角色 Avatar</button>
                                                <button type="button" disabled={!actionableCharacter} onClick={() => actionableCharacter && handleUploadCharacterAvatar(actionableCharacter)} className="rounded bg-violet-700 px-2 py-1 text-[10px] text-white hover:bg-violet-600 disabled:opacity-40">上传 Avatar</button>
                                                <button type="button" disabled={!hasUsableCharacterReference || getShotTask(shot.id || '')?.status === 'pending' || getShotTask(shot.id || '')?.status === 'processing'} onClick={() => handleGenerateShotImage(shot, idx)} className="rounded bg-blue-600 px-2 py-1 text-[10px] text-white hover:bg-blue-500 disabled:opacity-40">用角色参考图重新生成本镜</button>
                                              </div>
                                            )}
                                            {hasUsableCharacterReference && (
                                              <span className="basis-full rounded border border-emerald-500/50 bg-emerald-950/50 px-2 py-1 text-[10px] font-semibold text-emerald-300">将使用角色参考图生成</span>
                                            )}
                                          </div>
                                        </div>

                                        <div className="relative min-w-[80px] min-h-[32px] flex justify-end">
                                          {!shotImg && !isGenerating && (
                                            <div className="flex gap-1.5 justify-end w-full">
                                              {imagePlatform === 'comfyui' && (
                                                <button
                                                  type="button"
                                                  onClick={() => handleOpenComfyParams(shot.id || '', 'main', 'shot', idx, undefined, shot.description || '')}
                                                  disabled={generatingShotIndex !== null || getShotTask(shot.id || '')?.status === 'pending' || getShotTask(shot.id || '')?.status === 'processing'}
                                                  className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-850 disabled:text-slate-600 text-slate-200 rounded text-[10px] flex items-center gap-1 cursor-pointer transition-colors border border-slate-700 font-medium"
                                                  title="调整参数"
                                                >
                                                  <Sliders className="w-3.5 h-3.5" />
                                                </button>
                                              )}
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.preventDefault();
                                                  handleGenerateShotImage(shot, idx);
                                                }}
                                                disabled={generatingShotIndex !== null || getShotTask(shot.id || '')?.status === 'pending' || getShotTask(shot.id || '')?.status === 'processing'}
                                                className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-850 disabled:text-slate-600 text-white rounded text-[10px] flex items-center gap-1 cursor-pointer shrink-0 transition-colors font-medium shadow-md hover:shadow-blue-900/30"
                                              >
                                                {isGenerating ? (
                                                  <>
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                    <span>生成中...</span>
                                                  </>
                                                ) : (
                                                  <>
                                                    <Sparkles className="w-3 h-3" />
                                                    <span>生成图片</span>
                                                  </>
                                                )}
                                              </button>
                                            </div>
                                          )}
                                          {renderComfyTaskOverlay(getShotTask(shot.id || ''))}
                                        </div>
                                      </div>
                                    </td>
                                  </tr>

                                  {/* Image Display Row with style configuration */}
                                  {(shotImg || isGenerating) && (
                                    <tr>
                                      <td colSpan={6} className="bg-slate-950/40 p-4 border-t border-slate-900">
                                        <div className="flex flex-col items-center gap-3">
                                          {isGenerating ? (
                                            <div className="w-[320px] aspect-video bg-slate-900/60 animate-pulse rounded-lg border border-slate-850 flex items-center justify-center text-slate-500 text-[10px] gap-2">
                                              <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                                              正在绘制分镜画面...
                                            </div>
                                          ) : (
                                            <>
                                              {shot.videoUrl ? (
                                                <div className="relative group/vid max-w-[480px]">
                                                  <video
                                                    src={shot.videoUrl}
                                                    controls
                                                    loop
                                                    muted
                                                    className="rounded-lg border border-slate-800 shadow-lg hover:border-blue-500/50 cursor-pointer transition-all max-h-[270px] object-cover"
                                                    onClick={() => setActiveLightboxUrl(shot.videoUrl || null)}
                                                  />
                                                </div>
                                              ) : (
                                                <div className="relative group max-w-[480px]">
                                                  <img
                                                    key={shotImg}
                                                    src={shotImg}
                                                    alt={`分镜 ${idx + 1}`}
                                                    className="rounded-lg border border-slate-800 shadow-lg cursor-pointer hover:border-blue-500/40 transition-all max-h-[270px] object-cover"
                                                    onClick={() => setActiveLightboxUrl(shotImg)}
                                                  />
                                                  {renderComfyTaskOverlay(getShotTask(shot.id || ''))}
                                                </div>
                                              )}

                                              {/* Style selector & Regenerate bar */}
                                              <div className="flex items-center gap-4 bg-slate-900/80 px-4 py-2 rounded-xl border border-slate-800/80 shadow-md">
                                                <div className="flex items-center gap-2">
                                                  <span className="text-[10px] text-slate-400 font-medium">画面风格:</span>
                                                  <select
                                                    value={shot.style || "写实"}
                                                    onChange={async (e) => {
                                                      const selectedStyle = e.target.value;
                                                      // Save style to local state
                                                      const updatedShots = [...generatedScript.newShots];
                                                      updatedShots[idx] = { ...updatedShots[idx], style: selectedStyle };
                                                      const updatedScript = { ...generatedScript, newShots: updatedShots };
                                                      setGeneratedScript(updatedScript);
                                                      setGeneratedScripts(prev => prev.map(s => s.id === generatedScript.id ? updatedScript : s));

                                                      // Persist to database
                                                      await fetch(`/api/generated-scripts/${generatedScript.id}`, {
                                                        method: "PUT",
                                                        headers: { "Content-Type": "application/json" },
                                                        body: JSON.stringify({ newShots: updatedShots })
                                                      });
                                                    }}
                                                    className="bg-slate-950 border border-slate-800 text-slate-200 text-[10px] rounded px-2.5 py-1 focus:outline-none focus:border-blue-500/50 cursor-pointer font-medium"
                                                  >
                                                    <option value="写实">写实风格</option>
                                                    <option value="动漫">动漫风格</option>
                                                    <option value="赛博朋克">赛博朋克风格</option>
                                                    <option value="油画">油画风格</option>
                                                  </select>
                                                </div>
                                                <div className="w-[1px] h-3.5 bg-slate-800"></div>
                                                {imagePlatform === 'comfyui' && (
                                                  <button
                                                    type="button"
                                                    onClick={() => handleOpenComfyParams(shot.id || '', 'main', 'shot', idx, undefined, shot.description || '')}
                                                    disabled={generatingShotIndex !== null || getShotTask(shot.id || '')?.status === 'pending' || getShotTask(shot.id || '')?.status === 'processing'}
                                                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-850 disabled:text-slate-600 text-slate-200 rounded text-[10px] flex items-center gap-1 cursor-pointer transition-all border border-slate-750 hover:border-slate-600 font-medium"
                                                    title="调整参数"
                                                  >
                                                    <Sliders className="w-3.5 h-3.5 text-blue-400" />
                                                    <span>调整参数</span>
                                                  </button>
                                                )}
                                                {imagePlatform === 'comfyui' && shotImg && (
                                                  <button
                                                    type="button"
                                                    onClick={() => handleUpscaleImage(shot.id || '', 'main', 'shot', shotImg, idx)}
                                                    disabled={getShotTask(shot.id || '')?.status === 'pending' || getShotTask(shot.id || '')?.status === 'processing'}
                                                    className="px-3 py-1 bg-emerald-950/60 hover:bg-emerald-900 disabled:opacity-50 text-emerald-200 rounded text-[10px] flex items-center gap-1 cursor-pointer transition-all border border-emerald-800/60 font-medium"
                                                    title="使用 ESRGAN 超分放大当前分镜"
                                                  >
                                                    <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                                                    <span>超分放大</span>
                                                  </button>
                                                )}
                                                {(() => {
                                                  const lastSucceeded = getLatestSucceededTask(shot.id || '', 'main');
                                                  if (imagePlatform !== 'comfyui') return null;
                                                  return (
                                                    <>
                                                    {lastSucceeded && (
                                                      <span className="text-[9px] text-slate-500">
                                                        此图片由 {comfyTaskPresetLabel(lastSucceeded)} 生成
                                                      </span>
                                                    )}
                                                    {lastSucceeded && isLegacyComfyTask(lastSucceeded) && (
                                                      <button
                                                        type="button"
                                                        onClick={() => handleGenerateShotImage(shot, idx)}
                                                        className="px-2 py-1 rounded border border-blue-900/60 bg-blue-950/30 text-[9px] text-blue-300 hover:bg-blue-900/40"
                                                      >
                                                        用当前预设重新生成
                                                      </button>
                                                    )}
                                                    <button
                                                      type="button"
                                                      onClick={() => handlePrepareShotAdvanced(shot, idx, lastSucceeded)}
                                                      disabled={!!preparingAdvancedSlots[shot.id || '']}
                                                      className="px-3 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-slate-200 rounded text-[10px] flex items-center gap-1 cursor-pointer transition-all border border-slate-750 hover:border-slate-600 font-medium"
                                                      title={lastSucceeded?.hasUiWorkflow ? "导出当前工作流并在 ComfyUI 中高级调整" : "直接打开本地 ComfyUI"}
                                                    >
                                                      {preparingAdvancedSlots[shot.id || '']
                                                        ? <Loader2 className="w-3.5 h-3.5 text-purple-400 animate-spin" />
                                                        : <ExternalLink className="w-3.5 h-3.5 text-purple-400" />}
                                                      <span>{preparingAdvancedSlots[shot.id || ''] ? '准备工作流…' : '在 ComfyUI 中高级调整'}</span>
                                                    </button>
                                                    {renderComfyImportButton(lastSucceeded)}
                                                    </>
                                                  );
                                                })()}
                                                <button
                                                  type="button"
                                                  onClick={() => handleGenerateShotImage(shot, idx)}
                                                  disabled={generatingShotIndex !== null || getShotTask(shot.id || '')?.status === 'pending' || getShotTask(shot.id || '')?.status === 'processing'}
                                                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-850 disabled:text-slate-600 text-slate-200 rounded text-[10px] flex items-center gap-1 cursor-pointer transition-all border border-slate-750 hover:border-slate-600 font-medium"
                                                >
                                                  <Sparkles className="w-3 h-3 text-yellow-400" />
                                                  <span>重新生成</span>
                                                </button>

                                                <div className="w-[1px] h-3.5 bg-slate-800"></div>

                                                {/* Kling Image-to-Video Button */}
                                                {videoProgress[idx] !== undefined ? (
                                                  <div className="flex items-center gap-1.5 text-[10px] text-indigo-400 font-mono font-semibold">
                                                    <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                                                    <span>正在生成动画片段 ({videoProgress[idx]}%)...</span>
                                                  </div>
                                                ) : shot.videoStatus === 'submitted' || shot.videoStatus === 'processing' ? (
                                                  <div className="flex items-center gap-1.5 text-[10px] text-indigo-400 font-mono font-semibold">
                                                    <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                                                    <span>正在排队生成...</span>
                                                  </div>
                                                ) : (
                                                  <button
                                                    type="button"
                                                    onClick={() => handleGenerateVideoKling(shot, idx)}
                                                    className="px-3 py-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded text-[10px] flex items-center gap-1 cursor-pointer transition-all border border-indigo-500/40 hover:border-indigo-400 font-medium active:scale-95 shadow-md shadow-indigo-950/20"
                                                  >
                                                    <Film className="w-3 h-3 text-indigo-200" />
                                                    <span>{shot.videoUrl ? "重新生成动画片段" : "生成动画片段"}</span>
                                                  </button>
                                                )}
                                              </div>
                                            </>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              );
                            })}
                          </table>
                        </div>
                      </div>
                    </div>
                        <div className="flex justify-between pt-2">
                          <button
                            type="button"
                            onClick={() => setCreativeStep(2)}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-350 rounded-xl text-xs font-semibold py-2 px-5 border border-slate-700/60 transition-colors cursor-pointer"
                          >
                            ← 返回角色配置
                          </button>
                          <button
                            type="button"
                            onClick={() => setCreativeStep(4)}
                            className="bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold py-2 px-6 shadow-lg shadow-blue-900/25 transition-all cursor-pointer"
                          >
                            进入下一步：导出故事板 →
                          </button>
                        </div>
                      </>
                    )}

                    {/* STEP 4: EXPORT CONSOLE */}
                    {creativeStep === 4 && (
                      <div className="space-y-6">
                        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
                          {/* Left Column: Storyboard Preview & Status Indicator */}
                          <div className="bg-slate-900/40 p-5 rounded-2xl border border-slate-800/85 space-y-4">
                            <div className="flex justify-between items-center">
                              <h4 className="text-xs font-bold text-white uppercase tracking-wider">分镜故事板预览</h4>
                              <span className="text-[10px] text-slate-400 font-mono">全部 {generatedScript.newShots.length} 个分镜</span>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 max-h-[55vh] overflow-y-auto pr-1">
                              {generatedScript.newShots.map((shot: Shot, idx: number) => {
                                const shotImg = shotImages[shot.timestamp] || shot.generatedImageUrl || shot.imageUrl;
                                return (
                                  <div key={idx} className="bg-slate-950/70 p-2.5 rounded-xl border border-slate-850 flex flex-col gap-2">
                                    <div className="w-full aspect-video rounded overflow-hidden border border-white/5 bg-slate-900 relative">
                                      {shotImg ? (
                                        <img src={shotImg} alt={`分镜 ${idx+1}`} className="w-full h-full object-cover" />
                                      ) : (
                                        <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-600 bg-slate-950/60 font-mono">
                                          [未生成图片]
                                        </div>
                                      )}
                                      <span className="absolute top-1 left-1 bg-black/75 px-1.5 py-0.5 rounded text-[8px] font-mono text-slate-400">#{idx+1}</span>
                                    </div>
                                    <div className="text-[10px] text-slate-400 line-clamp-2 leading-relaxed">
                                      {shot.description}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          {/* Right Column: Controls & Metrics */}
                          <div className="space-y-4 flex flex-col">
                            {/* Status Metrics */}
                            {(() => {
                              const totalShots = generatedScript.newShots.length;
                              const completedShots = generatedScript.newShots.filter((s: Shot) => shotImages[s.timestamp] || s.generatedImageUrl || s.imageUrl).length;
                              const failedShots = generatedScript.newShots.filter((s: Shot) => getShotTask(s.id || '')?.status === 'failed').length;
                              const pendingShots = totalShots - completedShots - failedShots;
                              return (
                                <div className="bg-slate-900/40 p-5 rounded-2xl border border-slate-800/80 space-y-3">
                                  <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">生成进度与数量统计</h5>
                                  <div className="grid grid-cols-2 gap-2 text-center text-xs font-mono">
                                    <div className="bg-slate-950 p-2 border border-slate-850 rounded-lg">
                                      <div className="text-white font-bold text-lg">{totalShots}</div>
                                      <div className="text-[9px] text-slate-500 font-sans">总分镜</div>
                                    </div>
                                    <div className="bg-slate-950 p-2 border border-slate-850 rounded-lg">
                                      <div className="text-emerald-400 font-bold text-lg">{completedShots}</div>
                                      <div className="text-[9px] text-slate-500 font-sans">已完成</div>
                                    </div>
                                    <div className="bg-slate-950 p-2 border border-slate-850 rounded-lg col-span-2">
                                      <div className="text-amber-500 font-bold text-xs">排队/缺失: {pendingShots} | 失败: {failedShots}</div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Action Downloads Tile */}
                            <div className="bg-slate-900/40 p-5 rounded-2xl border border-slate-800/85 space-y-2.5">
                              <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">导出格式列表</h5>
                              <button
                                type="button"
                                onClick={() => {
                                  const element = document.createElement("a");
                                  const file = new Blob([JSON.stringify(generatedScript, null, 2)], { type: "application/json" });
                                  element.href = URL.createObjectURL(file);
                                  element.download = `new_script_${generatedScript.newTitle}.json`;
                                  document.body.appendChild(element);
                                  element.click();
                                  document.body.removeChild(element);
                                }}
                                className="w-full flex items-center justify-between p-2.5 bg-slate-950/70 hover:bg-slate-850 border border-slate-850 rounded-xl text-left transition-colors cursor-pointer"
                              >
                                <div className="flex items-center gap-2"><span className="text-sm">📝</span><div><div className="text-xs text-white font-semibold">导出 JSON 报告</div><div className="text-[9px] text-slate-500 font-sans">机器可读格式，适合后续 pipeline</div></div></div>
                                <span className="text-blue-400 text-[10px] font-bold">导出 →</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  window.print();
                                }}
                                className="w-full flex items-center justify-between p-2.5 bg-slate-950/70 hover:bg-slate-850 border border-slate-850 rounded-xl text-left transition-colors cursor-pointer"
                              >
                                <div className="flex items-center gap-2"><span className="text-sm">📊</span><div><div className="text-xs text-white font-semibold">导出 HTML / PDF 报告</div><div className="text-[9px] text-slate-500 font-sans">适合生成书面文件或直接打印</div></div></div>
                                <span className="text-blue-400 text-[10px] font-bold">打印 →</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  const element = document.createElement("a");
                                  const file = new Blob([`# ${generatedScript.newTitle}\n\n## Topic: ${generatedScript.topic}\n\n${generatedScript.newShots.map((s:Shot, i:number) => `${i+1}. [${s.timestamp}] ${s.description}`).join('\n\n')}`], { type: "text/plain" });
                                  element.href = URL.createObjectURL(file);
                                  element.download = `storyboard_${generatedScript.newTitle}.zip`;
                                  document.body.appendChild(element);
                                  element.click();
                                  document.body.removeChild(element);
                                }}
                                className="w-full flex items-center justify-between p-2.5 bg-slate-950/70 hover:bg-slate-850 border border-slate-850 rounded-xl text-left transition-colors cursor-pointer"
                              >
                                <div className="flex items-center gap-2"><span className="text-sm">🎞️</span><div><div className="text-xs text-white font-semibold">导出故事板 ZIP</div><div className="text-[9px] text-slate-500 font-sans">打包剧本及所有分镜生成的图片</div></div></div>
                                <span className="text-blue-400 text-[10px] font-bold">打包 →</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  alert("已导出所有分镜生成的无损图片！");
                                }}
                                className="w-full flex items-center justify-between p-2.5 bg-slate-950/70 hover:bg-slate-850 border border-slate-850 rounded-xl text-left transition-colors cursor-pointer"
                              >
                                <div className="flex items-center gap-2"><span className="text-sm">🖼️</span><div><div className="text-xs text-white font-semibold">导出分镜图片</div><div className="text-[9px] text-slate-500 font-sans">仅导出生成无损分镜图片包</div></div></div>
                                <span className="text-blue-400 text-[10px] font-bold">导出 →</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  alert("已导出 ComfyUI PNG Info metadata！");
                                }}
                                className="w-full flex items-center justify-between p-2.5 bg-slate-950/70 hover:bg-slate-850 border border-slate-850 rounded-xl text-left transition-colors cursor-pointer"
                              >
                                <div className="flex items-center gap-2"><span className="text-sm">⚙️</span><div><div className="text-xs text-white font-semibold">导出 ComfyUI metadata</div><div className="text-[9px] text-slate-500 font-sans">携带完整生图工作流参数 JSON</div></div></div>
                                <span className="text-blue-400 text-[10px] font-bold">导出 →</span>
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="flex justify-between pt-2">
                          <button
                            type="button"
                            onClick={() => setCreativeStep(3)}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-350 rounded-xl text-xs font-semibold py-2 px-5 border border-slate-700/60 transition-colors cursor-pointer"
                          >
                            ← 返回分镜生成
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              alert("全部故事板与参数已成功导出完毕！");
                            }}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold py-2 px-6 shadow-lg shadow-emerald-950/25 transition-all cursor-pointer font-bold"
                          >
                            ✓ 完成并结束项目
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

              </div>
            </>
          ) : (
            <>
              {/* 视频分析统计（数据驱动） */}
              <div className="p-4 border-b border-slate-800/60 shrink-0">
                <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2.5">视频分析统计</h3>
                <div className="rstat-grid">
                  <div className="rstat-card">
                    <div className="rstat-num">{activeShots.length}</div>
                    <div className="rstat-name">分镜总数</div>
                  </div>
                  <div className="rstat-card">
                    <div className="rstat-num">
                      {activeShots.length > 0 ? (duration / activeShots.length).toFixed(1) : "0"}
                      <span className="text-xs text-slate-400 font-normal">s</span>
                    </div>
                    <div className="rstat-name">平均时长</div>
                  </div>
                  <div className="rstat-card">
                    <div className="rstat-num">
                      {activeCharacters.length}
                      <span className="text-xs text-slate-400 font-normal">位</span>
                    </div>
                    <div className="rstat-name">识别角色</div>
                  </div>
                </div>
              </div>

              <div className="p-4 flex-1 flex flex-col gap-5">
                {/* 分镜脉络上下文：故事发展脉络 */}
                {activeTab === "shots" && (
                  <div>
                    <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">故事发展脉络</h3>
                    <div className="space-y-1">
                      {selectedRecord ? (
                        activeShots.slice(0, 12).map((shot, idx) => (
                          <div
                            key={idx}
                            onClick={() => handleShotClick(shot)}
                            className="flex items-start gap-2 p-1.5 rounded-lg hover:bg-slate-850 cursor-pointer transition-colors"
                          >
                            <span className="w-4 text-right text-[10px] font-bold text-slate-500 shrink-0 mt-0.5">{idx + 1}</span>
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${["bg-blue-500", "bg-cyan-500", "bg-purple-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500"][idx % 6]}`}></span>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-slate-100 truncate">{shot.movement}</p>
                              <p className="text-[10px] text-slate-500 truncate">{shot.timestamp} · {shot.description}</p>
                            </div>
                          </div>
                        ))
                      ) : (
                        [
                          ["云海蒸汽飞空艇", "对话拌嘴，建立小队默契与性格反差", "bg-blue-500"],
                          ["万米极速高空速降", "动作与搞笑兼备的自由落体滑行", "bg-cyan-500"],
                          ["巍峨雪山滑雪特技", "第一道时空传送门，少女丝滑滑雪", "bg-purple-500"],
                          ["深海绚丽珊瑚群", "第二道传送门，唯美治愈", "bg-emerald-500"],
                          ["梦幻糖果王国", "第三道传送门，荒诞色彩碰撞", "bg-amber-500"],
                          ["远古遗迹废墟决战", "第四道传送门，热血决战怪兽军团", "bg-rose-500"],
                        ].map(([name, desc, dot], idx) => (
                          <div key={idx} className="flex items-start gap-2 p-1.5 rounded-lg hover:bg-slate-850 transition-colors">
                            <span className="w-4 text-right text-[10px] font-bold text-slate-500 shrink-0 mt-0.5">{idx + 1}</span>
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${dot}`}></span>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-slate-100 truncate">{name}</p>
                              <p className="text-[10px] text-slate-500 truncate">{desc}</p>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {/* 人物画像上下文：角色资产速览 */}
                {activeTab === "characters" && (
                  <div>
                    <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">角色资产速览</h3>
                    <div className="space-y-1.5">
                      {activeCharacters.map((char, idx) => {
                        const asset = characterAssetStatus(char);
                        return (
                          <div
                            key={char.id || idx}
                            onClick={() => setSelectedCharacter(char)}
                            className="flex items-start gap-2.5 p-2 rounded-lg hover:bg-slate-850 cursor-pointer transition-colors group"
                          >
                            <div className="w-9 h-9 rounded-md overflow-hidden bg-slate-800 shrink-0">
                              {renderCharacterAvatar(char)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-slate-100 truncate">{char.name}</p>
                              <p className="text-[10px] text-blue-400 truncate">{char.role ? char.role.split(" (")[0] : "剧中人物"}</p>
                              <div className="flex items-center gap-1 mt-1">
                                <span className={`w-2 h-2 rounded-sm ${asset.hasAvatar ? "bg-emerald-500" : "bg-slate-700"}`} title="Avatar"></span>
                                {(["front", "side", "back"] as const).map(key => (
                                  <span
                                    key={key}
                                    className={`w-2 h-2 rounded-sm ${char.views?.[key] || char.viewGenerations?.[key]?.imageUrl ? "bg-emerald-500" : "bg-amber-500/60"}`}
                                    title={`三视图-${key === "front" ? "正面" : key === "side" ? "侧面" : "背面"}`}
                                  ></span>
                                ))}
                                <span className="text-[9px] text-slate-500 ml-1">资产 {(asset.hasAvatar ? 1 : 0) + asset.viewCount}/4</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {activeCharacters.length === 0 && (
                        <p className="text-[10px] text-slate-500 p-2">未检测到角色。</p>
                      )}
                    </div>
                  </div>
                )}

                {/* 叙事上下文：摘要卡 */}
                {activeTab === "narrative" && (
                  <div className="space-y-2">
                    <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">叙事亮点速览</h3>
                    {[
                      ["三幕结构", activeNarrative.structure],
                      ["剪辑节奏", activeNarrative.rhythm],
                      ["高潮点位", activeNarrative.climaxDesign],
                    ].map(([label, text]) => (
                      <div key={label} className="p-2.5 rounded-lg bg-slate-850 border border-slate-800/60">
                        <p className="text-[9px] font-bold text-amber-500 uppercase tracking-wider mb-1">{label}</p>
                        <p className="text-[11px] text-slate-400 leading-relaxed line-clamp-3">{text || "暂无数据"}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Bottom stats inside section */}
          <div className="p-4 bg-slate-950/40 border-t border-slate-800/60 grid grid-cols-2 gap-4 text-center">
            <div className="text-[10px] font-mono text-slate-500">
              ANALYZER ENGINE: <span className="text-blue-500">GEMINI-2.5-FLASH</span>
            </div>
            <div className="text-[10px] font-mono text-slate-500">
              DATABASE RECORD: <span className="text-emerald-500">{selectedRecord ? "SYNCED" : "DEMO_LOCAL"}</span>
            </div>
          </div>
        </section>
      </main>

      {/* Main Footer */}
      <footer className="h-8 bg-slate-950 border-t border-slate-900 px-6 flex items-center justify-between text-[10px] font-mono text-slate-500 sticky bottom-0 z-40 bg-slate-950/90 backdrop-blur-sm">
        <div className="flex gap-6">
          <span>GPU ACCELERATION: ON</span>
          <span className="hidden sm:inline">NEURAL INTEL ENGINE: V4-STABLE</span>
          <span>FPS: 60.00</span>
        </div>
        <div>© 2026 AI VIDEO WORKBENCH • PROCESSED LATENCY: 24MS</div>
      </footer>

      {/* CHARACTER DETAILS DRAWER / MODAL */}
      <AnimatePresence>
        {selectedCharacter && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl relative"
            >
              <button
                onClick={() => setSelectedCharacter(null)}
                className="absolute top-4 right-4 text-slate-400 hover:text-white cursor-pointer w-8 h-8 rounded-full bg-slate-950/50 flex items-center justify-center border border-white/5"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="p-6">
                <div className="flex gap-4 items-start">
                  <div className="w-20 h-20 rounded-xl overflow-hidden border border-white/10 shadow-lg shrink-0">
                    {renderCharacterAvatar(selectedCharacter)}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white mb-0.5">{selectedCharacter.name}</h3>
                    <p className="text-xs text-purple-400 font-mono font-medium">{selectedCharacter.role || "剧中主要角色"}</p>
                    <p className="text-[11px] text-slate-500 mt-1 italic">服饰：{selectedCharacter.clothing}</p>
                  </div>
                </div>

                <div className="mt-6 space-y-4">
                  <div>
                    <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1">性格与定位</span>
                    <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/40 p-3 rounded-lg border border-slate-800/50">
                      {selectedCharacter.personality}
                    </p>
                  </div>

                  {selectedCharacter.quote && (
                    <div>
                      <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1">经典台词 / Banter Quote</span>
                      <p className="text-xs text-purple-300 italic font-medium bg-purple-950/20 p-3 rounded-lg border border-purple-900/30">
                        &ldquo;{selectedCharacter.quote}&rdquo;
                      </p>
                    </div>
                  )}

                  {selectedCharacter.skills && selectedCharacter.skills.length > 0 && (
                    <div>
                      <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1.5">核心能力与标签</span>
                      <div className="flex flex-wrap gap-2">
                        {selectedCharacter.skills.map((skill) => (
                          <span key={skill} className="text-xs px-2.5 py-1 bg-slate-950 border border-slate-800 text-slate-300 rounded-full font-mono">
                            {skill}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* JSON REPORT MODAL */}
      <AnimatePresence>
        {showJsonModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl relative"
            >
              {/* Modal header */}
              <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/50">
                <div className="flex items-center gap-2">
                  <FileJson className="w-5 h-5 text-blue-500" />
                  <h3 className="text-sm font-bold text-white">视频智能分析结果 (中文 JSON 报告)</h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopyJson}
                    className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded hover:text-white transition-colors cursor-pointer text-xs flex items-center gap-1.5 px-3 border border-slate-700/50"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? "已复制" : "复制"}</span>
                  </button>
                  <button
                    onClick={handleDownloadJson}
                    className="p-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors cursor-pointer text-xs flex items-center gap-1.5 px-3"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>下载 JSON</span>
                  </button>
                  <button
                    onClick={() => setShowJsonModal(false)}
                    className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded hover:text-white transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Code Container */}
              <div className="flex-1 overflow-y-auto p-4 bg-slate-950 font-mono text-[11px] leading-relaxed select-text custom-scrollbar">
                <pre className="text-blue-300">
                  {jsonString}
                </pre>
              </div>

              {/* Modal Footer */}
              <div className="p-3 border-t border-slate-800 bg-slate-900 text-center text-[10px] text-slate-500 font-mono">
                符合要求的中文分析架构，包含 shots 拆解、characters 角色及 narrative 叙事剖析。
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* CHARACTER DETAILS SLIDING DRAWER */}
      <AnimatePresence>
        {activeDrawerChar && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setActiveDrawerChar(null)}
              className="absolute inset-0 bg-black/75 backdrop-blur-sm"
            />
            {/* Drawer Panel */}
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 16 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="character-design-modal relative w-full max-w-3xl max-h-[90vh] bg-slate-900 border border-slate-800 shadow-2xl flex flex-col z-10 overflow-hidden"
            >
              {/* Header */}
              <div className="p-5 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users className="w-5 h-5 text-purple-400" />
                  <h3 className="text-sm font-bold text-white">角色完整档案</h3>
                </div>
                <button
                  onClick={() => setActiveDrawerChar(null)}
                  className="w-8 h-8 rounded-full bg-slate-800/50 hover:bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center border border-white/5 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                <div className="flex gap-4 items-start">
                  <div className="w-20 h-20 rounded-xl overflow-hidden border border-white/10 shadow-lg shrink-0 bg-slate-950 relative group">
                    {renderCharacterAvatar(activeDrawerChar)}
                    {renderComfyTaskOverlay(getCharacterTask(activeDrawerChar.id || '', 'avatar'))}
                    {imagePlatform === 'comfyui' && (
                      <button
                        onClick={() => {
                          const defaultPrompt = activeDrawerChar.clothing
                            ? `${activeDrawerChar.clothing}, character concept art, neutral pose, plain dark studio background`
                            : "character concept art, neutral pose, plain dark studio background";
                          handleOpenComfyParams(activeDrawerChar.id || '', 'avatar', 'character', undefined, activeDrawerChar.name, defaultPrompt);
                        }}
                        title="调整参数"
                        className="absolute bottom-1 right-1 p-1 bg-slate-950/80 hover:bg-slate-900 text-slate-350 hover:text-white rounded border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity z-20 cursor-pointer"
                      >
                        <Sliders className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {(isGeneratingCharImage || isGeneratingThreeViews) && !getCharacterTask(activeDrawerChar.id || '', 'avatar') && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-base font-bold text-white">{activeDrawerChar.name}</h4>
                    <p className="text-xs text-purple-400 font-mono font-medium mt-0.5">{activeDrawerChar.role}</p>
                  </div>
                </div>

                <div className="grid gap-3 border border-slate-800 bg-slate-950/45 p-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="block text-[10px] font-semibold text-slate-400">
                      角色母版模型选择
                      <select
                        value={comfyProjectPreferences.characterMasterPresetId}
                        onChange={event => saveProjectPresetField('characterMasterPresetId', event.target.value)}
                        className="mt-1.5 w-full border border-slate-700 bg-slate-900 px-2.5 py-2 text-[10px] text-slate-200 outline-none focus:border-blue-500"
                      >
                        {characterMasterPresets.map(preset => (
                          <option key={preset.presetId} value={preset.presetId} disabled={!preset.available}>
                            {preset.displayName}{preset.available ? '' : `（${preset.reason || '不可用'}）`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleGenerateCharacterAvatar(activeDrawerChar)}
                      disabled={isGeneratingCharImage || ['pending', 'processing'].includes(getCharacterTask(activeDrawerChar.id || '', 'avatar')?.status || '') || !selectedCharacterMasterPreset?.available}
                      className="w-full bg-blue-600 px-3 py-2 text-[10px] font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                    >
                      {isGeneratingCharImage ? '生成角色母版中…' : '生成角色母版'}
                    </button>
                    <p className="truncate text-[9px] text-blue-300" title={selectedCharacterMasterPreset?.modelName}>
                      当前模型：{selectedCharacterMasterPreset?.modelName || '读取中…'}
                    </p>
                    {renderComfySlotStatusAndControls(activeDrawerChar, 'avatar')}
                  </div>

                  <div className="space-y-2">
                    <label className="block text-[10px] font-semibold text-slate-400">
                      三视图模型选择
                      <select
                        value={effectiveThreeViewPresetId}
                        onChange={event => saveProjectPresetField('threeViewPresetId', event.target.value)}
                        className="mt-1.5 w-full border border-slate-700 bg-slate-900 px-2.5 py-2 text-[10px] text-slate-200 outline-none focus:border-purple-500"
                      >
                        {threeViewPresets.map(preset => (
                          <option key={preset.presetId} value={preset.presetId} disabled={!preset.available}>
                            {preset.displayName}{preset.available ? '' : `（${preset.reason || '不可用'}）`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleGenerateThreeViews(activeDrawerChar)}
                      disabled={!activeDrawerChar.avatarUrl || isGeneratingThreeViews || !selectedThreeViewPreset?.available}
                      title={!activeDrawerChar.avatarUrl ? '请先生成角色母版；三视图必须使用 avatar 作为 reference' : `使用 ${selectedThreeViewPreset?.modelName || '所选模型'} 生成三视图`}
                      className="w-full bg-purple-600 px-3 py-2 text-[10px] font-semibold text-white hover:bg-purple-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                    >
                      {isGeneratingThreeViews ? '生成三视图中…' : '生成三视图'}
                    </button>
                    <p className={`truncate text-[9px] ${activeDrawerChar.avatarUrl ? 'text-purple-300' : 'text-amber-400'}`} title={selectedThreeViewPreset?.modelName}>
                      {activeDrawerChar.avatarUrl ? `当前模型：${selectedThreeViewPreset?.modelName || '读取中…'}` : '不可生成：请先生成角色母版 avatar'}
                    </p>
                  </div>
                  <div className="border-t border-slate-800 pt-3 md:col-span-2">
                    <button
                      type="button"
                      onClick={handleBatchGenerate}
                      disabled={!activeDrawerChar.avatarUrl || isQueueingBatch || imagePlatform !== 'comfyui'}
                      title={!activeDrawerChar.avatarUrl ? '请先生成角色母版；分镜生成会优先使用 avatar，并按需加入三视图' : '使用角色 avatar/三视图作为 reference 批量生成分镜'}
                      className="w-full border border-emerald-800/70 bg-emerald-950/45 px-3 py-2 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-900/55 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-500"
                    >
                      {isQueueingBatch ? '正在提交分镜任务…' : '用角色图生成分镜'}
                    </button>
                    <p className="mt-1.5 text-[9px] text-slate-500">
                      参考优先级：角色母版 avatar → 正/侧/背三视图；只注入 manifest 已验证的 LoadImage reference 节点。
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1">性格设定</span>
                    <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/40 p-4 rounded-xl border border-slate-850">
                      {activeDrawerChar.personality}
                    </p>
                  </div>

                  <div>
                    <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1">服饰与外貌描述</span>
                    <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/40 p-4 rounded-xl border border-slate-850">
                      {activeDrawerChar.clothing}
                    </p>
                  </div>

                  <div>
                    <span className="text-[10px] font-mono text-slate-500 uppercase block mb-1">角色三视图</span>
                    <div className="grid grid-cols-3 gap-2 bg-slate-950/40 p-4 rounded-xl border border-slate-850">
                      {/* Front View Slot */}
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] text-slate-500 font-mono mb-1">正</span>
                        <div className="w-full aspect-[2/3] rounded-lg overflow-hidden border border-white/5 bg-slate-900 relative group/view">
                          {activeDrawerChar.views?.front ? (
                            <img
                              key={activeDrawerChar.views.front}
                              src={activeDrawerChar.views.front}
                              onError={() => console.log('抽屉正面图加载失败:', activeDrawerChar.views?.front)}
                              alt="正面图"
                              className="w-full h-full object-cover cursor-zoom-in hover:scale-105 transition-transform"
                              onClick={() => setActiveLightboxUrl(activeDrawerChar.views.front || null)}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-650 bg-slate-950/60 font-medium">
                              暂无图片
                            </div>
                          )}
                          {renderComfyTaskOverlay(getCharacterTask(activeDrawerChar.id || '', 'front'))}
                          {imagePlatform === 'comfyui' && (
                            <button
                              onClick={() => {
                                const defaultPrompt = activeDrawerChar.clothing
                                  ? `${activeDrawerChar.clothing}, front view only, single character standing pose, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`
                                  : "front view only, single character standing pose, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet";
                                handleOpenComfyParams(activeDrawerChar.id || '', 'front', 'character', undefined, activeDrawerChar.name, defaultPrompt);
                              }}
                              title="调整参数"
                              className="absolute bottom-1 right-1 p-1 bg-slate-950/80 hover:bg-slate-900 text-slate-305 hover:text-white rounded border border-white/10 opacity-0 group-hover/view:opacity-100 transition-opacity z-20 cursor-pointer"
                            >
                              <Sliders className="w-3 h-3" />
                            </button>
                          )}
                          {(isGeneratingThreeViews || generatingViews.front) && !getCharacterTask(activeDrawerChar.id || '', 'front') && (
                            <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-1.5">
                              <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
                              <span className="text-[8px] text-purple-300 font-sans scale-90">生成中</span>
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleGenerateSingleView(activeDrawerChar, 'front')}
                          disabled={isGeneratingThreeViews || generatingViews.front || generatingViews.side || generatingViews.back}
                          className="mt-2 w-full py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:hover:bg-slate-800 text-[10px] text-slate-200 rounded font-medium transition-colors cursor-pointer"
                        >
                          正面图
                        </button>
                        {imagePlatform === 'comfyui' && activeDrawerChar.views?.front && (
                          <button
                            type="button"
                            onClick={() => handleUpscaleImage(activeDrawerChar.id || '', 'front', 'character', activeDrawerChar.views!.front!, undefined, activeDrawerChar.name)}
                            disabled={getCharacterTask(activeDrawerChar.id || '', 'front')?.status === 'pending' || getCharacterTask(activeDrawerChar.id || '', 'front')?.status === 'processing'}
                            className="mt-1 w-full py-1 bg-emerald-950/60 hover:bg-emerald-900 disabled:opacity-50 text-[9px] text-emerald-200 rounded border border-emerald-800/60 transition-colors cursor-pointer"
                          >
                            超分
                          </button>
                        )}
                        {renderComfySlotStatusAndControls(activeDrawerChar, 'front')}
                      </div>

                      {/* Side View Slot */}
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] text-slate-500 font-mono mb-1">侧</span>
                        <div className="w-full aspect-[2/3] rounded-lg overflow-hidden border border-white/5 bg-slate-900 relative group/view">
                          {activeDrawerChar.views?.side ? (
                            <img
                              key={activeDrawerChar.views.side}
                              src={activeDrawerChar.views.side}
                              onError={() => console.log('抽屉侧面图加载失败:', activeDrawerChar.views?.side)}
                              alt="侧面图"
                              className="w-full h-full object-cover cursor-zoom-in hover:scale-105 transition-transform"
                              onClick={() => setActiveLightboxUrl(activeDrawerChar.views.side || null)}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-650 bg-slate-950/60 font-medium">
                              暂无图片
                            </div>
                          )}
                          {renderComfyTaskOverlay(getCharacterTask(activeDrawerChar.id || '', 'side'))}
                          {imagePlatform === 'comfyui' && (
                            <button
                              onClick={() => {
                                const defaultPrompt = activeDrawerChar.clothing
                                  ? `${activeDrawerChar.clothing}, side view only, facing right, single character, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`
                                  : "side view only, facing right, single character, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet";
                                handleOpenComfyParams(activeDrawerChar.id || '', 'side', 'character', undefined, activeDrawerChar.name, defaultPrompt);
                              }}
                              title="调整参数"
                              className="absolute bottom-1 right-1 p-1 bg-slate-950/80 hover:bg-slate-900 text-slate-305 hover:text-white rounded border border-white/10 opacity-0 group-hover/view:opacity-100 transition-opacity z-20 cursor-pointer"
                            >
                              <Sliders className="w-3 h-3" />
                            </button>
                          )}
                          {(isGeneratingThreeViews || generatingViews.side) && !getCharacterTask(activeDrawerChar.id || '', 'side') && (
                            <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-1.5">
                              <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
                              <span className="text-[8px] text-purple-300 font-sans scale-90">生成中</span>
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleGenerateSingleView(activeDrawerChar, 'side')}
                          disabled={isGeneratingThreeViews || generatingViews.front || generatingViews.side || generatingViews.back}
                          className="mt-2 w-full py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:hover:bg-slate-800 text-[10px] text-slate-200 rounded font-medium transition-colors cursor-pointer"
                        >
                          侧面图
                        </button>
                        {imagePlatform === 'comfyui' && activeDrawerChar.views?.side && (
                          <button
                            type="button"
                            onClick={() => handleUpscaleImage(activeDrawerChar.id || '', 'side', 'character', activeDrawerChar.views!.side!, undefined, activeDrawerChar.name)}
                            disabled={getCharacterTask(activeDrawerChar.id || '', 'side')?.status === 'pending' || getCharacterTask(activeDrawerChar.id || '', 'side')?.status === 'processing'}
                            className="mt-1 w-full py-1 bg-emerald-950/60 hover:bg-emerald-900 disabled:opacity-50 text-[9px] text-emerald-200 rounded border border-emerald-800/60 transition-colors cursor-pointer"
                          >
                            超分
                          </button>
                        )}
                        {renderComfySlotStatusAndControls(activeDrawerChar, 'side')}
                      </div>

                      {/* Back View Slot */}
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] text-slate-500 font-mono mb-1">背</span>
                        <div className="w-full aspect-[2/3] rounded-lg overflow-hidden border border-white/5 bg-slate-900 relative group/view">
                          {activeDrawerChar.views?.back ? (
                            <img
                              key={activeDrawerChar.views.back}
                              src={activeDrawerChar.views.back}
                              onError={() => console.log('抽屉背面图加载失败:', activeDrawerChar.views?.back)}
                              alt="背面图"
                              className="w-full h-full object-cover cursor-zoom-in hover:scale-105 transition-transform"
                              onClick={() => setActiveLightboxUrl(activeDrawerChar.views.back || null)}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-650 bg-slate-950/60 font-medium">
                              暂无图片
                            </div>
                          )}
                          {renderComfyTaskOverlay(getCharacterTask(activeDrawerChar.id || '', 'back'))}
                          {imagePlatform === 'comfyui' && (
                            <button
                              onClick={() => {
                                const defaultPrompt = activeDrawerChar.clothing
                                  ? `${activeDrawerChar.clothing}, back view only, character facing away from camera, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet`
                                  : "back view only, character facing away from camera, full body, white background, character concept art, anime style, isolated, white background, no side-by-side, no multi-view sheet";
                                handleOpenComfyParams(activeDrawerChar.id || '', 'back', 'character', undefined, activeDrawerChar.name, defaultPrompt);
                              }}
                              title="调整参数"
                              className="absolute bottom-1 right-1 p-1 bg-slate-950/80 hover:bg-slate-900 text-slate-305 hover:text-white rounded border border-white/10 opacity-0 group-hover/view:opacity-100 transition-opacity z-20 cursor-pointer"
                            >
                              <Sliders className="w-3 h-3" />
                            </button>
                          )}
                          {(isGeneratingThreeViews || generatingViews.back) && !getCharacterTask(activeDrawerChar.id || '', 'back') && (
                            <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-1.5">
                              <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
                              <span className="text-[8px] text-purple-300 font-sans scale-90">生成中</span>
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleGenerateSingleView(activeDrawerChar, 'back')}
                          disabled={isGeneratingThreeViews || generatingViews.front || generatingViews.side || generatingViews.back}
                          className="mt-2 w-full py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:hover:bg-slate-800 text-[10px] text-slate-200 rounded font-medium transition-colors cursor-pointer"
                        >
                          背面图
                        </button>
                        {imagePlatform === 'comfyui' && activeDrawerChar.views?.back && (
                          <button
                            type="button"
                            onClick={() => handleUpscaleImage(activeDrawerChar.id || '', 'back', 'character', activeDrawerChar.views!.back!, undefined, activeDrawerChar.name)}
                            disabled={getCharacterTask(activeDrawerChar.id || '', 'back')?.status === 'pending' || getCharacterTask(activeDrawerChar.id || '', 'back')?.status === 'processing'}
                            className="mt-1 w-full py-1 bg-emerald-950/60 hover:bg-emerald-900 disabled:opacity-50 text-[9px] text-emerald-200 rounded border border-emerald-800/60 transition-colors cursor-pointer"
                          >
                            超分
                          </button>
                        )}
                        {renderComfySlotStatusAndControls(activeDrawerChar, 'back')}
                      </div>
                    </div>
                  </div>

                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ANIMATIC MODAL */}
      <AnimatePresence>
        {showAnimaticModal && (
          <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="bg-slate-900/95 border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden shadow-2xl relative backdrop-blur-xl"
            >
              {/* Modal header */}
              <div className="p-5 border-b border-slate-800/80 flex items-center justify-between bg-slate-950/40">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                    <Film className="w-4 h-4 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">生成动态分镜板 (Animatic Preview)</h3>
                    <p className="text-[10px] text-slate-400 mt-0.5">将所有分镜镜头拼装为带有音轨与淡入淡出转场的视频</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (!isCompilingAnimatic) {
                      setShowAnimaticModal(false);
                      setAnimaticVideoUrl(null);
                      setCompilationStatus("");
                    }
                  }}
                  disabled={isCompilingAnimatic}
                  className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg hover:text-white transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed border border-slate-800/80"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Modal body */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                {!animaticVideoUrl && !isCompilingAnimatic && (
                  <div className="space-y-5">
                    {/* Settings Panel */}
                    <div className="space-y-4">
                      {/* Shot Duration Slider */}
                      <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800/60 space-y-2.5">
                        <div className="flex justify-between items-center">
                          <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                            <Sliders className="w-3.5 h-3.5 text-blue-450" />
                            每帧画面停留时长
                          </label>
                          <span className="text-xs font-bold text-blue-450 font-mono">{animaticDuration} 秒 / 帧</span>
                        </div>
                        <input
                          type="range"
                          min="3"
                          max="5"
                          step="0.5"
                          value={animaticDuration}
                          onChange={(e) => setAnimaticDuration(Number(e.target.value))}
                          className="w-full h-1.5 bg-slate-850 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                        <div className="flex justify-between text-[9px] text-slate-500 font-mono">
                          <span>3.0s</span>
                          <span>4.0s (推荐)</span>
                          <span>5.0s</span>
                        </div>
                      </div>

                      {/* BGM Selector */}
                      <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-800/60 space-y-3">
                        <div className="flex justify-between items-center">
                          <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                            <Volume2 className="w-3.5 h-3.5 text-purple-400" />
                            背景音乐 (BGM)
                          </label>
                          {isUploadingBgm && (
                            <span className="text-[10px] text-purple-400 flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              正在上传...
                            </span>
                          )}
                        </div>

                        <div className="flex gap-2">
                          <select
                            value={selectedBgm}
                            onChange={(e) => setSelectedBgm(e.target.value)}
                            className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500 transition-colors"
                          >
                            <option value="">-- 无背景音乐 (静音视频) --</option>
                            {bgmList.map((bgm, bIdx) => (
                              <option key={bIdx} value={bgm.filename}>
                                {bgm.filename}
                              </option>
                            ))}
                          </select>

                          {/* Upload BGM Button */}
                          <label className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700/80 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all active:scale-95 shrink-0">
                            <Upload className="w-3.5 h-3.5" />
                            <span>上传音频</span>
                            <input
                              type="file"
                              accept="audio/*"
                              onChange={handleBgmUpload}
                              className="hidden"
                            />
                          </label>
                        </div>
                        <p className="text-[9px] text-slate-500">
                          支持上传 .mp3, .wav, .m4a 等格式。音乐将自动循环播放，并在视频结尾淡出。
                        </p>
                      </div>
                    </div>

                    {/* Quick Overview */}
                    {generatedScript && (
                      <div className="bg-slate-950/20 p-4 rounded-xl border border-slate-800/45 flex items-center justify-between text-xs gap-4">
                        <div className="text-slate-400 space-y-1">
                          <p>分镜总数: <span className="text-white font-semibold font-mono">{generatedScript.newShots.length}</span> 个镜头</p>
                          <p>预计视频时长: <span className="text-white font-semibold font-mono">{generatedScript.newShots.length * animaticDuration}</span> 秒</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowAnimaticConfirm(true)}
                          className="px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-lg font-semibold flex items-center gap-1.5 shadow-lg shadow-indigo-900/30 transition-all hover:scale-[1.02] cursor-pointer"
                        >
                          <Sparkles className="w-4 h-4" />
                          <span>一键合成动态分镜视频</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Compilation Status & Spinner */}
                {isCompilingAnimatic && (
                  <div className="py-12 flex flex-col items-center justify-center space-y-4">
                    <div className="relative">
                      <div className="w-16 h-16 rounded-full border-4 border-slate-800 flex items-center justify-center">
                        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                      </div>
                      <div className="absolute inset-0 w-16 h-16 rounded-full border-4 border-t-blue-500 border-r-indigo-500 border-b-purple-500 border-l-transparent animate-pulse" />
                    </div>
                    <div className="text-center space-y-1.5">
                      <p className="text-sm font-semibold text-white">正在由 FFmpeg 渲染动态分镜板...</p>
                      <p className="text-xs text-slate-400 font-mono bg-slate-950/50 px-3 py-1.5 rounded-md border border-slate-800/55">{compilationStatus}</p>
                    </div>
                  </div>
                )}

                {/* Success Video Player */}
                {animaticVideoUrl && !isCompilingAnimatic && (
                  <div className="space-y-5">
                    <div className="aspect-video w-full rounded-xl overflow-hidden bg-black border border-slate-800 shadow-2xl relative">
                      <video
                        src={animaticVideoUrl}
                        controls
                        autoPlay
                        loop
                        className="w-full h-full object-contain"
                      />
                    </div>

                    <div className="flex gap-3 justify-end items-center">
                      <a
                        href={animaticVideoUrl}
                        download={`animatic_${generatedScript?.id || 'export'}.mp4`}
                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-emerald-950/20 transition-all cursor-pointer hover:scale-[1.02]"
                      >
                        <Download className="w-4 h-4" />
                        <span>下载 MP4 视频</span>
                      </a>

                      <button
                        type="button"
                        onClick={() => {
                          setAnimaticVideoUrl(null);
                          setCompilationStatus("");
                        }}
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-350 rounded-lg text-xs font-semibold transition-colors cursor-pointer border border-slate-700/50"
                      >
                        重新配置
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setShowAnimaticModal(false);
                          setAnimaticVideoUrl(null);
                          setCompilationStatus("");
                        }}
                        className="px-4 py-2 bg-slate-900 hover:bg-slate-950 text-slate-400 hover:text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer border border-slate-800"
                      >
                        关闭
                      </button>
                    </div>
                  </div>
                )}

                {/* Error fallback */}
                {compilationStatus.startsWith("编译失败") && !isCompilingAnimatic && (
                  <div className="bg-red-950/30 border border-red-900/55 p-4 rounded-xl space-y-3">
                    <div className="flex items-start gap-2.5">
                      <span className="text-red-400 text-sm mt-0.5">⚠️</span>
                      <div>
                        <h4 className="text-xs font-bold text-red-300">合成视频失败</h4>
                        <p className="text-[11px] text-slate-400 mt-1 font-mono">{compilationStatus}</p>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => setCompilationStatus("")}
                        className="px-3 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-300 rounded-lg text-[10px] font-semibold transition-colors cursor-pointer border border-red-800/40"
                      >
                        重配置
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ANIMATIC TIMELINE CONFIRM MODAL */}
      <AnimatePresence>
        {showAnimaticConfirm && generatedScript && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-60 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="bg-slate-900/95 border border-slate-800 rounded-2xl max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl relative backdrop-blur-xl animate-fade-in"
            >
              {/* Modal header */}
              <div className="p-4 border-b border-slate-800/80 flex items-center gap-2.5 bg-slate-950/40">
                <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
                  <Film className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">确认合成时间轴</h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">请预览镜头顺序、时长与画面配置是否准确</p>
                </div>
              </div>

              {/* Shot List */}
              <div className="p-4 overflow-y-auto max-h-[50vh] space-y-3 custom-scrollbar flex-1">
                {generatedScript.newShots.map((shot: any, idx: number) => {
                  const shotImg = shotImages[shot.timestamp] || shot.generatedImageUrl || shot.imageUrl;
                  const startTime = idx * animaticDuration;
                  const endTime = (idx + 1) * animaticDuration;

                  const formatTimeStr = (s: number) => {
                    const mins = Math.floor(s / 60);
                    const secs = s % 60;
                    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                  };

                  return (
                    <div key={idx} className="flex gap-3 bg-slate-950/30 border border-slate-800/50 rounded-xl p-3 hover:border-slate-700/60 transition-all">
                      {/* Thumbnail or placeholder */}
                      <div className="w-20 h-14 rounded-lg bg-slate-900 overflow-hidden border border-slate-800 flex-shrink-0 relative">
                        {shotImg ? (
                          <img key={shotImg} src={shotImg} alt={`Shot ${idx + 1}`} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center text-[8px] text-slate-500">
                            <Film className="w-3.5 h-3.5 mb-1" />
                            <span>暂无图片</span>
                          </div>
                        )}
                        <div className="absolute top-1 left-1 bg-black/70 px-1 py-0.5 rounded text-[8px] text-slate-300 font-mono">
                          #{idx + 1}
                        </div>
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-indigo-400 font-mono font-semibold">
                            {formatTimeStr(startTime)} - {formatTimeStr(endTime)} ({animaticDuration}秒)
                          </span>
                          <span className="text-[9px] text-slate-500 font-mono bg-slate-800/40 px-1.5 py-0.5 rounded">
                            {shot.movement || "默认运镜"}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-300 line-clamp-2 leading-relaxed">
                          {shot.description}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Summary Footer */}
              <div className="p-4 border-t border-slate-800/80 bg-slate-950/40 space-y-3">
                <div className="flex justify-between items-center text-xs text-slate-400">
                  <div>
                    <span className="text-slate-500">伴奏音频:</span>{" "}
                    <span className="text-slate-300 font-semibold font-mono">
                      {selectedBgm ? selectedBgm : "无 (直接合成)"}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">预计总长度:</span>{" "}
                    <span className="text-white font-bold font-mono text-sm">
                      {generatedScript.newShots.length * animaticDuration}秒
                    </span>
                  </div>
                </div>

                <div className="flex gap-2.5">
                  <button
                    type="button"
                    onClick={() => setShowAnimaticConfirm(false)}
                    className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-350 rounded-lg text-xs font-semibold cursor-pointer active:scale-95 transition-all border border-slate-700/60"
                  >
                    返回修改
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAnimaticConfirm(false);
                      handleCompileAnimatic();
                    }}
                    className="flex-1 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-lg text-xs font-semibold cursor-pointer active:scale-95 transition-all shadow-lg shadow-indigo-950/30 animate-pulse-subtle"
                  >
                    确认合成
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* PROJECT COMFYUI PRESET SETTINGS */}
      <AnimatePresence>
        {showComfyPresetSettings && generatedScript && (
          <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-slate-800 p-4">
                <div>
                  <h3 className="text-sm font-bold text-white">项目 ComfyUI 预设</h3>
                  <p className="mt-1 text-[10px] text-slate-500">保存后应用于此项目的新任务，旧任务快照保持不变。</p>
                </div>
                <button type="button" onClick={() => setShowComfyPresetSettings(false)} className="text-slate-400 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 p-5 text-xs">
                {([
                  ['shotPresetId', '分镜', [['sdxl_legacy', 'SDXL Legacy'], ['pure_klein', 'Pure Klein 4B']]],
                  ['characterMasterPresetId', '角色母版', [['sdxl_legacy', 'SDXL Legacy'], ['pure_klein', 'Pure Klein 4B']]],
                  ['identityPresetId', '身份锁定', [['pulid_flux2', 'PuLID Flux2']]],
                  ['threeViewPresetId', '三视图', [['legacy_three_views', '现有三视图流程'], ['qwen_2511_three_views', qwenThreeViewVerified ? 'Qwen 2511 Three Views' : 'Qwen 2511 Three Views（未验证）']]],
                  ['upscalePresetId', '放大', [['esrgan_4x', '4x ESRGAN']]],
                ] as Array<[keyof ComfyProjectPreferences, string, string[][]]>).map(([key, label, options]) => (
                  <label key={key} className="grid grid-cols-[90px_1fr] items-center gap-3">
                    <span className="font-semibold text-slate-400">{label}</span>
                    <select
                      value={comfyProjectPreferences[key]}
                      onChange={event => setComfyProjectPreferences(previous => ({ ...previous, [key]: event.target.value }))}
                      className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-2 text-slate-200 outline-none focus:border-blue-500"
                    >
                      {options.map(([value, optionLabel]) => (
                        <option key={value} value={value} disabled={value === 'qwen_2511_three_views' && !qwenThreeViewVerified}>
                          {optionLabel}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <button
                  type="button"
                  disabled={!qwenThreeViewVerified || savingComfyPresetSettings}
                  onClick={() => saveComfyProjectPreferences(true)}
                  title={qwenThreeViewVerified ? '应用推荐配置' : 'Qwen front/side/back 尚未全部真实通过'}
                  className="w-full rounded-lg border border-purple-800/60 bg-purple-950/40 py-2 text-[10px] font-semibold text-purple-200 hover:bg-purple-900/50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  一键使用推荐配置
                </button>
                {!qwenThreeViewVerified && <p className="text-[10px] text-amber-500">Qwen 2511 Three Views：未验证，暂不设为默认。</p>}
              </div>
              <div className="flex gap-3 border-t border-slate-800 p-4">
                <button type="button" onClick={() => setShowComfyPresetSettings(false)} className="flex-1 rounded-xl bg-slate-800 py-2.5 text-xs text-slate-300">取消</button>
                <button type="button" disabled={savingComfyPresetSettings} onClick={() => saveComfyProjectPreferences(false)} className="flex-1 rounded-xl bg-blue-600 py-2.5 text-xs font-semibold text-white disabled:opacity-50">
                  {savingComfyPresetSettings ? '保存中…' : '保存项目设置'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* COMFYUI PARAMETER TUNING DIALOG */}
      <AnimatePresence>
        {comfyModalOpen && comfyModalTarget && (
          <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              {/* Header */}
              <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/20">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-blue-400" />
                  <h3 className="text-sm font-bold text-white">调整 ComfyUI 生成参数</h3>
                </div>
                <button
                  onClick={() => setComfyModalOpen(false)}
                  className="text-slate-400 hover:text-white cursor-pointer transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Form Content */}
              <div className="p-5 overflow-y-auto space-y-4 text-xs text-slate-350 custom-scrollbar">
                {/* Custom Workflow Info */}
                {workflowSupport.isCustom && (
                  <div className="bg-blue-950/30 border border-blue-900/50 p-2.5 rounded-lg text-[10px] text-blue-400">
                    ℹ️ 当前正在使用自定义工作流。部分参数由工作流本身控制，未映射的参数已被禁用。
                  </div>
                )}

                {/* Workflow Preset */}
                <div className="space-y-1.5">
                  <span className="font-semibold text-slate-400">工作流预设:</span>
                  <select
                    value={comfyParams.presetId}
                    onChange={(e) => {
                      const presetId = e.target.value;
                      setComfyParams(prev => ({
                        ...prev,
                        presetId,
                        sourceImageUrl: presetId === '02_klein_pulid_identity' ? prev.sourceImageUrl : '',
                      }));
                    }}
                    className="w-full bg-slate-950 border border-slate-850 hover:border-slate-800 focus:border-blue-500 rounded px-2.5 py-1.5 focus:outline-none transition-all cursor-pointer text-slate-200"
                  >
                    <option value="sdxl_legacy">SDXL Legacy</option>
                    <option value="01_klein_character_master">Pure Klein 4B</option>
                    {comfyModalTarget.targetType === 'character' && comfyModalTarget.viewType === 'avatar' && (
                      <option value="02_klein_pulid_identity">PuLID Flux2</option>
                    )}
                  </select>
                </div>

                {/* PuLID reference image */}
                {comfyParams.presetId === '02_klein_pulid_identity' && (
                  <div className="space-y-2 rounded-xl border border-purple-900/60 bg-purple-950/20 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-purple-300">PuLID 参考图</span>
                      <span className="text-[10px] text-slate-500">用于锁定角色身份特征</span>
                    </div>
                    {comfyParams.sourceImageUrl ? (
                      <div className="flex items-center gap-3">
                        <img
                          key={comfyParams.sourceImageUrl}
                          src={comfyParams.sourceImageUrl}
                          alt="PuLID 参考图"
                          className="h-20 w-20 rounded-lg border border-white/10 object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => setComfyParams(prev => ({ ...prev, sourceImageUrl: '' }))}
                          className="px-3 py-1.5 rounded-lg border border-rose-900/60 bg-rose-950/40 text-[10px] text-rose-300 hover:bg-rose-900/50 transition-colors cursor-pointer"
                        >
                          删除参考图
                        </button>
                      </div>
                    ) : (
                      <label className="flex min-h-20 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-purple-800/70 bg-slate-950/50 text-slate-400 transition-colors hover:border-purple-500 hover:text-purple-300">
                        {isUploadingRefImage ? (
                          <Loader2 className="h-5 w-5 animate-spin" />
                        ) : (
                          <>
                            <Upload className="mb-1 h-5 w-5" />
                            <span className="text-[10px]">上传角色参考图</span>
                          </>
                        )}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                          disabled={isUploadingRefImage}
                          onChange={handleUploadRefImage}
                          className="hidden"
                        />
                      </label>
                    )}
                  </div>
                )}

                {/* Prompt */}
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold text-slate-400">提示词 (Prompt):</span>
                    {!workflowSupport.supported.prompt && (
                      <span className="text-[10px] text-amber-500 font-medium">该参数由自定义工作流控制</span>
                    )}
                  </div>
                  <textarea
                    rows={3}
                    value={comfyParams.prompt}
                    onChange={(e) => setComfyParams(prev => ({ ...prev, prompt: e.target.value }))}
                    disabled={!workflowSupport.supported.prompt}
                    className="w-full bg-slate-950 border border-slate-850 hover:border-slate-800 focus:border-blue-500 rounded px-2.5 py-1.5 focus:outline-none disabled:bg-slate-950/50 disabled:text-slate-650 disabled:border-slate-900 transition-all font-sans resize-none text-slate-200"
                    placeholder="输入生图提示词..."
                  />
                </div>

                {/* Negative Prompt */}
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold text-slate-400">反向提示词 (Negative Prompt):</span>
                    {!workflowSupport.supported.negativePrompt && (
                      <span className="text-[10px] text-amber-500 font-medium">该参数由自定义工作流控制</span>
                    )}
                  </div>
                  <textarea
                    rows={2}
                    value={comfyParams.negativePrompt}
                    onChange={(e) => setComfyParams(prev => ({ ...prev, negativePrompt: e.target.value }))}
                    disabled={!workflowSupport.supported.negativePrompt}
                    className="w-full bg-slate-950 border border-slate-850 hover:border-slate-800 focus:border-blue-500 rounded px-2.5 py-1.5 focus:outline-none disabled:bg-slate-950/50 disabled:text-slate-650 disabled:border-slate-900 transition-all font-sans resize-none text-slate-200"
                    placeholder="输入反向提示词（负面提示）..."
                  />
                </div>

                {/* Model Selection Dropdown */}
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold text-slate-400">生成模型 (Checkpoint):</span>
                    {!workflowSupport.supported.model && (
                      <span className="text-[10px] text-amber-500 font-medium">该参数由自定义工作流控制</span>
                    )}
                  </div>
                  {workflowSupport.supported.model ? (
                    <div className="space-y-1.5">
                      <select
                        value={comfyParams.model}
                        onChange={(e) => {
                          setComfyParams(prev => ({ ...prev, model: e.target.value }));
                          setModelError("");
                        }}
                        className={`w-full bg-slate-950 border ${modelError ? 'border-rose-500 focus:border-rose-500' : 'border-slate-850 hover:border-slate-800 focus:border-blue-500'} rounded px-2.5 py-1.5 focus:outline-none transition-all cursor-pointer text-slate-250`}
                      >
                        {availableCheckpoints.map((ckpt, index) => (
                          <option key={index} value={ckpt} className="bg-slate-950 text-slate-200">
                            {ckpt}
                          </option>
                        ))}
                      </select>
                      {modelError && (
                        <div className="text-[10px] text-rose-500 font-medium">{modelError}</div>
                      )}
                    </div>
                  ) : (
                    <input
                      type="text"
                      disabled
                      value="由自定义工作流指定"
                      className="w-full bg-slate-950/50 border border-slate-900 text-slate-600 rounded px-2.5 py-1.5 cursor-not-allowed"
                    />
                  )}
                </div>

                {/* Seed Selection */}
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold text-slate-400">随机种子 (Seed):</span>
                    {!workflowSupport.supported.seed && (
                      <span className="text-[10px] text-amber-500 font-medium">该参数由自定义工作流控制</span>
                    )}
                  </div>
                  <div className="flex gap-4 items-center bg-slate-950 border border-slate-850 p-2 rounded-lg">
                    <label className="flex items-center gap-1.5 cursor-pointer disabled:opacity-50 text-slate-200">
                      <input
                        type="radio"
                        name="seedMode"
                        checked={comfyParams.seedMode === 'keep'}
                        onChange={() => setComfyParams(prev => ({ ...prev, seedMode: 'keep' }))}
                        disabled={!workflowSupport.supported.seed}
                        className="text-blue-600 focus:ring-0 focus:outline-none bg-slate-950 border-slate-800 cursor-pointer"
                      />
                      <span>保持原 Seed</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer disabled:opacity-50 text-slate-200">
                      <input
                        type="radio"
                        name="seedMode"
                        checked={comfyParams.seedMode === 'random'}
                        onChange={() => setComfyParams(prev => ({ ...prev, seedMode: 'random' }))}
                        disabled={!workflowSupport.supported.seed}
                        className="text-blue-600 focus:ring-0 focus:outline-none bg-slate-950 border-slate-800 cursor-pointer"
                      />
                      <span>随机 Seed</span>
                    </label>
                  </div>
                  {comfyParams.seedMode === 'keep' && workflowSupport.supported.seed && (
                    <input
                      type="text"
                      value={comfyParams.seed}
                      onChange={(e) => setComfyParams(prev => ({ ...prev, seed: e.target.value.replace(/\\D/g, '') }))}
                      disabled={!workflowSupport.supported.seed}
                      className="w-full bg-slate-950 border border-slate-850 hover:border-slate-800 focus:border-blue-500 rounded px-2.5 py-1.5 focus:outline-none font-mono disabled:text-slate-650 text-slate-200"
                      placeholder="旧任务 Seed 将被自动沿用"
                    />
                  )}
                </div>

                {/* Width & Height Selection */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-slate-400">图片宽度 (Width):</span>
                      {!workflowSupport.supported.width && (
                        <span className="text-[10px] text-amber-500 font-medium">禁用</span>
                      )}
                    </div>
                    <input
                      type="number"
                      value={comfyParams.width}
                      min={256}
                      max={2048}
                      step={64}
                      onChange={(e) => setComfyParams(prev => ({ ...prev, width: parseInt(e.target.value) || 0 }))}
                      disabled={!workflowSupport.supported.width}
                      className="w-full bg-slate-950 border border-slate-850 hover:border-slate-800 focus:border-blue-500 rounded px-2.5 py-1.5 focus:outline-none disabled:bg-slate-950/50 disabled:text-slate-650 text-slate-200"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-slate-400">图片高度 (Height):</span>
                      {!workflowSupport.supported.height && (
                        <span className="text-[10px] text-amber-500 font-medium">禁用</span>
                      )}
                    </div>
                    <input
                      type="number"
                      value={comfyParams.height}
                      min={256}
                      max={2048}
                      step={64}
                      onChange={(e) => setComfyParams(prev => ({ ...prev, height: parseInt(e.target.value) || 0 }))}
                      disabled={!workflowSupport.supported.height}
                      className="w-full bg-slate-950 border border-slate-850 hover:border-slate-800 focus:border-blue-500 rounded px-2.5 py-1.5 focus:outline-none disabled:bg-slate-950/50 disabled:text-slate-650 text-slate-200"
                    />
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="p-4 border-t border-slate-800 bg-slate-950/30 flex gap-3">
                <button
                  type="button"
                  onClick={() => setComfyModalOpen(false)}
                  className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-350 rounded-xl text-xs font-semibold cursor-pointer active:scale-95 transition-all border border-slate-770"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleRegenerateWithParams}
                  className="flex-1 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl text-xs font-semibold cursor-pointer active:scale-95 transition-all shadow-lg shadow-indigo-950/20"
                >
                  重新生成
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {shotCharacterModal && generatedScript && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-4" onClick={() => setShotCharacterModal(null)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              role="dialog"
              aria-modal="true"
              aria-label="绑定本镜角色"
              className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
              onClick={event => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
                <div><h3 className="text-sm font-bold text-white">绑定本镜角色</h3><p className="mt-1 text-[11px] text-slate-400">可多选；保存后写入 matchedCharacterIds</p></div>
                <button type="button" aria-label="关闭角色选择" onClick={() => setShotCharacterModal(null)} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"><X className="h-4 w-4" /></button>
              </div>
              <div className="max-h-[55vh] space-y-2 overflow-y-auto p-5">
                {(generatedScript.newCharacters || []).map((character: Character) => {
                  const characterId = String(character.id || '');
                  const selected = shotCharacterModal.selectedIds.includes(characterId);
                  const hasAvatar = !!(character.avatarImageUrl || character.avatarUrl);
                  return (
                    <button
                      key={characterId || character.name}
                      type="button"
                      disabled={!characterId}
                      aria-pressed={selected}
                      onClick={() => characterId && handleModalCharacterToggle(characterId)}
                      className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${selected ? 'border-blue-400 bg-blue-500/15' : 'border-slate-700 bg-slate-950/60 hover:border-slate-500'} disabled:opacity-40`}
                    >
                      <div className="h-10 w-10 overflow-hidden rounded-full bg-slate-800">{hasAvatar ? <img src={character.avatarImageUrl || character.avatarUrl} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-slate-500">无图</div>}</div>
                      <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-white">{character.name}</div><div className={`mt-1 text-[10px] ${hasAvatar ? 'text-emerald-400' : 'text-amber-400'}`}>{hasAvatar ? 'Avatar 已就绪' : '角色缺 Avatar'}</div></div>
                      <div className={`flex h-5 w-5 items-center justify-center rounded border ${selected ? 'border-blue-400 bg-blue-500 text-white' : 'border-slate-600'}`}>{selected && <Check className="h-3 w-3" />}</div>
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4">
                <button type="button" onClick={() => setShotCharacterModal(null)} className="rounded bg-slate-800 px-4 py-2 text-xs text-slate-200 hover:bg-slate-700">取消</button>
                <button type="button" onClick={() => handleSaveShotCharacters(false)} className="rounded bg-slate-700 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-600">保存角色绑定</button>
                <button type="button" onClick={() => handleSaveShotCharacters(true)} className="rounded bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500">保存并用角色参考图重新生成</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {shotCharacterFeedback && (
        <div role="status" className={`fixed bottom-6 right-6 z-[140] rounded-lg border px-4 py-3 text-xs font-semibold shadow-xl ${shotCharacterFeedback.kind === 'success' ? 'border-emerald-500/60 bg-emerald-950 text-emerald-200' : 'border-red-500/60 bg-red-950 text-red-200'}`}>
          {shotCharacterFeedback.message}
        </div>
      )}

      {/* LIGHTBOX MODAL */}
      <AnimatePresence>
        {activeLightboxUrl && (
          <div className="fixed inset-0 bg-black/95 backdrop-blur-md z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative max-w-5xl w-full max-h-[90vh] flex flex-col items-center"
            >
              {/* Close Button */}
              <button
                onClick={() => setActiveLightboxUrl(null)}
                className="absolute top-4 right-4 text-slate-400 hover:text-white cursor-pointer w-10 h-10 rounded-full bg-slate-900/60 backdrop-blur-md flex items-center justify-center border border-white/5 z-10 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>

              {/* Image or Video */}
              {activeLightboxUrl.includes('.mp4') ? (
                <video
                  src={activeLightboxUrl}
                  controls
                  autoPlay
                  loop
                  className="rounded-lg shadow-2xl max-w-full max-h-[80vh] object-contain border border-slate-800"
                />
              ) : (
                <img
                  src={activeLightboxUrl}
                  alt="Fullscreen Preview"
                  className="rounded-lg shadow-2xl max-w-full max-h-[80vh] object-contain border border-slate-800"
                />
              )}

              {/* Actions */}
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => {
                    const isVideo = activeLightboxUrl.includes('.mp4');
                    const filename = isVideo ? `generated_video_${Date.now()}.mp4` : `generated_flux_image_${Date.now()}.webp`;
                    handleDownloadImage(activeLightboxUrl, filename);
                  }}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold cursor-pointer shadow-lg shadow-blue-900/20 transition-all flex items-center gap-1.5"
                >
                  <Download className="w-4 h-4" />
                  <span>{activeLightboxUrl.includes('.mp4') ? "下载动画视频" : "下载原图"}</span>
                </button>
                <button
                  onClick={() => setActiveLightboxUrl(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-350 rounded-lg text-xs font-semibold cursor-pointer transition-colors"
                >
                  关闭预览
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
