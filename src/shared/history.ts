import type { SpeechProvider } from "./speech-settings";

export interface HistoryEntry {
  id: string;
  type: "word" | "translation" | "speech";
  text: string;
  result?: string;
  createdAt: number;
  sourceTitle?: string;
  sourceUrl?: string;
  speech?: { provider: SpeechProvider; model: string; voice: string };
}

const DB_NAME = "yz-translator-history";
const STORE = "entries";
const AUDIO_STORE = "audio";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(AUDIO_STORE)) request.result.createObjectStore(AUDIO_STORE);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开历史记录"));
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = operation(tx.objectStore(STORE));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("历史记录操作失败")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("历史记录操作已取消")); };
  });
}

export async function listHistory(): Promise<HistoryEntry[]> {
  const entries = await transaction<HistoryEntry[]>("readonly", (store) => store.getAll());
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

async function writeHistory(operation: (entries: IDBObjectStore, audio: IDBObjectStore) => void): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, AUDIO_STORE], "readwrite");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error("历史记录保存失败，可能是本地存储空间不足")); };
    try { operation(tx.objectStore(STORE), tx.objectStore(AUDIO_STORE)); }
    catch (error) { tx.abort(); db.close(); reject(error); }
  });
}

export async function getHistoryAudio(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, "readonly");
    const request = tx.objectStore(AUDIO_STORE).get(id);
    tx.oncomplete = () => { db.close(); resolve(request.result as Blob | undefined); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error("无法读取已保存的语音")); };
  });
}

export async function addHistory(entry: Omit<HistoryEntry, "id" | "createdAt"> & { audio?: Blob }, limit: number): Promise<void> {
  if (limit <= 0) return;
  const id = crypto.randomUUID();
  const { audio, ...metadata } = entry;
  if (entry.type === "speech" && !audio?.size) throw new Error("没有可保存的语音音频");
  // Commit metadata and audio together; listing history does not load large audio blobs.
  await writeHistory((entries, files) => {
    if (entry.type === "word") {
      // Read and update in one transaction so simultaneous lookups cannot add duplicates.
      const request = entries.getAll();
      request.onsuccess = () => {
        const history = request.result as HistoryEntry[];
        const word = entry.text.trim().toLowerCase();
        const matches = history.filter((old) => old.type === "word" && old.text.trim().toLowerCase() === word)
          .sort((a, b) => b.createdAt - a.createdAt);
        const existing = matches[0];
        const createdAt = Math.max(Date.now(), ...history.map((old) => old.createdAt + 1));
        entries.put(existing ? { ...existing, createdAt } : { ...metadata, id, createdAt });
        for (const duplicate of matches.slice(1)) {
          entries.delete(duplicate.id);
          files.delete(duplicate.id);
        }
      };
      return;
    }
    entries.put({ ...metadata, id, createdAt: Date.now() });
    if (audio) files.put(audio, id);
  });
  const entries = await listHistory();
  for (const old of entries.slice(limit)) await deleteHistory(old.id);
}

export async function trimHistory(limit: number): Promise<void> {
  const entries = await listHistory();
  for (const old of entries.slice(Math.max(0, limit))) await deleteHistory(old.id);
}

export async function deleteHistory(id: string): Promise<void> {
  await writeHistory((entries, audio) => { entries.delete(id); audio.delete(id); });
}

export async function clearHistory(): Promise<void> {
  await writeHistory((entries, audio) => { entries.clear(); audio.clear(); });
}
