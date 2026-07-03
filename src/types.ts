export interface Shot {
  id?: string;
  timestamp: string;
  timeSeconds: number;
  movement: string;
  composition: string;
  emotion: string;
  description: string;
  imageUrl?: string;
  generatedImageUrl?: string;
  style?: string;
  videoUrl?: string;
  videoTaskId?: string;
  videoStatus?: 'submitted' | 'processing' | 'succeed' | 'failed';
  characterIds?: string[];
  characterNames?: string[];
  matchedCharacterIds?: string[];
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
}



