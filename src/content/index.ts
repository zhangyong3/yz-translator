export {};

const host = document.createElement("div");
host.style.cssText = "all:initial;position:fixed;inset:0;width:0;height:0;z-index:2147483647;pointer-events:none";
const shadow = host.attachShadow({ mode: "closed" });
const toolbar = document.createElement("div");
toolbar.innerHTML = `
  <button type="button" data-action="word" title="查词" aria-label="查词">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.2c-2.8-1.8-6.1-1.9-9-.6v13c2.9-1.3 6.2-1.2 9 .6m0-13c2.8-1.8 6.1-1.9 9-.6v13c-2.9-1.3-6.2-1.2-9 .6m0-13v13"/></svg>
  </button>
  <button type="button" data-action="translate" title="译整句" aria-label="译整句">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 5.5h9m-4.5-2v2m3.2 0c-.5 3.1-2.5 5.6-5.7 7.2m-1.4-5c1.1 2.4 3.4 4.7 6.5 6.1M14 20l3.7-9 3.8 9m-6.3-3h5.2"/></svg>
  </button>
  <button type="button" data-action="speech" title="生成语音" aria-label="生成语音">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5m4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>
  </button>`;
const style = document.createElement("style");
style.textContent = `
  .toolbar{position:fixed;display:flex;gap:2px;padding:3px;border:1px solid #d9e0e8;border-radius:12px;background:#fff;box-shadow:0 5px 18px #10182833;pointer-events:auto}
  .toolbar[hidden]{display:none!important}
  button{display:grid;width:34px;height:34px;place-items:center;border:0;border-radius:8px;padding:0;background:#fff;color:#26364b;cursor:pointer}
  button:hover{background:#edf4ff;color:#185bc3}
  button:focus-visible{outline:2px solid #3575db;outline-offset:1px}
  svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
`;
toolbar.className = "toolbar";
toolbar.hidden = true;
shadow.append(style, toolbar);
document.documentElement.append(host);

let selectedText = "";
let anchor = { x: 0, y: 0 };

function readSelection(): { text: string; x: number; y: number } | undefined {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active instanceof HTMLInputElement && !["text", "search", "url", "email", "tel"].includes(active.type)) return;
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    const text = active.value.slice(start, end).trim();
    if (text) {
      const rect = active.getBoundingClientRect();
      return { text, x: Math.min(rect.right, innerWidth - 10), y: rect.bottom };
    }
  }
  const selection = getSelection();
  if (!selection || selection.isCollapsed) return;
  const text = selection.toString().trim();
  if (!text) return;
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  return { text, x: rect.right, y: rect.bottom };
}

function showToolbar(pointer?: { x: number; y: number }): void {
  const value = readSelection();
  if (!value || value.text.length > 1200) { toolbar.hidden = true; return; }
  selectedText = value.text;
  anchor = pointer ?? { x: value.x, y: value.y };
  toolbar.hidden = false;
  const bounds = toolbar.getBoundingClientRect();
  let left = anchor.x + 12;
  let top = anchor.y + 12;
  if (left + bounds.width > innerWidth - 8) left = anchor.x - bounds.width - 12;
  if (top + bounds.height > innerHeight - 8) top = anchor.y - bounds.height - 12;
  toolbar.style.left = `${Math.max(8, Math.min(left, innerWidth - bounds.width - 8))}px`;
  toolbar.style.top = `${Math.max(8, Math.min(top, innerHeight - bounds.height - 8))}px`;
}

document.addEventListener("mouseup", (event) => {
  if (event.composedPath().includes(host)) return;
  const pointer = { x: event.clientX, y: event.clientY };
  setTimeout(() => showToolbar(pointer), 0);
});
document.addEventListener("keyup", (event) => {
  if (event.key === "Escape") { toolbar.hidden = true; return; }
  if (event.key === "Shift" || event.key.startsWith("Arrow")) setTimeout(showToolbar, 0);
});
document.addEventListener("pointerdown", (event) => {
  if (event.composedPath().includes(host)) return;
  toolbar.hidden = true;
}, true);
window.addEventListener("scroll", () => { toolbar.hidden = true; }, true);

toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
toolbar.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
  if (!button || !selectedText) return;
  if (button.dataset.action === "word") {
    toolbar.hidden = true;
    void chrome.runtime.sendMessage({ type: "OPEN_DICTIONARY", text: selectedText, sourceTitle: document.title, sourceUrl: location.href });
  } else if (button.dataset.action === "speech") {
    toolbar.hidden = true;
    void chrome.runtime.sendMessage({ type: "OPEN_SPEECH", text: selectedText });
  } else {
    toolbar.hidden = true;
    void chrome.runtime.sendMessage({ type: "OPEN_TRANSLATION", text: selectedText, sourceTitle: document.title, sourceUrl: location.href });
  }
});
