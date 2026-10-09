export type SpeechProvider = "aliyun" | "openai";
export interface SpeechProfile {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
}
export interface SpeechSettings {
  provider: SpeechProvider;
  profiles: Record<SpeechProvider, SpeechProfile>;
}

export const SPEECH_PROVIDERS = {
  aliyun: { label: "阿里云百炼 · 千问 TTS", models: ["qwen3-tts-flash", "qwen3-tts-instruct-flash"], voices: ["Cherry", "Serena", "Ethan", "Chelsie"] },
  openai: { label: "OpenAI 兼容语音接口", models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"], voices: ["alloy", "coral", "nova", "onyx", "shimmer"] }
} as const;

export function normalizeSpeechSettings(value?: Partial<SpeechSettings>): SpeechSettings {
  return {
    provider: value?.provider === "openai" ? "openai" : "aliyun",
    profiles: {
      aliyun: { baseUrl: "https://dashscope.aliyuncs.com/api/v1", apiKey: "", model: "qwen3-tts-flash", voice: "Cherry", instructions: "", ...value?.profiles?.aliyun },
      openai: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini-tts", voice: "coral", instructions: "", ...value?.profiles?.openai }
    }
  };
}

export function speechSupportsInstructions(provider: SpeechProvider, model: string): boolean {
  return provider === "aliyun" ? model.startsWith("qwen3-tts-instruct-flash") : !["tts-1", "tts-1-hd"].includes(model);
}

export function httpUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("接口地址须为 HTTP/HTTPS，且不能包含账号、查询参数或片段");
  }
  return url;
}

export function speechPermissionOrigins(provider: SpeechProvider, baseUrl: string): string[] {
  const url = httpUrl(baseUrl);
  const origins = [`${url.origin}/*`];
  // Qwen returns temporary OSS audio URLs, separately from its API endpoint.
  if (provider === "aliyun") origins.push("https://*.aliyuncs.com/*");
  return origins;
}
