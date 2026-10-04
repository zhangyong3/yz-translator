import Mdict from "@tubetitle/mdict-browser";
import { getOfflineDictionaryFile, getOfflineDictionaryCss, getOfflineDictionaryResourceFiles } from "./offline-dictionary";
import { selectDictionaryCandidates } from "./dictionary-lookup";
import { sanitizeDictionaryHtml } from "./dictionary-sanitize";
import { loadDictionaryCss } from "./dictionary-presentation";
import { prepareDictionaryAudio } from "./dictionary-audio";

export interface LookupResult {
  word: string;
  html?: string;
  css?: string;
  suggestions: string[];
  audioUrls: string[];
  error?: string;
}

let dictionaryPromise: Promise<Mdict> | undefined;
let resourcesPromise: Promise<Mdict[]> | undefined;

export function resetDictionaryCache(): void {
  dictionaryPromise = undefined;
  resourcesPromise = undefined;
}

async function getDictionary(): Promise<Mdict> {
  dictionaryPromise ??= (async () => {
    const file = await getOfflineDictionaryFile();
    if (!file) throw new Error("请先在设置中导入 MDX 词典");
    return Mdict.build(file);
  })().catch((error) => { dictionaryPromise = undefined; throw error; });
  return dictionaryPromise;
}

async function getResources(): Promise<Mdict[]> {
  resourcesPromise ??= (async () => {
    const files = await getOfflineDictionaryResourceFiles();
    return Promise.all(files.map((file) => Mdict.build(file)));
  })().catch((error) => { resourcesPromise = undefined; throw error; });
  return resourcesPromise;
}

export async function lookupWord(word: string): Promise<LookupResult> {
  const query = word.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/g, " ");
  if (!query || query.length > 120) return { word: query, suggestions: [], audioUrls: [], error: "请选择较短的单词或短语" };
  try {
    const dictionary = await getDictionary();
    const candidates = await dictionary.getWordList(query);
    const { exact, suggestions } = selectDictionaryCandidates(query, candidates);
    if (!exact) return { word: query, suggestions, audioUrls: [] };
    const definition = await dictionary.getDefinition(exact.offset);
    const css = await loadDictionaryCss(dictionary, definition, await getOfflineDictionaryCss());
    const audio = await prepareDictionaryAudio(sanitizeDictionaryHtml(definition), await getResources());
    return { word: exact.word, html: audio.html, css, suggestions, audioUrls: audio.urls };
  } catch (error) {
    return { word: query, suggestions: [], audioUrls: [], error: error instanceof Error ? error.message : String(error) };
  }
}
