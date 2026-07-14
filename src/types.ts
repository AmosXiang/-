export interface Shot {
  id?: string;
  timestamp: string;
  timeSeconds: number;
  movement: string;
  composition: string;
  emotion: string;
  description: string;
  optimizedPrompt?: string;
  imageUrl?: string;
  generatedImageUrl?: string;
  style?: string;
  videoUrl?: string;
  videoTaskId?: string;
  videoStatus?: 'submitted' | 'processing' | 'succeed' | 'failed';
  characterIds?: string[];
  characterNames?: string[];
  matchedCharacterIds?: string[];
  scriptConfirmed?: boolean;
  camera?: {
    move: 'push_in' | 'pull_out' | 'static' | 'follow' | 'pan' | 'tilt' | 'handheld';
    speed: 'slow' | 'medium' | 'fast';
    note: string;
  };
  framing?: {
    shotSize: 'extreme_close' | 'close_up' | 'medium_close' | 'medium' | 'full' | 'wide';
    angle: 'front' | 'side' | 'back' | 'high' | 'low' | 'pov';
  };
  blocking?: Array<{
    characterId: string;
    layer: 'foreground' | 'midground' | 'background';
    position: 'left' | 'center' | 'right';
    gaze: 'camera' | 'frame_left' | 'frame_right' | 'away' | `at_character:${string}`;
    outOfFocus: boolean;
  }>;
  durationSec?: number;
  provenance?: 'analyzed' | 'edited' | 'ai_optimized';
  // 机位派生(camera derive):结构化机位参数与主帧派生关系。
  // A1 确认:shots 存于 SQLite store 表的 generated_scripts JSON 文档内,
  // 因此这些字段是 JSON 字段而非表列;全部可选,旧记录天然兼容。
  cameraH?: 'front' | 'front_right' | 'right' | 'back_right' | 'back' | 'back_left' | 'left' | 'front_left';
  cameraV?: 'low' | 'eye' | 'elevated' | 'high';
  cameraZoom?: 'close_up' | 'medium_cu' | 'medium' | 'full' | 'wide';
  isMaster?: boolean;                 // 本场(项目)主帧,项目内至多一个
  derivedFromShotId?: string;         // 派生来源镜头 id;无 = 非派生
  cameraPromptUsed?: string;          // 实际注入的完整英文机位指令(审计/复现)
}

export interface Character {
  id?: string;
  name: string;
  alias?: string | string[];
  aliases?: string[];
  role: string;
  personality: string;
  clothing: string;
  avatarUrl?: string;
  avatarImageUrl?: string;
  sourceTaskId?: string | null;
  hasReference?: boolean;
  avatarGeneration?: {
    presetId: string;
    model: string;
    imageUrl: string;
    taskId: string;
  };
  views?: {
    front: string;
    side: string;
    back: string;
  };
  viewGenerations?: Partial<Record<'front' | 'side' | 'back', {
    presetId: string;
    model: string;
    imageUrl: string;
    taskId: string;
  }>>;
  quote?: string;
  skills?: string[];
}

export interface Narrative {
  structure: string;
  rhythm: string;
  climaxDesign: string;
}

export interface VideoAnalysis {
  shots: Shot[];
  characters: Character[];
  narrative: Narrative;
}

export interface VideoRecord {
  id: string;
  filename: string;
  filepath: string;
  url: string;
  title: string;
  genre: string;
  tags: string[];
  analysis: VideoAnalysis;
  createdAt: string;
}

export interface GeneratedScript {
  newTitle: string;
  newNarrative: {
    structure: string;
    rhythm: string;
    climaxDesign: string;
  };
  newCharacters: Character[];
  newShots: Shot[];
}

export interface GeneratedScriptRecord extends GeneratedScript {
  id: string;
  templateId: string;
  templateTitle: string;
  topic: string;
  createdAt: string;
  sourceScriptId?: string | null;
  artDirection?: { overlay: string; analysis?: unknown; updatedAt?: string };
}



