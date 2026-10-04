import { getSettings, saveSettings, type Settings } from "./shared/settings";
import { trimHistory } from "./shared/history";
import { selectDictionaryDirectoryFiles } from "./shared/dictionary-directory";
import {
  saveOfflineDictionary, saveOfflineDictionaryCss, saveOfflineDictionaryResources,
  removeOfflineDictionary, removeOfflineDictionaryCss, removeOfflineDictionaryResources
} from "./shared/offline-dictionary";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`找不到设置控件：${id}`);
  return node as T;
}

const directoryInput = byId<HTMLInputElement>("dictionary-files");
const directoryCurrent = byId<HTMLElement>("dictionary-current");
const directoryStatus = byId<HTMLElement>("dictionary-status");
const settingsStatus = byId<HTMLElement>("settings-status");
const baseInput = byId<HTMLInputElement>("llm-base");
const keyInput = byId<HTMLInputElement>("llm-key");
const modelInput = byId<HTMLInputElement>("llm-model");
const limitInput = byId<HTMLInputElement>("history-limit");
const sourceInput = byId<HTMLInputElement>("save-source");
let settings: Settings;

function updateDictionaryLabel(): void {
  directoryCurrent.textContent = settings.dictionaryName ? `已导入：${settings.dictionaryName}` : "尚未导入词典";
  byId<HTMLButtonElement>("dictionary-remove").disabled = !settings.dictionaryName;
}

byId<HTMLButtonElement>("dictionary-import").addEventListener("click", () => directoryInput.click());
directoryInput.addEventListener("change", async () => {
  const files = [...(directoryInput.files ?? [])];
  directoryInput.value = "";
  if (!files.length) return;
  directoryStatus.textContent = "正在导入词典…";
  try {
    const bundle = selectDictionaryDirectoryFiles(files);
    await navigator.storage.persist?.();
    await saveOfflineDictionary(bundle.mdx);
    if (bundle.css) await saveOfflineDictionaryCss(bundle.css);
    else await removeOfflineDictionaryCss();
    if (bundle.mddFiles.length) await saveOfflineDictionaryResources(bundle.mddFiles);
    else await removeOfflineDictionaryResources();
    settings.dictionaryName = `${bundle.directoryName} / ${bundle.mdx.name}`;
    await saveSettings(settings);
    updateDictionaryLabel();
    directoryStatus.textContent = `导入完成：${bundle.mdx.name}`;
  } catch (error) {
    directoryStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

byId<HTMLButtonElement>("dictionary-remove").addEventListener("click", async () => {
  directoryStatus.textContent = "正在移除词典…";
  try {
    await Promise.all([removeOfflineDictionary(), removeOfflineDictionaryCss(), removeOfflineDictionaryResources()]);
    settings.dictionaryName = "";
    await saveSettings(settings);
    updateDictionaryLabel();
    directoryStatus.textContent = "词典已移除";
  } catch (error) {
    directoryStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

byId<HTMLFormElement>("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsStatus.textContent = "正在保存…";
  try {
    const baseUrl = baseInput.value.trim().replace(/\/+$/, "");
    const url = new URL(baseUrl);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("API 地址必须使用 HTTP 或 HTTPS");
    const model = modelInput.value.trim();
    if (!model) throw new Error("请填写模型名");
    const limit = Number(limitInput.value);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) throw new Error("历史条数应为 0–1000 的整数");
    const origin = `${url.protocol}//${url.host}/*`;
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error("需要允许扩展访问所配置的 API 域名");
    settings = {
      ...settings,
      llmBaseUrl: baseUrl,
      llmApiKey: keyInput.value.trim(),
      llmModel: model,
      historyLimit: limit,
      saveSource: sourceInput.checked
    };
    await saveSettings(settings);
    await trimHistory(limit);
    settingsStatus.textContent = "设置已保存";
  } catch (error) {
    settingsStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

async function init(): Promise<void> {
  settings = await getSettings();
  baseInput.value = settings.llmBaseUrl;
  keyInput.value = settings.llmApiKey;
  modelInput.value = settings.llmModel;
  limitInput.value = String(settings.historyLimit);
  sourceInput.checked = settings.saveSource;
  updateDictionaryLabel();
}

void init().catch((error: unknown) => {
  settingsStatus.textContent = error instanceof Error ? error.message : String(error);
});
