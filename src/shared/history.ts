export interface HistoryEntry {
  id: string;
  type: "word" | "translation";
  text: string;
  result?: string;
  createdAt: number;
  sourceTitle?: string;
  sourceUrl?: string;
}

const DB_NAME = "yz-translator-history";
const STORE = "entries";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
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

export async function addHistory(entry: Omit<HistoryEntry, "id" | "createdAt">, limit: number): Promise<void> {
  if (limit <= 0) return;
  const id = crypto.randomUUID();
  await transaction("readwrite", (store) => store.put({ ...entry, id, createdAt: Date.now() }));
  const entries = await listHistory();
  for (const old of entries.slice(limit)) await deleteHistory(old.id);
}

export async function trimHistory(limit: number): Promise<void> {
  const entries = await listHistory();
  for (const old of entries.slice(Math.max(0, limit))) await deleteHistory(old.id);
}

export async function deleteHistory(id: string): Promise<void> {
  await transaction("readwrite", (store) => store.delete(id));
}

export async function clearHistory(): Promise<void> {
  await transaction("readwrite", (store) => store.clear());
}
