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
  X,
  Volume2,
  VolumeX,
  Monitor,
  Upload,
  Trash2,
  Loader2,
  Calendar,
  Plus,
  GripVertical
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { videoAnalysisData } from "./data";
import { Shot, Character, VideoRecord, GeneratedScriptRecord } from "./types";

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
  const [imagePlatform, setImagePlatform] = useState<'pollinations' | 'kling' | 'comfyui'>('pollinations');
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
  }>({
    prompt: "",
    negativePrompt: "",
    seedMode: "keep",
    seed: "",
    model: "",
    width: 768,
    height: 512
  });
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

  const handleOpenComfyParams = async (targetId: string, viewType: string, targetType: 'shot' | 'character', shotIndex?: number, characterName?: string, defaultPrompt?: string) => {
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
    const finalModel = lastParams ? lastParams.model : "";
    const finalWidth = lastParams ? lastParams.width : (targetType === 'character' ? 512 : 768);
    const finalHeight = lastParams ? lastParams.height : (targetType === 'character' ? 768 : 512);

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
      seedMode: "keep",
      seed: finalSeed,
      model: selectedModel,
      width: finalWidth,
      height: finalHeight
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
    if (!comfyModalTarget || !generatedScript) return;
    if (workflowSupport.supported.prompt && !comfyParams.prompt.trim()) {
      alert("提示词不能为空");
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
          skipTranslation: true
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
      fetch(`/api/generated-scripts/${generatedScript.id}`)
        .then(res => { if (res.ok) return res.json(); })
        .then(data => {
          if (data) {
            setGeneratedScript(data);
            setGeneratedScripts(prev => prev.map(s => s.id === data.id ? data : s));
          }
        })
        .catch(err => console.error("Error reloading script:", err));
    }
    prevComfyTasksRef.current = comfyTasks;
  }, [comfyTasks, generatedScript]);

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
        pollComfyTasks();
      } else {
        const err = await res.json();
        alert(err.error || "取消失败");
      }
    } catch (e: any) {
      alert("网络错误：" + e.message);
    }
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

  const renderComfyTaskOverlay = (task: any) => {
    if (!task) return null;
    if (task.status === 'pending') {
      return (
        <div className="absolute inset-0 bg-slate-950/85 border border-slate-800 rounded-lg flex flex-col items-center justify-center p-1 z-10 text-center">
          <Clock className="w-4 h-4 text-amber-500 animate-pulse mb-0.5" />
          <span className="text-[9px] text-amber-405 font-medium scale-90">排队中</span>
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
      return (
        <div className="absolute inset-0 bg-slate-950/85 border border-slate-800 rounded-lg flex flex-col items-center justify-center p-1 z-10 text-center">
          <Loader2 className="w-4 h-4 text-blue-400 animate-spin mb-0.5" />
          <span className="text-[9px] text-blue-300 font-medium scale-90">生成中</span>
        </div>
      );
    }
    if (task.status === 'failed') {
      return (
        <div className="absolute inset-0 bg-slate-950/90 border border-slate-800 rounded-lg flex flex-col items-center justify-center p-1 z-10 text-center">
          <span className="text-[8px] text-red-400 font-medium line-clamp-1 mb-0.5 scale-90" title={task.errorMsg}>
            失败
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleRetryComfyTask(task.id); }}
            className="px-1.5 py-0.5 bg-blue-950 hover:bg-blue-900 border border-blue-900 text-blue-200 rounded text-[8px] cursor-pointer font-semibold transition-colors"
          >
            重试
          </button>
        </div>
      );
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
      const res = await fetch("/api/generated-scripts");
      if (res.ok) {
        const data = await res.json();
        setGeneratedScripts(data);
      }
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

  const handleGenerateShotImage = async (shot: Shot, idx: number) => {
    if (!generatedScript) return;
    
    const imagePrompt = shot.description;
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
            isCharacter: false,
            style: getStyleEnglish(shot.style || "写实"),
            platform: imagePlatform,
            projectId: generatedScript.id,
            targetType: 'shot',
            targetId: shot.id,
            viewType: 'main',
            shotIndex: idx,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "生成图片任务提交失败");
        }
        pollComfyTasks();
      } catch (err: any) {
        alert(err.message || "提交任务失败");
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
    updatedShots[idx] = {
      ...updatedShots[idx],
      [field]: value
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
            return { ...c, avatarUrl: url };
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

  const handleGenerateThreeViews = async (char: Character) => {
    if (!generatedScript) return;
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
        await Promise.all([
          fetch("/api/generate-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: promptFront,
              isCharacter: true,
              skipTranslation: true,
              platform: imagePlatform,
              projectId: generatedScript.id,
              targetType: 'character',
              targetId: char.id,
              viewType: 'front',
              characterName: char.name
            })
          }).then(r => { if (!r.ok) throw new Error("正面图提交失败"); }),
          fetch("/api/generate-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: promptSide,
              isCharacter: true,
              skipTranslation: true,
              platform: imagePlatform,
              projectId: generatedScript.id,
              targetType: 'character',
              targetId: char.id,
              viewType: 'side',
              characterName: char.name
            })
          }).then(r => { if (!r.ok) throw new Error("侧面图提交失败"); }),
          fetch("/api/generate-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: promptBack,
              isCharacter: true,
              skipTranslation: true,
              platform: imagePlatform,
              projectId: generatedScript.id,
              targetType: 'character',
              targetId: char.id,
              viewType: 'back',
              characterName: char.name
            })
          }).then(r => { if (!r.ok) throw new Error("背面图提交失败"); })
        ]);
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
            return { ...c, views: viewsObj, avatarUrl: frontUrl };
          }
          return c;
        });
        const updatedScript = { ...generatedScript, newCharacters: updatedChars };
        setGeneratedScript(updatedScript);
        setActiveDrawerChar(prev => prev && prev.name === char.name ? { ...prev, views: viewsObj, avatarUrl: frontUrl } : prev);
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
            prompt,
            isCharacter: true,
            skipTranslation: true,
            platform: imagePlatform,
            projectId: generatedScript.id,
            targetType: 'character',
            targetId: char.id,
            viewType,
            characterName: char.name
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

  return (
    <div className="bg-slate-950 text-slate-200 min-h-screen flex flex-col font-sans select-none overflow-x-hidden antialiased">
      {/* Top Header */}
      <header className="h-14 border-b border-slate-800/80 flex items-center justify-between px-6 bg-slate-900/60 backdrop-blur-md sticky top-0 z-40">
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
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-mono bg-emerald-950/40 text-emerald-400 border border-emerald-800/50 px-2.5 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
            ANALYSIS READY
          </span>
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
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden w-full mx-auto">
        
        {/* Column 1: Video Library & File Upload (width 320px) */}
        <aside className="w-full md:w-80 border-r border-slate-800/60 bg-slate-950/40 flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
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

        {/* Column 2: Player & Active Shot (Desktop 620px or flex-1) */}
        {!(activeTab === "generator" && generatedScript) && (
          <section className="w-full lg:w-[640px] xl:w-[700px] flex flex-col border-r border-slate-800/60 bg-slate-950/20">
            
            {/* Cinema Box (Dynamic HTML5 Video or Slideshow) */}
            <div className="aspect-video lg:h-[390px] w-full bg-slate-950 relative flex items-center justify-center border-b border-slate-800/80 overflow-hidden group">
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

            {/* Detailed Selected Shot Metadata Panel */}
            <div className="p-4 bg-slate-900/40 border-b border-slate-800/60">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-blue-400 bg-blue-950/50 border border-blue-900/50 px-2 py-0.5 rounded uppercase tracking-wider">
                    当前选中分镜 / {activeShot.timestamp}
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">
                    开始秒数: {activeShot.timeSeconds}s
                  </span>
                </div>
                <h2 className="text-base font-bold text-slate-100 tracking-tight flex items-center gap-2">
                  <span className="text-blue-500">运镜：</span>
                  {activeShot.movement}
                </h2>
                <div className="grid grid-cols-2 gap-3 mt-1.5">
                  <div className="bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/50">
                    <span className="text-[10px] text-slate-500 uppercase block mb-1 font-semibold tracking-wider">画面构图 (Composition)</span>
                    <p className="text-xs text-slate-300 font-medium leading-relaxed">{activeShot.composition}</p>
                  </div>
                  <div className="bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/50">
                    <span className="text-[10px] text-slate-500 uppercase block mb-1 font-semibold tracking-wider">情绪基调 (Tone/Emotion)</span>
                    <p className="text-xs text-emerald-400 font-medium leading-relaxed">{activeShot.emotion}</p>
                  </div>
                </div>
                <div className="bg-slate-950/40 p-3 rounded-lg border border-slate-800/30 mt-1">
                  <span className="text-[10px] text-slate-500 uppercase block mb-1 font-semibold tracking-wider">画面拆解与剧情说明 (Details)</span>
                  <p className="text-xs text-slate-300 leading-relaxed font-normal">{activeShot.description}</p>
                </div>
              </div>
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
          </section>
        )}

        {/* Column 3: Tabular Narrative Analysis & Character Dossier */}
        <section className="flex-1 flex flex-col bg-slate-900/30 overflow-y-auto custom-scrollbar">
          
          {/* Tabs header */}
          <div className="h-12 border-b border-slate-800/80 bg-slate-900/50 flex items-center justify-between px-6 sticky top-0 z-10 backdrop-blur">
            <div className="flex gap-4">
              <button 
                onClick={() => setActiveTab("shots")}
                className={`h-12 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors cursor-pointer ${
                  activeTab === "shots" 
                    ? "border-blue-500 text-slate-100" 
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                分镜脉络
              </button>
              <button 
                onClick={() => setActiveTab("characters")}
                className={`h-12 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors cursor-pointer ${
                  activeTab === "characters" 
                    ? "border-purple-500 text-slate-100" 
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                人物画像
              </button>
              <button 
                onClick={() => setActiveTab("narrative")}
                className={`h-12 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors cursor-pointer ${
                  activeTab === "narrative" 
                    ? "border-amber-500 text-slate-100" 
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                叙事与爽点
              </button>
              <button 
                onClick={() => setActiveTab("generator")}
                className={`h-12 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors cursor-pointer ${
                  activeTab === "generator" 
                    ? "border-emerald-500 text-slate-100" 
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                创意生成
              </button>
            </div>

            <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest hidden md:block">
              WORKSPACE ACTIVE
            </div>
          </div>

          <div className="p-6 flex-1 flex flex-col gap-6">
            
            {/* TAB: SHOTS BRIEF */}
            {activeTab === "shots" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-3 flex items-center">
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full mr-2"></span>
                    视频分镜统计
                  </h3>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-800/60 text-center">
                      <span className="text-[10px] text-slate-500 block uppercase font-mono">分镜总数</span>
                      <span className="text-xl font-bold text-slate-100 font-mono mt-0.5 block">{activeShots.length}</span>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-800/60 text-center">
                      <span className="text-[10px] text-slate-500 block uppercase font-mono">平均秒数</span>
                      <span className="text-xl font-bold text-slate-100 font-mono mt-0.5 block">
                        {activeShots.length > 0 ? (duration / activeShots.length).toFixed(1) : "0"}s
                      </span>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-800/60 text-center">
                      <span className="text-[10px] text-slate-500 block uppercase font-mono">情感波动</span>
                      <span className="text-xl font-bold text-emerald-400 font-mono mt-0.5 block">
                        {new Set(activeShots.map(s => s.emotion)).size}类
                      </span>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-3 flex items-center">
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full mr-2"></span>
                    故事分镜发展脉络 (Timeline Pathway)
                  </h3>
                  <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-800/60 space-y-4 font-mono text-xs">
                    {selectedRecord ? (
                      // Render dynamic shots flow for uploaded videos
                      activeShots.slice(0, 12).map((shot, idx) => (
                        <div key={idx} className="space-y-4">
                          <div className="flex items-start gap-2.5">
                            <div className="w-6 h-6 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold border border-blue-500/30 text-[10px] shrink-0 mt-0.5">
                              {idx + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="text-slate-200 font-semibold">{shot.movement}</span>
                              <span className="text-[10px] text-blue-400 ml-2 font-mono">{shot.timestamp}</span>
                              <p className="text-[11px] text-slate-500 mt-1 leading-normal">{shot.description}</p>
                            </div>
                          </div>
                          {idx < activeShots.slice(0, 12).length - 1 && (
                            <div className="h-4 w-0.5 bg-slate-800 ml-3"></div>
                          )}
                        </div>
                      ))
                    ) : (
                      // Render hardcoded high fidelity pathway for demo steampunk video
                      <div className="space-y-4">
                        <div className="flex items-start gap-2">
                          <div className="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 font-bold shrink-0">1</div>
                          <div className="flex-1">
                            <span className="text-slate-200 font-semibold">云海蒸汽飞空艇 (Cabin Room)</span>
                            <p className="text-[11px] text-slate-500 mt-0.5">对话拌嘴，建立小队默契与性格反差</p>
                          </div>
                        </div>
                        <div className="h-4.5 w-0.5 bg-slate-800 ml-3"></div>
                        <div className="flex items-start gap-2">
                          <div className="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 font-bold shrink-0">2</div>
                          <div className="flex-1">
                            <span className="text-slate-200 font-semibold">万米极速高空速降 (Skydive)</span>
                            <p className="text-[11px] text-slate-500 mt-0.5">动作与搞笑兼备的自由落体滑行</p>
                          </div>
                        </div>
                        <div className="h-4.5 w-0.5 bg-slate-800 ml-3"></div>
                        <div className="flex items-start gap-2">
                          <div className="w-6 h-6 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold border border-blue-500/30 shrink-0">3</div>
                          <div className="flex-1">
                            <span className="text-blue-400 font-semibold">巍峨雪山滑雪特技 (Snow Slope)</span>
                            <p className="text-[11px] text-slate-500 mt-0.5">第一道时空传送门，少女丝滑滑雪</p>
                          </div>
                        </div>
                        <div className="h-4.5 w-0.5 bg-slate-800 ml-3"></div>
                        <div className="flex items-start gap-2">
                          <div className="w-6 h-6 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold border border-blue-500/30 shrink-0">4</div>
                          <div className="flex-1">
                            <span className="text-blue-400 font-semibold">深海绚丽珊瑚群 (Ocean Deep)</span>
                            <p className="text-[11px] text-slate-500 mt-0.5">第二道传送门，唯美治愈物质转质</p>
                          </div>
                        </div>
                        <div className="h-4.5 w-0.5 bg-slate-800 ml-3"></div>
                        <div className="flex items-start gap-2">
                          <div className="w-6 h-6 rounded-full bg-purple-600/20 text-purple-400 flex items-center justify-center font-bold border border-purple-500/30 shrink-0">5</div>
                          <div className="flex-1">
                            <span className="text-purple-400 font-semibold">梦幻糖果王国 (Candy Land)</span>
                            <p className="text-[11px] text-slate-500 mt-0.5">第三道传送门，狂狂荒诞色彩碰撞</p>
                          </div>
                        </div>
                        <div className="h-4.5 w-0.5 bg-slate-800 ml-3"></div>
                        <div className="flex items-start gap-2">
                          <div className="w-6 h-6 rounded-full bg-amber-600/20 text-amber-400 flex items-center justify-center font-bold border border-amber-500/30 shrink-0">6</div>
                          <div className="flex-1">
                            <span className="text-amber-400 font-semibold">远古遗迹废墟决战 (Desert Ruins)</span>
                            <p className="text-[11px] text-slate-500 mt-0.5">第四道传送门，热血决战异形怪兽军团</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB: CHARACTERS */}
            {activeTab === "characters" && (
              <div className="space-y-4">
                <h3 className="text-xs font-bold text-purple-400 uppercase tracking-widest mb-3 flex items-center">
                  <span className="w-1.5 h-1.5 bg-purple-400 rounded-full mr-2"></span>
                  探险小队成员画像 (Characters Dossier)
                </h3>
                
                <div className="grid grid-cols-1 gap-4">
                  {activeCharacters.length > 0 ? (
                    activeCharacters.map((char, idx) => (
                      <div 
                        key={idx}
                        onClick={() => setSelectedCharacter(char)}
                        className="flex items-start gap-4 p-4 bg-slate-900/60 hover:bg-slate-800/60 rounded-xl border border-slate-800 hover:border-purple-500/40 transition-all cursor-pointer group"
                      >
                        <div className="w-16 h-16 rounded-xl bg-slate-800 flex-shrink-0 border border-white/10 overflow-hidden relative shadow-inner">
                          {renderCharacterAvatar(char)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <h4 className="text-sm font-bold text-white group-hover:text-purple-400 transition-colors">{char.name}</h4>
                            <span className="text-[10px] px-2 py-0.5 bg-purple-950/60 text-purple-300 border border-purple-800/50 rounded-full font-medium shrink-0">
                              {char.role ? char.role.split(" (")[0] : "剧中人物"}
                            </span>
                          </div>
                          <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">{char.personality}</p>
                          <p className="text-[11px] text-slate-500 mt-1.5 truncate italic">服装：{char.clothing}</p>
                          
                          <div className="flex flex-wrap gap-1.5 mt-2.5">
                            {char.skills && char.skills.slice(0, 2).map((skill) => (
                              <span key={skill} className="text-[9px] px-1.5 py-0.5 bg-slate-950 text-slate-400 rounded font-mono">
                                {skill}
                              </span>
                            ))}
                            {!char.skills && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-slate-950 text-slate-500 rounded font-mono">
                                细节拆解中
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center text-slate-500 text-xs bg-slate-900/20 border border-slate-800 rounded-xl">
                      Gemini 未在此视频中检测到明显人物角色。
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: NARRATIVE & INSIGHTS */}
            {activeTab === "narrative" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-xs font-bold text-amber-400 uppercase tracking-widest mb-3 flex items-center">
                    <span className="w-1.5 h-1.5 bg-amber-400 rounded-full mr-2"></span>
                    三幕叙事结构分析 (Narrative Arc)
                  </h3>
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800/80">
                    <p className="text-xs text-slate-300 leading-relaxed font-normal">
                      {activeNarrative.structure || "暂无叙事结构数据"}
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-bold text-amber-400 uppercase tracking-widest mb-3 flex items-center">
                    <span className="w-1.5 h-1.5 bg-amber-400 rounded-full mr-2"></span>
                    视听剪辑节奏特点 (Edit & Audio Rhythm)
                  </h3>
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800/80">
                    <p className="text-xs text-slate-300 leading-relaxed font-normal">
                      {activeNarrative.rhythm || "暂无视听节奏数据"}
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-bold text-amber-400 uppercase tracking-widest mb-3 flex items-center">
                    <span className="w-1.5 h-1.5 bg-amber-400 rounded-full mr-2"></span>
                    爽点位置与戏剧冲突高潮点 (Spectacle Design)
                  </h3>
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800/80">
                    <p className="text-xs text-slate-300 leading-relaxed font-normal">
                      {activeNarrative.climaxDesign || "暂无爽点设计数据"}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "generator" && (
              <div className="space-y-6">
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

                    {/* BOTTOM SECTION: Shots Table */}
                    <div className="space-y-3">
                      <div className="flex justify-between items-center mb-1">
                        <h4 className="text-xs font-bold text-blue-400 uppercase tracking-widest flex items-center">
                          <Film className="w-4 h-4 mr-1.5 text-blue-400" />
                          全新分镜大纲脚本 (全宽表格)
                        </h4>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAnimaticModal(true);
                            fetchBgmList();
                          }}
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
                  </div>
                )}
              </div>
            )}

          </div>

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
          <div className="fixed inset-0 z-50 flex justify-end">
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
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="relative w-full max-w-md h-full bg-slate-900 border-l border-slate-850 shadow-2xl flex flex-col z-10"
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
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        handleGenerateThreeViews(activeDrawerChar);
                      }}
                      disabled={isGeneratingThreeViews}
                      className="mt-3 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-slate-800 disabled:text-slate-650 text-white rounded-lg text-[10px] flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      {isGeneratingThreeViews ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>生成三视图中...</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>生成三视图</span>
                        </>
                      )}
                    </button>
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
                              className="absolute bottom-1 right-1 p-1 bg-slate-950/80 hover:bg-slate-900 text-slate-300 hover:text-white rounded border border-white/10 opacity-0 group-hover/view:opacity-100 transition-opacity z-20 cursor-pointer"
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
                      </div>

                      {/* Side View Slot */}
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] text-slate-500 font-mono mb-1">侧</span>
                        <div className="w-full aspect-[2/3] rounded-lg overflow-hidden border border-white/5 bg-slate-900 relative group/view">
                          {activeDrawerChar.views?.side ? (
                            <img
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
                              className="absolute bottom-1 right-1 p-1 bg-slate-950/80 hover:bg-slate-900 text-slate-300 hover:text-white rounded border border-white/10 opacity-0 group-hover/view:opacity-100 transition-opacity z-20 cursor-pointer"
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
                      </div>

                      {/* Back View Slot */}
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] text-slate-500 font-mono mb-1">背</span>
                        <div className="w-full aspect-[2/3] rounded-lg overflow-hidden border border-white/5 bg-slate-900 relative group/view">
                          {activeDrawerChar.views?.back ? (
                            <img
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
                              className="absolute bottom-1 right-1 p-1 bg-slate-950/80 hover:bg-slate-900 text-slate-300 hover:text-white rounded border border-white/10 opacity-0 group-hover/view:opacity-100 transition-opacity z-20 cursor-pointer"
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
                          <img src={shotImg} alt={`Shot ${idx + 1}`} className="w-full h-full object-cover" />
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
