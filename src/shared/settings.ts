import { normalizeSpeechSettings, type SpeechSettings } from "./speech-settings";

export interface Settings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  historyLimit: number;
  saveSource: boolean;
  dictionaryName: string;
  speech: SpeechSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  llmBaseUrl: "https://api.openai.com/v1",
  llmApiKey: "",
  llmModel: "gpt-4.1-mini",
  historyLimit: 100,
  saveSource: false,
  dictionaryName: "",
  speech: normalizeSpeechSettings()
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  const saved = settings as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...saved, speech: normalizeSpeechSettings(saved?.speech) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
