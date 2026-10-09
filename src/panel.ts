import { getSettings, type Settings } from "./shared/settings";
import { listHistory, addHistory, deleteHistory, clearHistory, getHistoryAudio, type HistoryEntry } from "./shared/history";
import { lookupWord, type LookupResult } from "./shared/dictionary";
import { SpeechView } from "./speech-view";
import { normalizeSpeechSettings } from "./shared/speech-settings";
type Tab = "translate" | "word" | "speech" | "history";
interface Query { id: string; text: string; createdAt?: number; sourceTitle?: string; sourceUrl?: string }

const app = document.getElementById("app")!;
const nav = document.createElement("nav");
nav.className = "tabs";
const main = document.createElement("main");
main.className = "panel-main";
app.append(nav, main);
let tab: Tab = "translate";
let settings: Settings;
let currentQuery: Query | undefined;
let lastQueryId = "";
let port: chrome.runtime.Port | undefined;
let analysisText = "";
let analysisStatus = "";
let analysisQueue: string[] = [];
let streamFinished = false;
let streamError = "";
let typewriterTimer: number | undefined;
let historyEntries: HistoryEntry[] = [];
let word = "";
let wordResult: LookupResult | undefined;
let wordStatus = "";
let wordRequestId = 0;
let activeAudio: HTMLAudioElement | undefined;
let activeAudioUrls: string[] = [];
const speechView = new SpeechView(() => activeAudio?.pause(), async (speech) => {
  const currentSettings = await getSettings();
  await addHistory({ type: "speech", text: speech.text, audio: speech.blob,
    speech: { provider: speech.provider, model: speech.model, voice: speech.voice } }, currentSettings.historyLimit);
  await refreshHistory();
});
window.addEventListener("pagehide", () => speechView.dispose());

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function showTab(next: Tab): void {
  if (next !== "speech") speechView.pause();
  if (next === "speech") activeAudio?.pause();
  tab = next;
  render();
  if (next === "history") void refreshHistory();
}

function render(): void {
  main.classList.toggle("word-view", tab === "word");
  nav.replaceChildren();
  for (const [name, label] of [["translate", "整句翻译"], ["word", "查词"], ["speech", "语音"], ["history", "历史"]] as const) {
    const button = el("button", name === tab ? "active" : "", label);
    button.onclick = () => showTab(name);
    nav.append(button);
  }
  main.replaceChildren();
  if (tab === "translate") renderTranslate();
  if (tab === "word") renderWord();
  if (tab === "speech") main.append(speechView.element());
  if (tab === "history") renderHistory();
}

function renderTranslate(): void {
  const title = el("header", "translation-header");
  const heading = el("div", "translation-heading-row");
  const pageTitle = el("h1", "translation-title", "句子解读");
  const copyButton = el("button", "copy-note-button", "复制 Markdown");
  copyButton.type = "button";
  copyButton.onclick = () => { void copyTranslationNote(copyButton); };
  heading.append(pageTitle, copyButton);
  title.append(heading);

  const output = el("div", "analysis-output");
  renderAnalysis(output, currentQuery?.text ?? "选中网页文本后点击译整句。", analysisText);
  if (analysisStatus) output.append(el("div", "status translation-status", analysisStatus));
  main.append(title, output);
}

type AnalysisSection = { title: "翻译" | "难点拆解" | "句法结构" | "语境与语气"; body: string };

function parseAnalysis(text: string): AnalysisSection[] {
  const heading = /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\*\*)?(翻译|难点拆解|句法结构|句法|语境与语气)(?:\*\*)?\s*[:：]\s*(?:\*\*)?/g;
  const matches = [...text.matchAll(heading)];
  const sections: AnalysisSection[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const rawTitle = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length;
    const title = rawTitle === "句法" ? "句法结构" : rawTitle as AnalysisSection["title"];
    sections.push({ title, body: text.slice(start, end).trim() });
  }
  return sections;
}

function splitAnalysisEntries(body: string): string[] {
  const lines = body.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const entries: string[] = [];
  for (const line of lines) {
    const item = line.replace(/^(?:[-*•]+|\d+[.)、])\s*/, "");
    if (item !== line || !entries.length) entries.push(item);
    else entries[entries.length - 1] += ` ${item}`;
  }
  return entries;
}

function parseAnalysisEntry(item: string): { term: string; explanation: string; example: string } {
  const boundary = item.search(/[:：—–]/);
  let term = boundary > 0 ? item.slice(0, boundary).trim() : "";
  let explanation = boundary > 0 ? item.slice(boundary + 1).trim() : item;
  const exampleMatch = explanation.match(/(?:例句|例)\s*[:：]?\s*/);
  const example = exampleMatch ? explanation.slice((exampleMatch.index ?? 0) + exampleMatch[0].length).trim() : "";
  if (exampleMatch) explanation = explanation.slice(0, exampleMatch.index).trim().replace(/[，,;；。\s]+$/, "");
  if (/^(?:\*\*)?要点(?:\s*\d+)?(?:\*\*)?$/.test(term)) term = "";
  if (/^(?:要点|无|暂无|无内容|暂无内容|不适用|N\/A)[。.!！\s]*$/i.test(explanation)) explanation = "";
  return { term, explanation, example };
}

function analysisEntries(body: string): ReturnType<typeof parseAnalysisEntry>[] {
  return splitAnalysisEntries(body).map(parseAnalysisEntry).filter((entry) => entry.explanation || entry.example);
}

function buildMarkdownNote(originalText: string, text: string): string {
  const sections = parseAnalysis(text);
  const translation = sections.find((section) => section.title === "翻译")?.body ?? "";
  const lines = ["# 句子解读", "", "## 英文原句", "", originalText, "", "## 中文翻译", "", translation];
  for (const section of sections) {
    if (section.title === "翻译" || !section.body) continue;
    const entries = analysisEntries(section.body);
    if (!entries.length) continue;
    const title = section.title === "难点拆解" ? "表达与难点" : section.title;
    lines.push("", `## ${title}`, "");
    for (const { term, explanation, example } of entries) {
      lines.push(term ? `- **${term}**：${explanation}` : `- ${explanation}`);
      if (example) {
        const firstChinese = example.search(/[\u3400-\u9fff]/);
        if (firstChinese > 0) {
          lines.push(`  - ${example.slice(0, firstChinese).trim()}`, `  - ${example.slice(firstChinese).trim()}`);
        } else lines.push(`  - ${example}`);
      }
    }
  }
  return lines.join("\n").trim();
}

async function copyTranslationNote(button: HTMLButtonElement): Promise<void> {
  const note = buildMarkdownNote(currentQuery?.text ?? "", analysisText);
  try {
    await navigator.clipboard.writeText(note);
  } catch {
    const buffer = el("textarea", "clipboard-buffer");
    buffer.value = note;
    document.body.append(buffer);
    buffer.select();
    const copied = document.execCommand("copy");
    buffer.remove();
    if (!copied) { button.textContent = "复制失败"; return; }
  }
  button.textContent = "已复制";
  window.setTimeout(() => { if (button.isConnected) button.textContent = "复制 Markdown"; }, 1600);
}

function renderAnalysis(target: HTMLElement, originalText: string, text: string): void {
  target.replaceChildren();
  const sentence = el("section", "sentence-card");
  sentence.append(el("p", "sentence-original", originalText));
  sentence.append(el("div", "sentence-divider"));
  const sections = parseAnalysis(text);
  const translation = sections.find((section) => section.title === "翻译")?.body;
  sentence.append(el("p", "sentence-translation", translation || (text ? "" : "等待翻译内容…")));
  target.append(sentence);

  for (const section of sections) {
    if (section.title === "翻译" || !section.body) continue;
    const entries = analysisEntries(section.body);
    if (!entries.length) continue;
    const card = el("section", "analysis-section");
    card.append(el("h2", "section-heading", section.title === "难点拆解" ? "表达与难点" : section.title));
    const list = el("div", "analysis-list");
    for (const { term, explanation, example: exampleText } of entries) {
      const entry = el("article", "analysis-entry");
      if (term) entry.append(el("h3", "analysis-entry-title", term));
      if (explanation) entry.append(el("p", "analysis-entry-text", explanation));
      if (exampleText) {
        const example = el("div", "analysis-example");
        const firstChinese = exampleText.search(/[\u3400-\u9fff]/);
        if (firstChinese > 0) {
          example.append(el("p", "example-english", exampleText.slice(0, firstChinese).trim()));
          example.append(el("p", "example-chinese", exampleText.slice(firstChinese).trim()));
        } else example.append(el("p", "example-english", exampleText));
        entry.append(example);
      }
      list.append(entry);
    }
    card.append(list);
    target.append(card);
  }
}

function renderWord(): void {
  const row = el("div", "lookup-row");
  const input = el("input", "text-input");
  input.placeholder = "输入单词或短语";
  input.value = word;
  const button = el("button", "primary", "查词");
  const search = () => { void searchDictionary(input.value.trim()); };
  button.onclick = search;
  input.onkeydown = (event) => { if (event.key === "Enter") search(); };
  row.append(input, button);
  main.append(row);
  if (!word) {
    main.append(el("p", "muted", "选择网页中的单词后点击查词，释义会显示在这里。"));
    return;
  }
  const section = el("section", "dictionary-result");
  section.append(el("h1", "dictionary-word", wordResult?.word ?? word));
  if (wordStatus) section.append(el("p", "status", wordStatus));
  if (wordResult?.error) section.append(el("p", "error", wordResult.error));
  else if (wordResult?.html) {
    const definition = wordResult;
    const frame = el("iframe", "definition-frame");
    frame.title = "离线词典释义";
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.addEventListener("load", () => renderDefinition(frame, definition));
    frame.srcdoc = "<!doctype html><html><head></head><body></body></html>";
    section.append(frame);
  } else if (!wordStatus && wordResult) {
    section.append(el("p", "muted", "词典中没有找到完整匹配的词条。"));
  }
  if (wordResult?.suggestions.length && !wordResult.html) {
    const suggestions = el("div", "suggestions");
    suggestions.append(el("span", "muted", "相近词："));
    for (const suggestion of wordResult.suggestions) {
      const choice = el("button", "chip", suggestion);
      choice.onclick = () => void searchDictionary(suggestion);
      suggestions.append(choice);
    }
    section.append(suggestions);
  }
  main.append(section);
}

function renderDefinition(frame: HTMLIFrameElement, result: LookupResult): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  const style = doc.createElement("style");
  style.textContent = `body{margin:12px;font:14px/1.6 system-ui,sans-serif;color:#233044;overflow-wrap:anywhere}a,[data-sound]{cursor:pointer;color:#2166b5}${result.css ?? ""}`;
  doc.head.replaceChildren(style);
  doc.body.innerHTML = result.html ?? "";
  const audioStatus = doc.createElement("p");
  audioStatus.setAttribute("role", "status");
  audioStatus.style.cssText = "margin:8px 0;color:#af3131;font-size:12px";
  audioStatus.hidden = true;
  doc.body.append(audioStatus);
  doc.addEventListener("click", (event) => {
    // iframe nodes use a different Element constructor from the parent page.
    const node = event.target as Node | null;
    const target = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
    if (!target) return;
    const sound = target.closest<HTMLElement>("[data-sound]");
    if (sound) {
      event.preventDefault();
      const url = sound.dataset.audioUrl;
      audioStatus.hidden = true;
      if (url) {
        speechView.pause();
        activeAudio?.pause();
        const audio = new Audio(url);
        activeAudio = audio;
        void audio.play().catch(() => {
          if (activeAudio !== audio) return;
          audioStatus.textContent = "发音播放失败，请检查音频格式是否受 Chrome 支持。";
          audioStatus.hidden = false;
        });
      } else {
        audioStatus.textContent = "未找到发音资源，请在设置中重新导入包含配套 MDD 文件的词典目录。";
        audioStatus.hidden = false;
      }
      return;
    }
    const link = target.closest<HTMLElement>("[data-entry]");
    if (link?.dataset.entry) { event.preventDefault(); void searchDictionary(link.dataset.entry); }
  });
}

async function searchDictionary(query: string, source?: Query): Promise<void> {
  const requestId = ++wordRequestId;
  activeAudio?.pause();
  for (const url of activeAudioUrls) URL.revokeObjectURL(url);
  activeAudioUrls = [];
  word = query.trim();
  if (!word) return;
  wordResult = undefined;
  wordStatus = "正在查词…";
  showTab("word");
  const result = await lookupWord(word);
  if (requestId !== wordRequestId) {
    for (const url of result.audioUrls) URL.revokeObjectURL(url);
    return;
  }
  wordResult = result;
  wordStatus = "";
  activeAudioUrls = result.audioUrls;
  render();
  const currentSettings = await getSettings();
  await addHistory({ type: "word", text: result.word, ...(currentSettings.saveSource && source ? { sourceTitle: source.sourceTitle, sourceUrl: source.sourceUrl } : {}) }, currentSettings.historyLimit);
  await refreshHistory();
}

function renderHistory(): void {
  const heading = el("div", "heading-row");
  heading.append(el("h1", "page-title", "历史记录"));
  const clear = el("button", "secondary", "清空全部");
  clear.onclick = async () => { await clearHistory(); historyEntries = []; render(); };
  heading.append(clear);
  main.append(heading);
  if (!historyEntries.length) { main.append(el("p", "muted", "暂无记录。")); return; }
  for (const entry of historyEntries) {
    const item = el("article", "history-item");
    const title = el("button", "history-title", entry.text);
    title.onclick = () => {
      if (entry.type === "word") { void searchDictionary(entry.text); }
      else if (entry.type === "speech") {
        showTab("speech");
        void speechView.openHistory(entry.text, () => getHistoryAudio(entry.id));
      }
      else {
        currentQuery = { id: entry.id, text: entry.text };
        analysisText = entry.result ?? "";
        analysisStatus = "已保存的翻译";
        showTab("translate");
      }
    };
    const meta = el("small", "muted", `${entry.type === "word" ? "查词" : entry.type === "speech" ? "语音" : "翻译"} · ${new Date(entry.createdAt).toLocaleString()}`);
    const remove = el("button", "remove-button", "删除");
    remove.onclick = async () => { await deleteHistory(entry.id); await refreshHistory(); };
    item.append(title, meta);
    if (entry.result) {
      const preview = entry.result.replace(/^\s*(?:翻译|translation)\s*[:：]\s*/i, "");
      item.append(el("p", "history-preview", preview.slice(0, 140)));
    }
    if (entry.sourceTitle) item.append(el("small", "muted", entry.sourceTitle));
    item.append(remove);
    main.append(item);
  }
}

async function refreshHistory(): Promise<void> {
  historyEntries = await listHistory();
  if (tab === "history") render();
}

async function startTranslation(query: Query): Promise<void> {
  if (!query.text.trim()) { analysisStatus = "请输入英文句子"; render(); return; }
  port?.disconnect();
  if (typewriterTimer !== undefined) window.clearInterval(typewriterTimer);
  typewriterTimer = undefined;
  currentQuery = query;
  analysisText = "";
  analysisQueue = [];
  streamFinished = false;
  streamError = "";
  analysisStatus = "模型正在生成…";
  showTab("translate");
  const nextPort = chrome.runtime.connect({ name: "translate" });
  port = nextPort;
  nextPort.onMessage.addListener((value: { delta?: string; done?: boolean; error?: string }) => {
    if (port !== nextPort) return;
    if (value.delta) {
      analysisQueue.push(...value.delta);
      startTypewriter(query);
    }
    if (value.error) {
      streamError = value.error;
      streamFinished = true;
      port = undefined;
      nextPort.disconnect();
      startTypewriter(query);
    }
    if (value.done) {
      streamFinished = true;
      port = undefined;
      nextPort.disconnect();
      startTypewriter(query);
    }
  });
  nextPort.onDisconnect.addListener(() => {
    if (port === nextPort) { port = undefined; analysisStatus = "连接中断，请重试"; if (tab === "translate") render(); }
  });
  nextPort.postMessage({ text: query.text });
}

function startTypewriter(query: Query): void {
  if (typewriterTimer !== undefined) return;
  typewriterTimer = window.setInterval(() => {
    if (analysisQueue.length) {
      const count = analysisQueue.length > 100 ? 4 : 2;
      analysisText += analysisQueue.splice(0, count).join("");
      if (tab === "translate") {
        const output = main.querySelector<HTMLElement>(".analysis-output");
        if (output) {
          renderAnalysis(output, query.text, analysisText);
          if (analysisStatus) output.append(el("div", "status translation-status", analysisStatus));
        }
        else render();
      }
      return;
    }
    if (!streamFinished) {
      if (typewriterTimer !== undefined) window.clearInterval(typewriterTimer);
      typewriterTimer = undefined;
      return;
    }
    if (typewriterTimer !== undefined) window.clearInterval(typewriterTimer);
    typewriterTimer = undefined;
    analysisStatus = streamError || "翻译完成";
    if (tab === "translate") {
      const status = main.querySelector<HTMLElement>(".status");
      if (status) status.textContent = analysisStatus;
      else render();
    }
    if (!streamError && analysisText.trim()) {
      void addHistory({ type: "translation", text: query.text, result: analysisText,
        ...(settings.saveSource ? { sourceTitle: query.sourceTitle, sourceUrl: query.sourceUrl } : {}) }, settings.historyLimit).then(refreshHistory);
    }
  }, 22);
}

async function receiveQuery(query: Query | undefined): Promise<void> {
  if (!query?.text || query.id === lastQueryId) return;
  lastQueryId = query.id;
  await startTranslation(query);
  await chrome.storage.local.remove("translateQuery");
}

async function receiveDictionaryQuery(query: Query | undefined): Promise<void> {
  if (!query?.text || query.id === lastQueryId) return;
  lastQueryId = query.id;
  await searchDictionary(query.text, query);
  await chrome.storage.local.remove("dictionaryQuery");
}

async function receiveSpeechQuery(query: Query | undefined): Promise<void> {
  if (!query?.text || query.id === lastQueryId) return;
  lastQueryId = query.id;
  showTab("speech");
  // Consume immediately so closing/reopening the panel cannot repeat a paid request.
  await chrome.storage.local.remove("speechQuery");
  await speechView.selectText(query.text);
}

async function init(): Promise<void> {
  settings = await getSettings();
  speechView.updateSettings(settings.speech);
  await refreshHistory();
  render();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings?.newValue) {
      settings = changes.settings.newValue as Settings;
      settings.speech = normalizeSpeechSettings(settings.speech);
      speechView.updateSettings(settings.speech);
    }
    if (changes.translateQuery?.newValue) void receiveQuery(changes.translateQuery.newValue as Query);
    if (changes.dictionaryQuery?.newValue) void receiveDictionaryQuery(changes.dictionaryQuery.newValue as Query);
    if (changes.speechQuery?.newValue) void receiveSpeechQuery(changes.speechQuery.newValue as Query);
  });
  const { translateQuery, dictionaryQuery, speechQuery } = await chrome.storage.local.get(["translateQuery", "dictionaryQuery", "speechQuery"]);
  const pending = [translateQuery, dictionaryQuery, speechQuery].filter(Boolean) as Query[];
  pending.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  const newest = pending[0];
  if (newest) {
    if (newest.id === (speechQuery as Query | undefined)?.id) void receiveSpeechQuery(newest);
    else if (newest.id === (dictionaryQuery as Query | undefined)?.id) void receiveDictionaryQuery(newest);
    else void receiveQuery(newest);
  }
}

void init();
