import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(join(tmpdir(), "yz-speech-test-"));
await build({ entryPoints: ["src/shared/speech.ts", "src/shared/speech-settings.ts", "src/shared/settings.ts"], outdir: dir, bundle: true, format: "esm", platform: "node" });
const speech = await import(pathToFileURL(join(dir, "speech.js")));
const config = await import(pathToFileURL(join(dir, "speech-settings.js")));
const settings = await import(pathToFileURL(join(dir, "settings.js")));
after(() => rm(dir, { recursive: true, force: true }));

let permission = true;
globalThis.chrome = { permissions: { contains: async () => permission }, storage: { local: { get: async () => ({ settings: { llmApiKey: "translation-secret" } }) } } };
let contextsClosed = 0;
globalThis.AudioContext = class {
  sampleRate = 24000;
  async decodeAudioData(bytes) {
    assert.ok(bytes.byteLength > 0);
    return { length: 3, numberOfChannels: 2, getChannelData: channel => new Float32Array(channel ? [-0.5, 0, 0.5] : [0.5, 0, 0.5]) };
  }
  async close() { contextsClosed++; }
};
const profile = config.normalizeSpeechSettings().profiles.aliyun;
const request = { ...profile, provider: "aliyun", apiKey: "speech-secret", text: "A clear English sentence." };

test("existing settings receive independent speech defaults", async () => {
  const result = await settings.getSettings();
  assert.equal(result.llmApiKey, "translation-secret");
  assert.equal(result.speech.provider, "aliyun");
  assert.equal(result.speech.profiles.aliyun.apiKey, "");
  result.speech.profiles.aliyun.voice = "changed";
  assert.equal((await settings.getSettings()).speech.profiles.aliyun.voice, "Cherry");
});

test("long multilingual selection splits without lost characters or broken surrogate pairs", () => {
  const text = ("An English sentence. 中英文😀混合句子。\n").repeat(35);
  const chunks = speech.splitSpeechText(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text.trim());
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 600));
  assert.ok(chunks.every(chunk => !chunk.startsWith("\ude00") && !chunk.endsWith("\ud83d")));
});

test("WAV header, PCM clipping, and file size are valid", async () => {
  const blob = speech.encodeWav(new Float32Array([-2, 0, 2]), 24000);
  const bytes = await blob.arrayBuffer(); const view = new DataView(bytes);
  assert.equal(blob.type, "audio/wav");
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});

test("Qwen splits requests and combines decoded audio; download does not carry credentials", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "POST") return Response.json({ output: { audio: { url: "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?Signature=example" } } });
    assert.equal(init.headers, undefined);
    assert.equal(init.credentials, "omit");
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const stages = [];
  const text = "word ".repeat(220);
  const result = await speech.generateSpeech({ ...request, text, instructions: "should be omitted" }, new AbortController().signal, (done, total) => stages.push([done, total]));
  const posts = calls.filter(call => call.init.method === "POST");
  assert.equal(result.chunks, 2); assert.equal(posts.length, 2);
  assert.ok(posts.every(call => Array.from(JSON.parse(call.init.body).input.text).length <= 600));
  assert.ok(posts.every(call => JSON.parse(call.init.body).input.instructions === undefined));
  assert.equal(posts.map(call => JSON.parse(call.init.body).input.text).join(""), text.trim());
  assert.equal(calls[1].url.startsWith("https://"), true);
  assert.equal((await result.blob.arrayBuffer()).byteLength, 56);
  assert.deepEqual(stages.at(-1), [2, 2]);
  assert.ok(contextsClosed > 0);
});

test("OpenAI-compatible adapter uses speech endpoint and instruct model preserves instructions", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://tts.example/v1/audio/speech");
    assert.equal(init.headers.Authorization, "Bearer speech-secret");
    assert.deepEqual(JSON.parse(init.body), { model: "custom-tts", voice: "reader", input: request.text, response_format: "wav", instructions: "Clear and slow" });
    return new Response(new Uint8Array([1]), { headers: { "Content-Type": "audio/wav" } });
  };
  await speech.generateSpeech({ ...request, provider: "openai", baseUrl: "https://tts.example/v1/", model: "custom-tts", voice: "reader", instructions: "Clear and slow" }, new AbortController().signal);
});

test("bad configuration, unsupported protocol models, and revoked permissions never make paid calls", async () => {
  globalThis.fetch = async () => { assert.fail("unexpected request"); };
  await assert.rejects(() => speech.generateSpeech({ ...request, apiKey: "" }, new AbortController().signal), /API Key/);
  await assert.rejects(() => speech.generateSpeech({ ...request, model: "qwen3-tts-flash-realtime" }, new AbortController().signal), /非实时/);
  permission = false;
  await assert.rejects(() => speech.generateSpeech(request, new AbortController().signal), /授权/);
  permission = true;
});

test("untrusted audio URL rejected before download", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ output: { audio: { url: "https://attacker.example/private" } } }); };
  await assert.rejects(() => speech.generateSpeech(request, new AbortController().signal), /音频地址/);
  assert.equal(calls, 1);
});

test("HTTP failures produce actionable error and close decoder", async () => {
  const before = contextsClosed;
  globalThis.fetch = async () => new Response("do not expose provider body or secret", { status: 429 });
  await assert.rejects(() => speech.generateSpeech(request, new AbortController().signal), /HTTP 429/);
  assert.equal(contextsClosed, before + 1);
});

test("aborted generation skips later chunks", async () => {
  const controller = new AbortController(); let calls = 0;
  globalThis.fetch = async () => { calls++; controller.abort(); return Response.json({ output: { audio: { data: "AQ==" } } }); };
  await assert.rejects(() => speech.generateSpeech({ ...request, text: "word ".repeat(220) }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("settings reject unsafe base URLs and preserve separate profiles", () => {
  for (const url of ["file:///tmp/a", "https://key@example.com/v1", "https://example.com/v1?key=secret"]) assert.throws(() => config.httpUrl(url));
  const settings = config.normalizeSpeechSettings();
  settings.profiles.openai.apiKey = "separate-key";
  assert.equal(settings.profiles.aliyun.apiKey, "");
  assert.equal(config.speechSupportsInstructions("openai", "tts-1"), false);
  assert.equal(config.speechSupportsInstructions("aliyun", "qwen3-tts-instruct-flash"), true);
});
