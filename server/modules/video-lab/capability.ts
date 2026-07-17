export type GenerationModes = {
  textToVideo: boolean;
  imageToVideo: boolean;
  firstLastFrame: boolean;
};

export type VideoProviderCapability = {
  id: string;
  label: string;
  supportedModes: GenerationModes;
  durations: number[];
  resolutions: string[];
  aspectRatios: string[];
  fpsOptions: number[];
  supportsAudio: boolean;
  supportsNativeCameraControl: boolean;
  minSubmitIntervalMs?: number;
};

// Keep this declaration limited to behavior proven by the existing Agnes
// request pipeline in server.ts. In particular, normalized_size is a response
// field and must not be treated as an input capability.
export const AGNES_VIDEO_CAPABILITY: VideoProviderCapability = {
  id: 'agnes',
  label: 'Agnes Video v2.0',
  supportedModes: {
    textToVideo: true,
    imageToVideo: false,
    firstLastFrame: false,
  },
  durations: [3, 5, 10, 18],
  resolutions: ['1152x768'],
  aspectRatios: ['3:2'],
  fpsOptions: [24],
  supportsAudio: false,
  supportsNativeCameraControl: false,
  minSubmitIntervalMs: 61_000,
};

export const VIDEO_PROVIDER_CAPABILITIES: VideoProviderCapability[] = [AGNES_VIDEO_CAPABILITY];
