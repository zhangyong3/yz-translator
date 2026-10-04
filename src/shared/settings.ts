export interface Settings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  historyLimit: number;
  saveSource: boolean;
  dictionaryName: string;
}

export const DEFAULT_SETTINGS: Settings = {
  llmBaseUrl: "https://api.openai.com/v1",
  llmApiKey: "",
  llmModel: "gpt-4.1-mini",
  historyLimit: 100,
  saveSource: false,
  dictionaryName: ""
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
