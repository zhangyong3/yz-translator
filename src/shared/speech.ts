import { httpUrl, speechPermissionOrigins, speechSupportsInstructions, type SpeechProfile, type SpeechProvider } from "./speech-settings";

export interface SpeechRequest extends SpeechProfile { provider: SpeechProvider; text: string }
export interface SpeechResult { blob: Blob; extension: "wav"; chunks: number }
type Adapter = (request: SpeechRequest, signal: AbortSignal) => Promise<ArrayBuffer>;

/** Split at punctuation/word boundaries without losing any selected text. */
export function splitSpeechText(text: string, limit = 600): string[] {
  const chars = Array.from(text.trim());
  const chunks: string[] = [];
  while (chars.length) {
    let end = Math.min(chars.length, limit);
    if (chars.length > limit) {
      const minimum = Math.floor(limit / 2);
      for (let i = end - 1; i >= minimum; i--) {
        if (/[.!?。！？;；\n]/u.test(chars[i]) && (i === end - 1 || /\s/u.test(chars[i + 1]) || /[。！？；]/u.test(chars[i]))) { end = i + 1; break; }
      }
      if (end === limit) {
        for (let i = end - 1; i >= minimum; i--) if (/\s/u.test(chars[i])) { end = i + 1; break; }
      }
    }
    chunks.push(chars.splice(0, end).join(""));
  }
  return chunks;
}

async function post(request: SpeechRequest, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const base = httpUrl(request.baseUrl.replace(/\/+$/, ""));
  const url = new URL(base.href.replace(/\/+$/, "") + path);
  const response = await fetch(url, {
    method: "POST", headers: { Authorization: `Bearer ${request.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal
  });
  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403 ? "，请检查密钥和权限" : response.status === 429 ? "，请检查额度或稍后重试" : "";
    throw new Error(`语音生成失败（HTTP ${response.status}${detail}）`);
  }
  return response;
}

const openai: Adapter = async (request, signal) => {
  const response = await post(request, "/audio/speech", {
    model: request.model, voice: request.voice, input: request.text, response_format: "wav",
    ...(request.instructions && speechSupportsInstructions(request.provider, request.model) ? { instructions: request.instructions } : {})
  }, signal);
  if (response.headers.get("content-type")?.includes("json")) throw new Error("语音接口返回了 JSON，预期为音频文件；请检查接口协议与模型");
  return response.arrayBuffer();
};

const aliyun: Adapter = async (request, signal) => {
  if (!request.model.startsWith("qwen3-tts-") || request.model.includes("realtime")) {
    throw new Error("百炼适配器目前支持 qwen3-tts 非实时系列，请选择 Flash 或 Instruct Flash 模型");
  }
  const response = await post(request, "/services/aigc/multimodal-generation/generation", {
    model: request.model,
    input: { text: request.text, voice: request.voice, language_type: "Auto",
      ...(request.instructions && speechSupportsInstructions(request.provider, request.model) ? { instructions: request.instructions } : {}) }
  }, signal);
  const data = await response.json() as { code?: string; output?: { audio?: { data?: string; url?: string } } };
  if (data.code) throw new Error(`百炼语音服务返回错误（${data.code}），请检查模型、音色和额度`);
  const audio = data.output?.audio;
  // Prefer the complete file URL: inline data may be raw PCM rather than a WAV container.
  if (audio?.url) {
    const url = new URL(audio.url);
    if (url.protocol === "http:" && url.hostname.endsWith(".aliyuncs.com")) url.protocol = "https:";
    if (url.protocol !== "https:" || !url.hostname.endsWith(".aliyuncs.com") || url.username || url.password) {
      throw new Error("语音服务返回了不受支持的音频地址");
    }
    if (!await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) throw new Error("请在设置中重新保存语音配置，授权访问百炼音频域名");
    // Do not attach the API key to a returned download URL.
    const file = await fetch(url, { signal, credentials: "omit" });
    if (!file.ok) throw new Error(`音频下载失败（HTTP ${file.status}）`);
    return file.arrayBuffer();
  }
  if (audio?.data) return Uint8Array.from(atob(audio.data), c => c.charCodeAt(0)).buffer;
  throw new Error("语音服务没有返回音频");
};

const adapters: Record<SpeechProvider, Adapter> = { aliyun, openai };

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { const s = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true); });
  return new Blob([buffer], { type: "audio/wav" });
}

export async function generateSpeech(request: SpeechRequest, signal: AbortSignal, progress: (done: number, total: number) => void = () => {}): Promise<SpeechResult> {
  if (!request.text.trim() || Array.from(request.text).length > 1200) throw new Error("请选择不超过 1200 字符的文字");
  if (!request.apiKey || !request.model || !request.voice) throw new Error("请先在设置中填写语音 API Key、模型和音色");
  if (!await chrome.permissions.contains({ origins: [speechPermissionOrigins(request.provider, request.baseUrl)[0]] })) throw new Error("请先在设置中保存语音配置并授权接口域名");
  const chunks = splitSpeechText(request.text, request.provider === "aliyun" ? 600 : 1200);
  const audioContext = new AudioContext({ sampleRate: 24000 });
  const parts: Float32Array[] = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      signal.throwIfAborted();
      progress(i, chunks.length);
      const bytes = await adapters[request.provider]({ ...request, text: chunks[i] }, signal);
      signal.throwIfAborted();
      if (!bytes.byteLength) throw new Error("语音服务返回了空音频");
      let decoded: AudioBuffer;
      try { decoded = await audioContext.decodeAudioData(bytes); }
      catch { throw new Error("返回音频无法解码，请确认服务支持 WAV 音频输出"); }
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const samples = decoded.getChannelData(channel);
        for (let j = 0; j < mono.length; j++) mono[j] += samples[j] / decoded.numberOfChannels;
      }
      parts.push(mono);
    }
    signal.throwIfAborted();
    const samples = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { samples.set(part, offset); offset += part.length; }
    progress(chunks.length, chunks.length);
    return { blob: encodeWav(samples, audioContext.sampleRate), extension: "wav", chunks: chunks.length };
  } finally { await audioContext.close(); }
}
