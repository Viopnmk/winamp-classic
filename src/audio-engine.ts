export interface TrackInfo {
  id: string
  artist: string
  title: string
  album: string
  genre: string
  marqueeTitle: string
  duration: number
  kbps: number
  khz: number
  stereo: boolean
  bpm: number
  rootMidi: number
  fileUrl?: string
  sunoUrl?: string
  lyrics?: string
}

export const DEFAULT_TRACKS: TrackInfo[] = [
  {
    id: "noodle-synth-groove",
    artist: "NOODLEAMP",
    title: "合成演示曲（程序合成）",
    album: "内置合成演示",
    genre: "程序合成 · Web Audio",
    marqueeTitle: "& NOODLEAMP - 合成演示曲（程序合成）   ",
    duration: 64,
    kbps: 320,
    khz: 44,
    stereo: true,
    bpm: 118,
    rootMidi: 53,
    lyrics: `[说明]
这首曲子没有音频文件，是播放器用 Web Audio 实时合成的
点左上角「文件 → 打开文件」导入你自己的歌曲
导入的歌存在浏览器本地（IndexedDB），刷新不会丢

[歌词]
切到「歌词」标签页，可以为任意歌曲导入 .lrc 歌词文件
也可以粘贴带时间轴的 LRC 歌词，播放时会自动同步高亮`,
  },
]

export const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000] as const

export type PlaybackStatus = "playing" | "paused" | "stopped"

export class WinampAudioEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private eqFilters: BiquadFilterNode[] = []
  private mediaEl: HTMLAudioElement | null = null
  private mediaSource: MediaElementAudioSourceNode | null = null

  private synthTimer: number | null = null
  private nextStepTime = 0
  private stepIndex = 0

  public tracks: TrackInfo[] = [...DEFAULT_TRACKS]
  public trackIndex = 0
  // Starts in visually-playing snapshot at 0:06 matching reference.png;
  // live Web Audio starts cleanly upon first user gesture.
  public status: PlaybackStatus = "playing"
  public liveAudioRunning = false
  public currentTime = 0.0
  public volume = 98 // 0..100 (matches reference.png volume slider thumb at ~98%)
  public muted = false
  public repeat = true // Matches reference.png lit blue Repeat LED & LCD icon
  public shuffle = false
  public eqEnabled = false // Matches reference.png ghosted EQ badge inside LCD
  public eqAuto = false
  public preampDb = 0
  public eqGains: number[] = [0, 2, 3, 1, 0, -1, 1, 2, 3, 2]

  private lastTickPerf = 0
  private freqBuf = new Uint8Array(128)
  private waveBuf = new Uint8Array(128)
  private onUpdateCallbacks = new Set<() => void>()

  public get currentTrack(): TrackInfo {
    return this.tracks[this.trackIndex] ?? DEFAULT_TRACKS[0]!
  }

  public onChange(cb: () => void): () => void {
    this.onUpdateCallbacks.add(cb)
    return () => this.onUpdateCallbacks.delete(cb)
  }

  private emit(): void {
    for (const cb of this.onUpdateCallbacks) cb()
  }

  private ensureAudioGraph(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctor()

      const analyser = this.ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.72
      this.analyser = analyser
      this.freqBuf = new Uint8Array(analyser.frequencyBinCount)
      this.waveBuf = new Uint8Array(analyser.frequencyBinCount)

      const gain = this.ctx.createGain()
      this.masterGain = gain

      // Build 10-band Winamp EQ chain
      this.eqFilters = EQ_FREQUENCIES.map((freq, idx) => {
        const f = this.ctx!.createBiquadFilter()
        f.type = idx === 0 ? "lowshelf" : idx === EQ_FREQUENCIES.length - 1 ? "highshelf" : "peaking"
        f.frequency.value = freq
        f.Q.value = 1.4
        f.gain.value = this.eqEnabled ? (this.eqGains[idx] ?? 0) : 0
        return f
      })

      let prev: AudioNode = this.eqFilters[0]!
      for (let i = 1; i < this.eqFilters.length; i++) {
        prev.connect(this.eqFilters[i]!)
        prev = this.eqFilters[i]!
      }
      prev.connect(analyser)
      analyser.connect(gain)
      gain.connect(this.ctx.destination)
      this.syncGain()
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume()
    }
    return this.ctx
  }

  private get eqInputNode(): AudioNode {
    this.ensureAudioGraph()
    return this.eqFilters[0]!
  }

  private syncGain(): void {
    if (!this.masterGain || !this.ctx) return
    const preampMul = this.eqEnabled ? Math.pow(10, this.preampDb / 20) : 1
    const v = this.muted ? 0 : Math.min(1.1, Math.pow(this.volume / 100, 1.6) * 0.45 * preampMul)
    this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015)
  }

  public setPreamp(db: number): void {
    this.preampDb = Math.max(-12, Math.min(12, db))
    this.syncGain()
    this.emit()
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(100, vol))
    this.syncGain()
    this.emit()
  }

  public setMuted(muted: boolean): void {
    this.muted = muted
    this.syncGain()
    this.emit()
  }

  public setRepeat(repeat: boolean): void {
    this.repeat = repeat
    if (this.mediaEl) this.mediaEl.loop = repeat && this.tracks.length === 1
    this.emit()
  }

  public setShuffle(shuffle: boolean): void {
    this.shuffle = shuffle
    this.emit()
  }

  public setEqEnabled(enabled: boolean): void {
    this.eqEnabled = enabled
    if (this.ctx) {
      this.eqFilters.forEach((f, idx) => {
        f.gain.setTargetAtTime(enabled ? (this.eqGains[idx] ?? 0) : 0, this.ctx!.currentTime, 0.02)
      })
    }
    this.emit()
  }

  public setEqBand(index: number, db: number): void {
    this.eqGains[index] = Math.max(-12, Math.min(12, db))
    if (this.ctx && this.eqFilters[index]) {
      this.eqFilters[index]!.gain.setTargetAtTime(
        this.eqEnabled ? this.eqGains[index]! : 0,
        this.ctx.currentTime,
        0.02,
      )
    }
    this.emit()
  }

  public async play(): Promise<void> {
    const ctx = this.ensureAudioGraph()
    await ctx.resume()

    if (this.status === "stopped") {
      this.currentTime = 0
    }
    this.status = "playing"
    this.liveAudioRunning = true
    this.lastTickPerf = performance.now()

    const track = this.currentTrack
    if (track.fileUrl) {
      this.stopSynthScheduler()
      await this.playMediaElement(track.fileUrl)
    } else {
      if (this.mediaEl) this.mediaEl.pause()
      this.startSynthScheduler()
    }
    this.emit()
  }

  public pause(): void {
    if (this.status === "playing" && this.liveAudioRunning) {
      this.status = "paused"
      this.liveAudioRunning = false
      this.stopSynthScheduler()
      if (this.mediaEl) this.mediaEl.pause()
    } else if (this.status === "paused") {
      void this.play()
      return
    } else {
      // Initial snapshot state -> pause freezes at current time
      this.status = "paused"
      this.liveAudioRunning = false
    }
    this.emit()
  }

  public stop(): void {
    this.status = "stopped"
    this.liveAudioRunning = false
    this.currentTime = 0
    this.stopSynthScheduler()
    if (this.mediaEl) {
      this.mediaEl.pause()
      this.mediaEl.currentTime = 0
    }
    this.emit()
  }

  public seek(seconds: number): void {
    const clamped = Math.max(0, Math.min(this.currentTrack.duration, seconds))
    this.currentTime = clamped
    if (this.mediaEl && this.currentTrack.fileUrl) {
      this.mediaEl.currentTime = clamped
    }
    this.emit()
  }

  public selectTrack(index: number, autoPlay = true): void {
    if (index < 0 || index >= this.tracks.length) return
    this.trackIndex = index
    this.currentTime = 0
    this.stepIndex = 0
    if (autoPlay) {
      void this.play()
    } else {
      this.emit()
    }
  }

  public next(): void {
    if (this.shuffle && this.tracks.length > 1) {
      let idx = this.trackIndex
      while (idx === this.trackIndex) {
        idx = Math.floor(Math.random() * this.tracks.length)
      }
      this.selectTrack(idx, true)
      return
    }
    const nextIdx = this.trackIndex + 1
    if (nextIdx < this.tracks.length) {
      this.selectTrack(nextIdx, true)
    } else if (this.repeat) {
      this.selectTrack(0, true)
    } else {
      this.stop()
    }
  }

  public previous(): void {
    if (this.currentTime > 4) {
      this.seek(0)
      if (!this.liveAudioRunning) void this.play()
      return
    }
    const prevIdx = (this.trackIndex - 1 + this.tracks.length) % this.tracks.length
    this.selectTrack(prevIdx, true)
  }

  public async loadFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files)
    if (list.length === 0) return

    let firstAddedIndex = -1
    for (const file of list) {
      const url = URL.createObjectURL(file)
      const duration = await this.probeDuration(url)
      const stem = file.name.replace(/\.[^.]+$/, "").toUpperCase()
      const parts = stem.split(" - ")
      const artist = parts.length > 1 ? parts[0]!.trim() : "本地文件"
      const title = parts.length > 1 ? parts.slice(1).join(" - ").trim() : stem
      const info: TrackInfo = {
        id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        artist,
        title,
        album: "导入的音乐",
        genre: "本地文件",
        marqueeTitle: `& ${artist} - ${title}   `,
        duration: Math.max(1, Math.round(duration || 180)),
        kbps: 320,
        khz: 44,
        stereo: true,
        bpm: 120,
        rootMidi: 53,
        fileUrl: url,
      }
      this.tracks.push(info)
      if (firstAddedIndex === -1) firstAddedIndex = this.tracks.length - 1
    }
    if (firstAddedIndex !== -1) {
      this.selectTrack(firstAddedIndex, true)
    }
  }

  private probeDuration(url: string): Promise<number> {
    return new Promise((resolve) => {
      const a = new Audio()
      a.preload = "metadata"
      let settled = false
      const done = (d: number) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        a.onloadedmetadata = null
        a.onerror = null
        resolve(Number.isFinite(d) && d > 0 ? d : 180)
      }
      const timer = window.setTimeout(() => done(180), 3000)
      a.onloadedmetadata = () => done(a.duration)
      a.onerror = () => done(180)
      a.src = url
    })
  }

  public removeTracks(indicesToRemove: Set<number>): void {
    if (this.tracks.length <= 1 || indicesToRemove.size === 0) return
    const currentId = this.currentTrack.id
    const remaining: TrackInfo[] = []
    this.tracks.forEach((track, idx) => {
      if (indicesToRemove.has(idx) && remaining.length + (this.tracks.length - idx - 1) >= 1) {
        if (track.fileUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(track.fileUrl)
        }
      } else {
        remaining.push(track)
      }
    })
    if (remaining.length === 0) return
    this.tracks = remaining
    const preservedIdx = this.tracks.findIndex((t) => t.id === currentId)
    if (preservedIdx !== -1) {
      this.trackIndex = preservedIdx
      this.emit()
    } else {
      this.trackIndex = Math.min(this.trackIndex, this.tracks.length - 1)
      const wasRunning = this.liveAudioRunning && this.status === "playing"
      this.stop()
      if (wasRunning) {
        void this.play()
      } else {
        this.emit()
      }
    }
  }

  private async playMediaElement(url: string): Promise<void> {
    const ctx = this.ensureAudioGraph()
    if (!this.mediaEl) {
      this.mediaEl = new Audio()
      this.mediaEl.crossOrigin = "anonymous"
      this.mediaEl.addEventListener("ended", () => {
        if (this.repeat && this.tracks.length === 1) {
          this.seek(0)
          void this.play()
        } else {
          this.next()
        }
      })
      this.mediaEl.addEventListener("loadedmetadata", () => {
        if (this.mediaEl && Number.isFinite(this.mediaEl.duration) && this.mediaEl.duration > 0) {
          this.currentTrack.duration = Math.round(this.mediaEl.duration)
          this.emit()
        }
      })
      this.mediaSource = ctx.createMediaElementSource(this.mediaEl)
      this.mediaSource.connect(this.eqInputNode)
    }
    const resolvedUrl = new URL(url, window.location.href).href
    if (this.mediaEl.src !== resolvedUrl) {
      this.mediaEl.src = resolvedUrl
    }
    this.mediaEl.currentTime = Math.min(this.currentTime, Math.max(0, this.currentTrack.duration - 0.25))
    await this.mediaEl.play()
  }

  private startSynthScheduler(): void {
    this.stopSynthScheduler()
    const ctx = this.ensureAudioGraph()
    this.nextStepTime = ctx.currentTime + 0.03
    this.synthTimer = window.setInterval(() => this.scheduleSteps(), 25)
  }

  private stopSynthScheduler(): void {
    if (this.synthTimer !== null) {
      clearInterval(this.synthTimer)
      this.synthTimer = null
    }
  }

  private midiToHz(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12)
  }

  private scheduleSteps(): void {
    if (!this.ctx || !this.liveAudioRunning) return
    const track = this.currentTrack
    const stepDur = 60 / track.bpm / 4 // 16th note

    while (this.nextStepTime < this.ctx.currentTime + 0.12) {
      this.triggerGrooveStep(this.stepIndex, this.nextStepTime, stepDur, track)
      this.nextStepTime += stepDur
      this.stepIndex = (this.stepIndex + 1) % 64
    }
  }

  // Procedural Web Audio synth fallback for tracks without an audio file URL
  private triggerGrooveStep(step: number, t: number, stepDur: number, track: TrackInfo): void {
    const ctx = this.ctx!
    const dest = this.eqInputNode
    const barStep = step % 16
    const bar = Math.floor(step / 16) % 4
    const root = track.rootMidi

    // 1. Punchy Kick on 0, 6, 8, 14
    if (barStep === 0 || barStep === 8 || (bar % 2 === 1 && barStep === 14)) {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = "sine"
      osc.frequency.setValueAtTime(135, t)
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.11)
      g.gain.setValueAtTime(0.65, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
      osc.connect(g)
      g.connect(dest)
      osc.start(t)
      osc.stop(t + 0.19)
    }

    // 2. Crisp Snare / Clap on 4 and 12
    if (barStep === 4 || barStep === 12) {
      const bufSize = Math.floor(ctx.sampleRate * 0.12)
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < bufSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.032))
      }
      const noise = ctx.createBufferSource()
      noise.buffer = buf
      const bp = ctx.createBiquadFilter()
      bp.type = "bandpass"
      bp.frequency.value = 1850
      bp.Q.value = 0.9
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.38, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
      noise.connect(bp)
      bp.connect(g)
      g.connect(dest)
      noise.start(t)
    }

    // 3. Hi-hat 8ths / 16th swing
    if (barStep % 2 === 0 || barStep === 7 || barStep === 15) {
      const bufSize = Math.floor(ctx.sampleRate * 0.04)
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < bufSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.009))
      }
      const hat = ctx.createBufferSource()
      hat.buffer = buf
      const hp = ctx.createBiquadFilter()
      hp.type = "highpass"
      hp.frequency.value = 7200
      const g = ctx.createGain()
      g.gain.setValueAtTime(barStep % 4 === 2 ? 0.18 : 0.09, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.04)
      hat.connect(hp)
      hp.connect(g)
      g.connect(dest)
      hat.start(t)
    }

    // 4. Funky walking sub-bassline (Fm -> Db -> Eb -> C)
    const chordOffsets = [0, -4, -2, -5]
    const baseMidi = root - 12 + (chordOffsets[bar] ?? 0)
    const bassPattern: Record<number, number> = {
      0: 0,
      3: 0,
      6: 7,
      8: 0,
      10: 10,
      12: 12,
      14: 7,
    }
    if (barStep in bassPattern) {
      const note = baseMidi + (bassPattern[barStep] ?? 0)
      const osc = ctx.createOscillator()
      const lp = ctx.createBiquadFilter()
      const g = ctx.createGain()
      osc.type = "sawtooth"
      osc.frequency.setValueAtTime(this.midiToHz(note), t)
      lp.type = "lowpass"
      lp.frequency.setValueAtTime(620, t)
      lp.frequency.exponentialRampToValueAtTime(190, t + stepDur * 1.8)
      g.gain.setValueAtTime(0.28, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 1.9)
      osc.connect(lp)
      lp.connect(g)
      g.connect(dest)
      osc.start(t)
      osc.stop(t + stepDur * 2)
    }

    // 5. Catchy brassy synth lead hook ("Magic Key" style minor motif)
    const leadPattern: Record<number, number> = {
      0: 12,
      2: 15,
      4: 17,
      6: 19,
      9: 17,
      11: 15,
      12: 12,
      15: 10,
    }
    if (barStep in leadPattern) {
      const note = root + 12 + (chordOffsets[bar] ?? 0) + (leadPattern[barStep] ?? 0)
      const osc1 = ctx.createOscillator()
      const osc2 = ctx.createOscillator()
      const filter = ctx.createBiquadFilter()
      const g = ctx.createGain()

      osc1.type = "sawtooth"
      osc2.type = "triangle"
      const hz = this.midiToHz(note)
      osc1.frequency.setValueAtTime(hz, t)
      osc2.frequency.setValueAtTime(hz * 1.004, t)

      filter.type = "lowpass"
      filter.frequency.setValueAtTime(2600, t)
      filter.frequency.exponentialRampToValueAtTime(900, t + stepDur * 1.7)
      filter.Q.value = 2.4

      g.gain.setValueAtTime(0.001, t)
      g.gain.linearRampToValueAtTime(0.16, t + 0.015)
      g.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 1.8)

      osc1.connect(filter)
      osc2.connect(filter)
      filter.connect(g)
      g.connect(dest)
      osc1.start(t)
      osc2.start(t)
      osc1.stop(t + stepDur * 1.85)
      osc2.stop(t + stepDur * 1.85)
    }
  }

  public tick(nowPerf: number, isScrubbing = false): boolean {
    if (!this.liveAudioRunning || this.status !== "playing" || isScrubbing) {
      this.lastTickPerf = nowPerf
      return false
    }
    if (this.mediaEl && this.currentTrack.fileUrl) {
      this.currentTime = this.mediaEl.currentTime
      return true
    }
    const dt = Math.min(0.25, Math.max(0, (nowPerf - this.lastTickPerf) / 1000))
    this.lastTickPerf = nowPerf
    this.currentTime += dt
    if (this.currentTime >= this.currentTrack.duration) {
      if (this.repeat && this.tracks.length === 1) {
        this.currentTime = 0
      } else {
        this.next()
      }
    }
    return true
  }

  public readFrequencyBars18(): number[] | null {
    if (!this.analyser || !this.liveAudioRunning) return null
    this.analyser.getByteFrequencyData(this.freqBuf)
    const out = new Array<number>(18).fill(0)
    // Logarithmic bin mapping across 18 Winamp spectrum columns (0..6 cells height)
    for (let i = 0; i < 18; i++) {
      const startBin = Math.floor(Math.pow(i / 18, 1.55) * 76) + 1
      const endBin = Math.max(startBin + 1, Math.floor(Math.pow((i + 1) / 18, 1.55) * 76) + 2)
      let sum = 0
      for (let b = startBin; b < endBin && b < this.freqBuf.length; b++) {
        sum += this.freqBuf[b] ?? 0
      }
      const avg = sum / (endBin - startBin)
      out[i] = Math.min(6, (avg / 255) * 6.8)
    }
    return out
  }

  public readWaveform(): Uint8Array | null {
    if (!this.analyser || !this.liveAudioRunning) return null
    this.analyser.getByteTimeDomainData(this.waveBuf)
    return this.waveBuf
  }
}
