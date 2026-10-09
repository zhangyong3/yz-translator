import { generateSpeech, type SpeechResult } from "./shared/speech";
import { normalizeSpeechSettings, speechSupportsInstructions, type SpeechProvider, type SpeechSettings } from "./shared/speech-settings";

export interface GeneratedSpeech {
  text: string;
  provider: SpeechProvider;
  model: string;
  voice: string;
  blob: Blob;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
}

export class SpeechView {
  private settings = normalizeSpeechSettings();
  private text = "";
  private status = "选中网页文字后点击生成语音，也可以在这里输入文字。";
  private error = false;
  private controller?: AbortController;
  private result?: SpeechResult;
  private audio?: HTMLAudioElement;
  private url?: string;
  private speed = 1;
  private cache = new Map<string, SpeechResult>();
  private root = node("section", "speech-view");
  private playButton?: HTMLButtonElement;
  private progress?: HTMLInputElement;
  private currentTime?: HTMLElement;
  private duration?: HTMLElement;

  constructor(private beforePlay: () => void, private onGenerated: (speech: GeneratedSpeech) => Promise<void>) {}

  updateSettings(settings: SpeechSettings): void {
    if (JSON.stringify(settings) === JSON.stringify(this.settings)) return;
    this.cancel(); this.clearAudio(); this.cache.clear();
    this.settings = normalizeSpeechSettings(settings);
    this.status = "语音配置已载入"; this.error = false;
    this.render();
  }

  element(): HTMLElement { this.render(); return this.root; }
  pause(): void { this.audio?.pause(); }
  dispose(): void { this.cancel(); this.clearAudio(); this.cache.clear(); }

  private clearAudio(): void {
    this.audio?.pause();
    if (this.audio) { this.audio.removeAttribute("src"); this.audio.load(); }
    this.audio = undefined;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined; this.result = undefined;
  }

  private cancel(): void {
    this.controller?.abort(); this.controller = undefined;
  }

  async selectText(text: string): Promise<void> {
    this.text = text;
    await this.generate(false);
  }

  async openHistory(text: string, loadAudio: () => Promise<Blob | undefined>): Promise<void> {
    this.cancel(); this.clearAudio(); this.text = text; this.error = false;
    const controller = new AbortController(); this.controller = controller;
    this.status = "正在载入已保存的语音…"; this.render();
    try {
      const blob = await loadAudio();
      if (this.controller !== controller) return;
      if (!blob?.size) throw new Error("已保存的音频不存在，请重新生成语音");
      this.installAudio({ blob, extension: "wav", chunks: 1 });
      this.status = "已保存的语音 · 未调用接口";
    } catch (error) {
      if (this.controller !== controller) return;
      this.error = true; this.status = error instanceof Error ? error.message : "无法读取已保存的语音";
    } finally {
      if (this.controller === controller) { this.controller = undefined; this.render(); }
    }
  }

  private cacheKey(): string {
    const { provider, profiles } = this.settings;
    const profile = profiles[provider];
    return JSON.stringify([provider, profile.baseUrl, profile.apiKey, profile.model, profile.voice, speechSupportsInstructions(provider, profile.model) ? profile.instructions : "", this.text.trim()]);
  }

  private installAudio(result: SpeechResult): void {
    this.clearAudio(); this.result = result;
    this.url = URL.createObjectURL(result.blob);
    const audio = new Audio(this.url); this.audio = audio; audio.playbackRate = this.speed;
    const update = (event: Event) => {
      if (this.audio !== audio) return;
      if (["play", "pause", "ended"].includes(event.type)) {
        this.status = event.type === "play" ? "正在播放" : audio.ended ? "播放结束" : "已暂停";
        this.error = false;
        const status = this.root.querySelector(".speech-status");
        if (status) { status.textContent = this.status; status.className = "status speech-status"; status.setAttribute("role", "status"); }
      }
      this.updatePlayer();
    };
    for (const name of ["loadedmetadata", "timeupdate", "play", "pause", "ended", "durationchange"]) audio.addEventListener(name, update);
    audio.addEventListener("error", () => {
      if (this.audio !== audio) return;
      this.status = "音频播放失败，请重新生成"; this.error = true; this.render();
    });
  }

  private async generate(force: boolean): Promise<void> {
    this.cancel(); this.clearAudio(); this.error = false;
    const controller = new AbortController(); this.controller = controller;
    const key = this.cacheKey();
    if (!force && this.cache.has(key)) {
      const cached = this.cache.get(key)!; this.cache.delete(key); this.cache.set(key, cached);
      this.controller = undefined; this.installAudio(cached); this.status = "已使用本次侧栏缓存 · 未再次调用接口"; this.render(); return;
    }
    this.status = "正在生成语音…"; this.render();
    try {
      const { provider, profiles } = this.settings;
      const request = { ...profiles[provider], provider, text: this.text };
      const result = await generateSpeech(request,
        AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]), (done, total) => {
          if (this.controller !== controller) return;
          this.status = `正在生成语音 · ${Math.min(done + 1, total)} / ${total} 段`;
          const status = this.root.querySelector(".speech-status"); if (status) status.textContent = this.status;
        });
      if (this.controller !== controller) return;
      this.cache.delete(key); this.cache.set(key, result);
      while (this.cache.size > 6 || [...this.cache.values()].reduce((sum, item) => sum + item.blob.size, 0) > 20 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value!);
      this.installAudio(result); this.status = "语音已生成 · 可试听";
      try {
        await this.onGenerated({ text: request.text, provider, model: request.model, voice: request.voice, blob: result.blob });
      } catch {
        if (this.controller === controller) this.status = "语音已生成，但历史保存失败，请检查本地存储空间";
      }
    } catch (error) {
      if (this.controller !== controller) return;
      this.error = true;
      this.status = error instanceof DOMException && error.name === "TimeoutError" ? "语音生成超时，请重试" : error instanceof Error ? error.message : "语音生成失败，请重试";
    } finally {
      if (this.controller === controller) { this.controller = undefined; this.render(); }
    }
  }

  private updatePlayer(): void {
    const audio = this.audio; if (!audio) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (this.playButton) { this.playButton.textContent = audio.paused ? audio.ended ? "重播" : "播放" : "暂停"; this.playButton.setAttribute("aria-label", audio.paused ? "播放语音" : "暂停语音"); }
    if (this.progress) { this.progress.max = String(duration || 1); this.progress.value = String(audio.currentTime); this.progress.disabled = !duration; }
    const format = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
    if (this.currentTime) this.currentTime.textContent = format(audio.currentTime);
    if (this.duration) this.duration.textContent = format(duration);
  }

  private render(): void {
    const busy = Boolean(this.controller);
    this.root.replaceChildren();
    const heading = node("header", "translation-heading-row");
    heading.append(node("h1", "translation-title", "生成语音"));
    this.root.append(heading);
    const text = node("textarea", "sentence-input speech-text"); text.value = this.text; text.maxLength = 1200; text.placeholder = "选中网页文字后点击喇叭，或输入要朗读的文字"; text.setAttribute("aria-label", "要生成语音的文字");
    text.oninput = () => { this.text = text.value; this.cancel(); this.clearAudio(); this.status = "文字已更改，请生成语音"; this.error = false; this.refreshActions(); };
    this.root.append(text);
    const player = node("section", "speech-player"); player.setAttribute("aria-label", "语音播放器");
    const top = node("div", "speech-player-top");
    const status = node("p", this.error ? "error speech-status" : "status speech-status", this.status); status.setAttribute("role", this.error ? "alert" : "status");
    const generate = node("button", "secondary speech-generate speech-regenerate", this.result ? "重新生成" : "生成语音"); generate.disabled = busy || !this.text.trim(); generate.onclick = () => void this.generate(Boolean(this.result));
    top.append(status, generate); player.append(top);
    const actions = node("div", "actions speech-actions");
    if (busy) { const cancel = node("button", "secondary", "取消生成"); cancel.onclick = () => { this.cancel(); this.status = "已取消生成"; this.render(); }; actions.append(cancel); }
    if (busy) player.append(actions);
    if (this.result && this.audio) {
      const playback = node("div", "speech-playback");
      const controls = node("div", "speech-player-controls");
      this.playButton = node("button", "primary speech-play", "播放"); this.playButton.onclick = () => {
        const audio = this.audio!;
        if (!audio.paused) { audio.pause(); return; }
        this.beforePlay(); if (audio.ended) audio.currentTime = 0;
        void audio.play().catch(() => { if (audio !== this.audio) return; this.error = true; this.status = "无法播放音频，请重试"; this.render(); });
      };
      this.progress = node("input", "speech-progress"); this.progress.type = "range"; this.progress.min = "0"; this.progress.step = "0.1"; this.progress.setAttribute("aria-label", "播放进度"); this.progress.oninput = () => { if (this.audio) this.audio.currentTime = Number(this.progress!.value); };
      controls.append(this.playButton, this.progress); playback.append(controls);
      const times = node("div", "speech-time"); this.currentTime = node("span"); this.duration = node("span"); times.append(this.currentTime, this.duration); playback.append(times);
      const footer = node("div", "speech-player-footer");
      const speedField = node("label", "speech-speed", "播放速度");
      const speed = node("select", "text-input"); for (const value of [0.75, 1, 1.25, 1.5, 2]) { const option = node("option", "", `${value}×`); option.value = String(value); speed.append(option); } speed.value = String(this.speed);
      speed.onchange = () => { this.speed = Number(speed.value); if (this.audio) this.audio.playbackRate = this.speed; }; speedField.append(speed);
      const download = node("button", "secondary speech-download", "下载音频"); download.onclick = () => { const link = node("a"); link.href = this.url!; link.download = `yz-speech-${Date.now()}.wav`; this.root.append(link); link.click(); link.remove(); };
      footer.append(speedField, download); playback.append(footer); player.append(playback); this.updatePlayer();
    }
    this.root.append(player);
    this.root.append(node("p", "muted speech-note", "朗读原文；播放调速不会重新调用接口。生成成功后按历史设置保存原文与音频，可从历史再次试听和下载。"));
  }

  private refreshActions(): void {
    const button = this.root.querySelector<HTMLButtonElement>(".speech-generate"); if (button) { button.disabled = !this.text.trim(); button.textContent = "生成语音"; }
    this.root.querySelector(".speech-playback")?.remove();
    this.root.querySelector(".speech-actions button.secondary")?.remove();
    const status = this.root.querySelector(".speech-status"); if (status) { status.className = "status speech-status"; status.setAttribute("role", "status"); status.textContent = this.status; }
  }
}
