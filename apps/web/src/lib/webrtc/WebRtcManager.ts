
export type WebRtcState =
  | 'WEBRTC_IDLE'
  | 'WEBRTC_CONNECTING'
  | 'WEBRTC_ICE_CONNECTING'
  | 'WEBRTC_CONNECTED'
  | 'WEBRTC_FAILED'
  | 'WEBRTC_DISCONNECTED'
  | 'WEBRTC_CLOSED';

export interface WebRtcManagerOptions {
  iceServers?: RTCIceServer[];
  onSignalingMessage: (type: 'WEBRTC_OFFER' | 'WEBRTC_ANSWER' | 'ICE_CANDIDATE', payload: unknown) => void;
  onStateChange: (state: WebRtcState) => void;
  onDataChannelMessage: (data: unknown) => void;
  onDataChannelStateChange: (state: RTCDataChannelState) => void;
  // File Transfer options
  onFileDataChannelMessage?: (index: number, payload: Uint8Array) => void;
  onFileDataChannelStateChange?: (state: RTCDataChannelState) => void;
  onBufferedAmountLow?: () => void;
}

export interface WebRtcStats {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  localCandidateType: string;
  remoteCandidateType: string;
  selectedCandidatePair: string;
  rtt: number | null; // in ms
  bytesSent: number;
  bytesReceived: number;
}

/**
 * Adaptive watermark state exposed for telemetry.
 */
export interface AdaptiveWatermarkState {
  highWatermark: number;
  lowWatermark: number;
  pauseCount: number;
  totalPauseDurationMs: number;
  drainRateBps: number;
  sendRateBps: number;
  lastAdjustmentTime: number;
}

/**
 * Adaptive watermark controller configuration bounds.
 */
export interface WatermarkConfig {
  minHighWatermark: number;
  maxHighWatermark: number;
  minLowWatermark: number;
  maxLowWatermark: number;
  /** Minimum interval between watermark adjustments (ms) */
  adjustIntervalMs: number;
}

const DEFAULT_WATERMARK_CONFIG: WatermarkConfig = {
  minHighWatermark: 2 * 1024 * 1024,   // 2 MB
  maxHighWatermark: 8 * 1024 * 1024,   // 8 MB
  minLowWatermark: 512 * 1024,         // 512 KB
  maxLowWatermark: 2 * 1024 * 1024,    // 2 MB
  adjustIntervalMs: 1000                // Adjust every 1 second
};

export class WebRtcManager {
  public static readonly CHUNK_SIZE = 60 * 1024; // 60 KB to fit within standard SCTP max message bounds (64 KB)

  // Safe high-performance static constants
  public static readonly HIGH_WATERMARK = 8 * 1024 * 1024; // 8 MB
  public static readonly LOW_WATERMARK = 4 * 1024 * 1024;  // 4 MB

  private pc: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private fileChannel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private options: WebRtcManagerOptions;
  private lastState: WebRtcState = 'WEBRTC_IDLE';

  // --- Adaptive Watermark State ---
  private watermarkConfig: WatermarkConfig;
  private currentHighWatermark: number;
  private currentLowWatermark: number;
  private pauseCount = 0;
  private totalPauseDurationMs = 0;
  private lastPauseStart = 0;
  private lastAdjustmentTime = 0;

  // Drain rate tracking
  private drainSamples: Array<{ time: number; buffered: number }> = [];
  private sendSamples: Array<{ time: number; bytes: number }> = [];
  private estimatedDrainRateBps = 0;
  private estimatedSendRateBps = 0;

  constructor(options: WebRtcManagerOptions, watermarkConfig?: Partial<WatermarkConfig>) {
    this.options = options;
    this.watermarkConfig = { ...DEFAULT_WATERMARK_CONFIG, ...watermarkConfig };
    this.currentHighWatermark = 4 * 1024 * 1024; // Start at safe 4 MB
    this.currentLowWatermark = 1 * 1024 * 1024;   // Start at safe 1 MB
  }

  createPeerConnection(): RTCPeerConnection {
    this.close();

    const config: RTCConfiguration = {
      iceServers: this.options.iceServers || [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    };

    const pc = new RTCPeerConnection(config);
    this.pc = pc;
    this.updateState();

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.onSignalingMessage('ICE_CANDIDATE', {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment
        });
      }
    };

    pc.onconnectionstatechange = () => {
      this.updateState();
    };

    pc.oniceconnectionstatechange = () => {
      this.updateState();
    };

    pc.onsignalingstatechange = () => {
      this.updateState();
    };

    pc.ondatachannel = (event) => {
      if (event.channel.label === 'control') {
        this.setupControlChannel(event.channel);
      } else if (event.channel.label === 'file') {
        this.setupFileChannel(event.channel);
      }
    };

    return pc;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) throw new Error('PeerConnection not created');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) this.createPeerConnection();
    const pc = this.pc!;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.processPendingCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) throw new Error('PeerConnection not created');
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    await this.processPendingCandidates();
  }

  async handleIceCandidate(candidateInit: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) throw new Error('PeerConnection not created');
    const pc = this.pc;

    if (pc.remoteDescription) {
      await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
    } else {
      this.pendingCandidates.push(candidateInit);
    }
  }

  createControlChannel(): RTCDataChannel {
    if (!this.pc) throw new Error('PeerConnection not created');
    const channel = this.pc.createDataChannel('control', {
      ordered: true
    });
    this.setupControlChannel(channel);
    return channel;
  }

  createFileChannel(): RTCDataChannel {
    if (!this.pc) throw new Error('PeerConnection not created');
    const channel = this.pc.createDataChannel('file', {
      ordered: true
    });
    this.setupFileChannel(channel);
    return channel;
  }

  sendFileChunk(chunkIndex: number, payload: Uint8Array): void {
    if (!this.fileChannel || this.fileChannel.readyState !== 'open') {
      throw new Error('File data channel is not open');
    }

    // Binary format: 4 bytes big-endian index + payload
    const buffer = new ArrayBuffer(4 + payload.length);
    const view = new DataView(buffer);
    view.setUint32(0, chunkIndex, false);
    const uint8View = new Uint8Array(buffer);
    uint8View.set(payload, 4);

    this.fileChannel.send(buffer);

    // Track send rate
    const now = performance.now();
    this.sendSamples.push({ time: now, bytes: payload.length + 4 });
    // Keep only last 2 seconds of samples
    while (this.sendSamples.length > 0 && now - this.sendSamples[0].time > 2000) {
      this.sendSamples.shift();
    }
  }

  getFileBufferedAmount(): number {
    return this.fileChannel?.bufferedAmount || 0;
  }

  /**
   * Returns the current adaptive high watermark threshold.
   */
  getCurrentHighWatermark(): number {
    return this.currentHighWatermark;
  }

  /**
   * Returns the current adaptive low watermark threshold.
   */
  getCurrentLowWatermark(): number {
    return this.currentLowWatermark;
  }

  /**
   * Check if the sender should pause based on the current adaptive watermark.
   * Also records the pause event for telemetry.
   */
  shouldPause(): boolean {
    const buffered = this.getFileBufferedAmount();
    if (buffered > this.currentHighWatermark) {
      if (this.lastPauseStart === 0) {
        this.pauseCount++;
        this.lastPauseStart = performance.now();
      }
      return true;
    }
    return false;
  }

  /**
   * Record the end of a pause period for telemetry tracking.
   */
  recordPauseEnd(): void {
    if (this.lastPauseStart > 0) {
      this.totalPauseDurationMs += performance.now() - this.lastPauseStart;
      this.lastPauseStart = 0;
    }
  }

  /**
   * Sample the current bufferedAmount and adaptively adjust watermarks.
   * Call this periodically (every 250-500ms) from the sender loop.
   */
  sampleAndAdapt(): void {
    if (!this.fileChannel) return;

    const now = performance.now();
    const buffered = this.fileChannel.bufferedAmount;

    // Track drain samples
    this.drainSamples.push({ time: now, buffered });
    while (this.drainSamples.length > 0 && now - this.drainSamples[0].time > 2000) {
      this.drainSamples.shift();
    }

    // Estimate drain rate from samples
    if (this.drainSamples.length >= 2) {
      const oldest = this.drainSamples[0];
      const newest = this.drainSamples[this.drainSamples.length - 1];
      const timeDiff = (newest.time - oldest.time) / 1000;
      if (timeDiff > 0) {
        // Drain rate = total bytes sent in window minus current buffer growth
        const totalSent = this.sendSamples.reduce((sum, s) => sum + s.bytes, 0);
        const sendTimeDiff = this.sendSamples.length >= 2
          ? (this.sendSamples[this.sendSamples.length - 1].time - this.sendSamples[0].time) / 1000
          : timeDiff;

        if (sendTimeDiff > 0) {
          this.estimatedSendRateBps = totalSent / sendTimeDiff;
        }

        // Drain rate estimate: if buffer is decreasing, draining is happening
        const bufferDelta = newest.buffered - oldest.buffered;
        if (bufferDelta < 0) {
          // Buffer decreased = draining faster than filling
          this.estimatedDrainRateBps = this.estimatedSendRateBps + Math.abs(bufferDelta) / timeDiff;
        } else {
          // Buffer increasing or stable
          this.estimatedDrainRateBps = Math.max(
            this.estimatedSendRateBps - bufferDelta / timeDiff,
            this.estimatedSendRateBps * 0.5
          );
        }
      }
    }

    // Adjust watermarks at controlled intervals
    if (now - this.lastAdjustmentTime < this.watermarkConfig.adjustIntervalMs) return;
    this.lastAdjustmentTime = now;

    this.adjustWatermarks();
  }

  /**
   * Adjust watermarks based on observed pause frequency and drain behavior.
   * Only activates after at least one backpressure event has been recorded
   * to avoid premature adjustment on fresh transfers.
   */
  private adjustWatermarks(): void {
    const cfg = this.watermarkConfig;

    // Don't adjust until we have meaningful data — require at least one
    // pause event to have been recorded before adapting
    if (this.totalPauseDurationMs === 0 && this.pauseCount === 0) {
      return;
    }

    // If we're pausing too frequently (> 3 pauses since last adjustment),
    // increase watermarks to reduce pause overhead
    if (this.pauseCount > 3 && this.currentHighWatermark < cfg.maxHighWatermark) {
      // Scale up by 25%
      const newHigh = Math.min(
        Math.round(this.currentHighWatermark * 1.25),
        cfg.maxHighWatermark
      );
      const newLow = Math.min(
        Math.round(newHigh * 0.5),
        cfg.maxLowWatermark
      );
      this.currentHighWatermark = newHigh;
      this.currentLowWatermark = Math.max(newLow, cfg.minLowWatermark);
    }

    // If pauses have stabilized (0 in recent window) and we previously scaled up,
    // gently reduce watermarks to keep memory usage low
    if (this.pauseCount === 0 && this.currentHighWatermark > WebRtcManager.HIGH_WATERMARK) {
      const newHigh = Math.max(
        Math.round(this.currentHighWatermark * 0.9),
        WebRtcManager.HIGH_WATERMARK // Never go below the proven default
      );
      const newLow = Math.max(
        Math.round(newHigh * 0.5),
        cfg.minLowWatermark
      );
      this.currentHighWatermark = newHigh;
      this.currentLowWatermark = Math.max(newLow, cfg.minLowWatermark);
    }

    // Reset pause count for the next adjustment window
    this.pauseCount = 0;

    // Update the bufferedAmountLowThreshold on the data channel
    if (this.fileChannel) {
      this.fileChannel.bufferedAmountLowThreshold = this.currentLowWatermark;
    }
  }

  /**
   * Get current adaptive watermark state for telemetry.
   */
  getAdaptiveWatermarkState(): AdaptiveWatermarkState {
    return {
      highWatermark: this.currentHighWatermark,
      lowWatermark: this.currentLowWatermark,
      pauseCount: this.pauseCount,
      totalPauseDurationMs: this.totalPauseDurationMs,
      drainRateBps: this.estimatedDrainRateBps,
      sendRateBps: this.estimatedSendRateBps,
      lastAdjustmentTime: this.lastAdjustmentTime
    };
  }

  /**
   * Reset adaptive watermark state (for new transfers).
   */
  resetAdaptiveState(): void {
    this.pauseCount = 0;
    this.totalPauseDurationMs = 0;
    this.lastPauseStart = 0;
    this.lastAdjustmentTime = 0;
    this.drainSamples = [];
    this.sendSamples = [];
    this.estimatedDrainRateBps = 0;
    this.estimatedSendRateBps = 0;
    this.currentHighWatermark = 4 * 1024 * 1024;
    this.currentLowWatermark = 1 * 1024 * 1024;
    // Sync the actual data channel threshold
    if (this.fileChannel) {
      this.fileChannel.bufferedAmountLowThreshold = this.currentLowWatermark;
    }
  }

  sendControlMessage(msg: unknown) {
    if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
      throw new Error('Control channel is not open');
    }
    this.controlChannel.send(JSON.stringify(msg));
  }

  private setupControlChannel(channel: RTCDataChannel) {
    this.controlChannel = channel;
    this.options.onDataChannelStateChange(channel.readyState);

    channel.onopen = () => {
      this.options.onDataChannelStateChange(channel.readyState);
    };

    channel.onclose = () => {
      this.options.onDataChannelStateChange(channel.readyState);
    };

    channel.onerror = () => {
      this.options.onDataChannelStateChange(channel.readyState);
    };

    channel.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        this.options.onDataChannelMessage(parsed);
      } catch {
        // Ignored or raw data
      }
    };
  }

  private setupFileChannel(channel: RTCDataChannel) {
    this.fileChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = this.currentLowWatermark;

    if (this.options.onFileDataChannelStateChange) {
      this.options.onFileDataChannelStateChange(channel.readyState);
    }

    channel.onopen = () => {
      if (this.options.onFileDataChannelStateChange) {
        this.options.onFileDataChannelStateChange(channel.readyState);
      }
    };

    channel.onclose = () => {
      if (this.options.onFileDataChannelStateChange) {
        this.options.onFileDataChannelStateChange(channel.readyState);
      }
    };

    channel.onerror = () => {
      if (this.options.onFileDataChannelStateChange) {
        this.options.onFileDataChannelStateChange(channel.readyState);
      }
    };

    channel.onbufferedamountlow = () => {
      this.recordPauseEnd();
      if (this.options.onBufferedAmountLow) {
        this.options.onBufferedAmountLow();
      }
    };

    channel.onmessage = (event) => {
      const buffer = event.data as ArrayBuffer;
      if (buffer.byteLength < 4) return;
      const view = new DataView(buffer);
      const chunkIndex = view.getUint32(0, false);
      const payload = new Uint8Array(buffer, 4);
      if (this.options.onFileDataChannelMessage) {
        this.options.onFileDataChannelMessage(chunkIndex, payload);
      }
    };
  }

  async getStats(): Promise<WebRtcStats> {
    const defaultStats: WebRtcStats = {
      connectionState: this.pc?.connectionState || 'closed',
      iceConnectionState: this.pc?.iceConnectionState || 'closed',
      signalingState: this.pc?.signalingState || 'closed',
      localCandidateType: 'unknown',
      remoteCandidateType: 'unknown',
      selectedCandidatePair: 'unknown',
      rtt: null,
      bytesSent: 0,
      bytesReceived: 0
    };

    if (!this.pc) return defaultStats;

    try {
      const stats = await this.pc.getStats();
      let activePair: Record<string, unknown> | null = null;
      let localCand: Record<string, unknown> | null = null;
      let remoteCand: Record<string, unknown> | null = null;

      for (const report of stats.values()) {
        const reportObj = report as unknown as Record<string, unknown>;
        if (reportObj.type === 'candidate-pair' && reportObj.state === 'succeeded' && reportObj.nominated) {
          activePair = reportObj;
          break;
        }
      }

      if (activePair) {
        const localId = activePair.localCandidateId;
        const remoteId = activePair.remoteCandidateId;
        if (typeof localId === 'string') {
          localCand = stats.get(localId) as unknown as Record<string, unknown>;
        }
        if (typeof remoteId === 'string') {
          remoteCand = stats.get(remoteId) as unknown as Record<string, unknown>;
        }

        defaultStats.selectedCandidatePair = `${(localCand?.candidateType as string) || 'unknown'} ↔ ${(remoteCand?.candidateType as string) || 'unknown'}`;
        defaultStats.localCandidateType = (localCand?.candidateType as string) || 'unknown';
        defaultStats.remoteCandidateType = (remoteCand?.candidateType as string) || 'unknown';
        
        if (typeof activePair.currentRoundTripTime === 'number') {
          defaultStats.rtt = Math.round(activePair.currentRoundTripTime * 1000);
        } else if (typeof activePair.totalRoundTripTime === 'number' && typeof activePair.responsesReceived === 'number') {
          defaultStats.rtt = Math.round((activePair.totalRoundTripTime / activePair.responsesReceived) * 1000);
        }

        defaultStats.bytesSent = (activePair.bytesSent as number) || 0;
        defaultStats.bytesReceived = (activePair.bytesReceived as number) || 0;
      }
    } catch {
      // ignore getStats failure
    }

    return defaultStats;
  }

  close() {
    if (this.controlChannel) {
      this.controlChannel.close();
      this.controlChannel = null;
    }
    if (this.fileChannel) {
      this.fileChannel.close();
      this.fileChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.pendingCandidates = [];
    this.updateState();
  }

  getConnectionState(): RTCPeerConnectionState {
    return this.pc?.connectionState || 'closed';
  }

  getIceConnectionState(): RTCIceConnectionState {
    return this.pc?.iceConnectionState || 'closed';
  }

  getPeerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  private updateState() {
    let state: WebRtcState = 'WEBRTC_IDLE';

    if (this.pc) {
      const connState = this.pc.connectionState;
      const iceState = this.pc.iceConnectionState;

      if (connState === 'connected') {
        state = 'WEBRTC_CONNECTED';
      } else if (connState === 'connecting') {
        if (iceState === 'checking') {
          state = 'WEBRTC_ICE_CONNECTING';
        } else {
          state = 'WEBRTC_CONNECTING';
        }
      } else if (connState === 'failed' || iceState === 'failed') {
        state = 'WEBRTC_FAILED';
      } else if (connState === 'disconnected' || iceState === 'disconnected') {
        state = 'WEBRTC_DISCONNECTED';
      } else if (connState === 'closed' || iceState === 'closed') {
        state = 'WEBRTC_CLOSED';
      }
    }

    if (state !== this.lastState) {
      this.lastState = state;
      this.options.onStateChange(state);
    }
  }

  private async processPendingCandidates() {
    if (!this.pc || !this.pc.remoteDescription) return;
    const candidates = [...this.pendingCandidates];
    this.pendingCandidates = [];
    for (const c of candidates) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        // ignore candidate error
      }
    }
  }
}
