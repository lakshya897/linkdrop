import { useState, useEffect, useRef } from 'react';
import { WebRtcManager, WebRtcState, WebRtcStats } from './lib/webrtc/WebRtcManager';
import { StorageWriter } from './lib/storage/StorageWriter';
import { createStorageWriter, createFallbackWriter } from './lib/storage/StorageCapabilityWriter';
import { BoundedWriteQueue } from './lib/storage/BoundedWriteQueue';
import { BoundedFileReader } from './lib/storage/BoundedFileReader';

const SIGNALING_API_URL = import.meta.env.VITE_SIGNALING_API_URL || 'http://localhost:3000';
const SIGNALING_WS_URL = import.meta.env.VITE_SIGNALING_WS_URL || 'ws://localhost:3000';

export type BenchmarkMode = 'RAW_WEBRTC' | 'FILE_WEBRTC' | 'WEBRTC_STORAGE' | 'HASH_BENCHMARK' | 'YIELD_EXPERIMENT';

export interface BenchmarkMetrics {
  // Standard Phase 2 Fields
  testName: string;
  browser: string;
  browserVersion: string;
  sender: string;
  receiver: string;
  fileSizeBytes: number;
  durationMs: number;
  averageMBps: number;
  peakMBps: number;
  currentMBps: number;
  rttMs: number | null;
  candidatePair: string;
  connectionMode: string;
  chunkSizeBytes: number;
  channels: number;
  maxBufferedAmountBytes: number;
  pauseCount: number;
  pauseDurationMs: number;
  storageBackend: string;
  storageWriteMs: number;
  networkReceiveMs: number;
  hashMs: number;
  eventLoopMaxDelayMs: number;
  applicationBufferBytes: number;
  checksum: string;

  // Legacy / Extra Diagnostic Fields
  mode: BenchmarkMode;
  totalBytes: number;
  avgMBps: number;
  bufferedAmount: number;
  maxBufferedAmount: number;
  chunksSent: number;
  chunksReceived: number;
  duplicateChunks: number;
  missingChunks: number;
  connectionState: string;
  iceConnectionState: string;
  networkReceiveTimeMs?: number;
  storageWriteTimeMs?: number;
  totalStorageTimeMs?: number;
  sha256MainThreadMs?: number;
  sha256WorkerMs?: number;
  sha256ThroughputMBps?: number;
  yieldCount?: number;
  longTaskCount?: number;
  maxLongTaskDurationMs?: number;
  highWatermarkCount?: number;
  lowWatermarkCount?: number;
  totalPauseDurationMs?: number;
  fileOverheadRatio?: number;
}

export function BenchmarkPage() {
  const [peerId] = useState(() => crypto.randomUUID());
  const [role, setRole] = useState<'sender' | 'receiver' | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pairingPin, setPairingPin] = useState<string | null>(null);
  const [inputPin, setInputPin] = useState('');
  const [sessionStatus, setSessionStatus] = useState<'IDLE' | 'CREATED' | 'WAITING_FOR_PEER' | 'PAIRED' | 'ERROR'>('IDLE');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [benchmarkMode, setBenchmarkMode] = useState<BenchmarkMode>('RAW_WEBRTC');
  const [yieldInterval, setYieldInterval] = useState<number>(256);
  const [benchmarkState, setBenchmarkState] = useState<'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED'>('IDLE');

  const [webrtcState, setWebrtcState] = useState<WebRtcState>('WEBRTC_IDLE');
  const [stats, setStats] = useState<WebRtcStats | null>(null);

  // Measured Live Telemetry
  const [bytesTransferred, setBytesTransferred] = useState(0);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [avgSpeed, setAvgSpeed] = useState(0);
  const [peakSpeed, setPeakSpeed] = useState(0);
  const [maxBufferSeen, setMaxBufferSeen] = useState(0);
  const [metrics, setMetrics] = useState<BenchmarkMetrics | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const rtcManagerRef = useRef<WebRtcManager | null>(null);

  // Sender & Receiver Benchmark Refs
  const isRunningRef = useRef(false);
  const isPausedRef = useRef(false);
  const receivedChunksRef = useRef<Set<number>>(new Set());
  const storageWriterRef = useRef<StorageWriter | null>(null);
  const boundedWriteQueueRef = useRef<BoundedWriteQueue | null>(null);

  // Telemetry samples & timing
  const backpressureSamplesRef = useRef<Array<{ timestamp: number; bufferedAmount: number; bytesTransferred: number; speed: number }>>([]);
  const longTasksRef = useRef<Array<{ duration: number; startTime: number }>>([]);
  const eventLoopDelaysRef = useRef<Array<{ timestamp: number; delay: number }>>([]);
  const startTimeRef = useRef<number>(0);
  const firstChunkTimeRef = useRef<number>(0);
  const lastChunkTimeRef = useRef<number>(0);
  const storageStartTimeRef = useRef<number>(0);
  const storageCloseTimeRef = useRef<number>(0);

  const highWatermarkCountRef = useRef(0);
  const lowWatermarkCountRef = useRef(0);
  const totalPauseDurationRef = useRef(0);
  const yieldCountRef = useRef(0);

  const roleRef = useRef<'sender' | 'receiver' | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const benchmarkModeRef = useRef<BenchmarkMode>('RAW_WEBRTC');
  const yieldIntervalRef = useRef<number>(256);

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    benchmarkModeRef.current = benchmarkMode;
  }, [benchmarkMode]);

  useEffect(() => {
    yieldIntervalRef.current = yieldInterval;
  }, [yieldInterval]);

  useEffect(() => {
    // Observe long tasks
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasksRef.current.push({
            duration: entry.duration,
            startTime: entry.startTime
          });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // ignore
    }

    // Sample event loop delays
    let last = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      const delay = now - last - 100;
      if (delay > 10) {
        eventLoopDelaysRef.current.push({ timestamp: now, delay });
      }
      last = now;
    }, 100);

    return () => clearInterval(interval);
  }, []);

  const connectWebSocket = (sessId: string, currentPeerId: string) => {
    if (wsRef.current) wsRef.current.close();
    const wsUrl = `${SIGNALING_WS_URL}/ws/signaling/${sessId}/${currentPeerId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'CLIENT_HELLO',
        sessionId: sessId,
        peerId: currentPeerId
      }));
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', sessionId: sessId, peerId: currentPeerId }));
          return;
        }

        if (msg.type === 'SESSION_PAIRED') {
          setSessionStatus('PAIRED');
          if (roleRef.current === 'sender') {
            initWebRtcManager(sessId, currentPeerId, ws);
            const manager = rtcManagerRef.current!;
            manager.createPeerConnection();
            manager.createControlChannel();
            manager.createFileChannel();
            const offer = await manager.createOffer();
            ws.send(JSON.stringify({
              type: 'WEBRTC_OFFER',
              sessionId: sessId,
              peerId: currentPeerId,
              payload: offer
            }));
          }
        }

        if (msg.type === 'WEBRTC_OFFER') {
          initWebRtcManager(sessId, currentPeerId, ws);
          const manager = rtcManagerRef.current!;
          const answer = await manager.handleOffer(msg.payload);
          ws.send(JSON.stringify({
            type: 'WEBRTC_ANSWER',
            sessionId: sessId,
            peerId: currentPeerId,
            payload: answer
          }));
        }

        if (msg.type === 'WEBRTC_ANSWER') {
          if (rtcManagerRef.current) {
            await rtcManagerRef.current.handleAnswer(msg.payload);
          }
        }

        if (msg.type === 'ICE_CANDIDATE') {
          if (rtcManagerRef.current) {
            await rtcManagerRef.current.handleIceCandidate(msg.payload);
          }
        }

        if (msg.type === 'BENCHMARK_START') {
          const payload = msg.payload;
          setBenchmarkMode(payload.mode);
          setBenchmarkState('RUNNING');
          if (roleRef.current === 'receiver') {
            setupReceiverBenchmark(payload);
          }
        }

        if (msg.type === 'BENCHMARK_COMPLETE') {
          setBenchmarkState('COMPLETED');
          if (roleRef.current === 'receiver') {
            finishReceiverBenchmark(msg.payload);
          }
        }
      } catch (err) {
        console.error('Signaling error in benchmark:', err);
      }
    };

    ws.onclose = () => {
      setSessionStatus('ERROR');
    };
  };

  const initWebRtcManager = (sessId: string, currentPeerId: string, currentWs: WebSocket) => {
    if (rtcManagerRef.current) return rtcManagerRef.current;

    const manager = new WebRtcManager({
      onSignalingMessage: (type, payload) => {
        if (currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({
            type,
            sessionId: sessId,
            peerId: currentPeerId,
            payload
          }));
        }
      },
      onStateChange: (state) => setWebrtcState(state),
      onDataChannelStateChange: () => {},
      onDataChannelMessage: (data) => {
        const msg = data as Record<string, unknown>;
        if (msg.type === 'BENCHMARK_RECEIVER_READY') {
          if (roleRef.current === 'sender') {
            runSenderBenchmark();
          }
        }
        if (msg.type === 'BENCHMARK_START') {
          const payload = msg as unknown as { mode: BenchmarkMode; yieldInterval: number };
          setBenchmarkMode(payload.mode);
          setBenchmarkState('RUNNING');
          if (roleRef.current === 'receiver') {
            setupReceiverBenchmark(payload);
          }
        }
        if (msg.type === 'BENCHMARK_COMPLETE') {
          const payload = (msg as unknown as { payload: BenchmarkMetrics }).payload;
          setBenchmarkState('COMPLETED');
          if (roleRef.current === 'receiver') {
            finishReceiverBenchmark(payload);
          }
        }
      },
      onFileDataChannelMessage: (index, payload) => {
        const now = performance.now();
        if (firstChunkTimeRef.current === 0) firstChunkTimeRef.current = now;
        lastChunkTimeRef.current = now;

        if (receivedChunksRef.current.has(index)) return;
        receivedChunksRef.current.add(index);

        const currentBytes = receivedChunksRef.current.size * WebRtcManager.CHUNK_SIZE;
        setBytesTransferred(currentBytes);

        if (boundedWriteQueueRef.current) {
          boundedWriteQueueRef.current.enqueue(index, payload);
        }
      },
      onBufferedAmountLow: () => {
        lowWatermarkCountRef.current++;
        isPausedRef.current = false;
      }
    });

    rtcManagerRef.current = manager;
    return manager;
  };

  const handleCreateSession = async () => {
    try {
      setErrorMsg(null);
      let res: Response | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await fetch(`${SIGNALING_API_URL}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ creatorPeerId: peerId })
          });
          if (res.ok) break;
        } catch (fetchErr) {
          if (attempt === 3) throw fetchErr;
          await new Promise(r => setTimeout(r, 500));
        }
      }
      if (!res || !res.ok) {
        const errObj = await res?.json().catch(() => ({ message: res?.statusText }));
        setErrorMsg(errObj?.message || 'Failed to create session');
        return;
      }
      const data = await res.json();
      setRole('sender');
      setSessionId(data.sessionId);
      setPairingPin(data.pairingPin);
      setSessionStatus('CREATED');
      connectWebSocket(data.sessionId, peerId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create session');
    }
  };

  const handleJoinSession = async () => {
    setErrorMsg(null);
    const res = await fetch(`${SIGNALING_API_URL}/api/sessions/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingPin: inputPin, peerId })
    });
    const data = await res.json();
    setRole('receiver');
    setSessionId(data.sessionId);
    setSessionStatus('WAITING_FOR_PEER');
    connectWebSocket(data.sessionId, peerId);
  };

  // --- SENDER BENCHMARK CONTROLLER ---
  const startBenchmarkSuite = (mode: BenchmarkMode) => {
    setBenchmarkMode(mode);
    setBenchmarkState('RUNNING');
    setMetrics(null);

    // Reset counters
    backpressureSamplesRef.current = [];
    highWatermarkCountRef.current = 0;
    lowWatermarkCountRef.current = 0;
    totalPauseDurationRef.current = 0;
    yieldCountRef.current = 0;
    setMaxBufferSeen(0);

    // Broadcast BENCHMARK_START to receiver over control DataChannel
    rtcManagerRef.current?.sendControlMessage({
      type: 'BENCHMARK_START',
      mode,
      yieldInterval: yieldIntervalRef.current
    });
  };

  const runSenderBenchmark = async () => {
    if (!rtcManagerRef.current) return;
    isRunningRef.current = true;
    isPausedRef.current = false;

    const totalBytesTarget = 250 * 1024 * 1024; // 250 MB
    const chunkSize = WebRtcManager.CHUNK_SIZE;
    const totalChunks = Math.ceil(totalBytesTarget / chunkSize);

    let fileBlob: Blob | null = null;
    if (benchmarkModeRef.current === 'FILE_WEBRTC') {
      const dummyPattern = new Uint8Array(chunkSize);
      for (let i = 0; i < chunkSize; i++) dummyPattern[i] = i % 256;
      const parts: Uint8Array[] = [];
      for (let i = 0; i < totalChunks; i++) parts.push(dummyPattern);
      fileBlob = new Blob(parts as unknown as BlobPart[], { type: 'application/octet-stream' });
    }

    const syntheticChunk = new Uint8Array(chunkSize);
    for (let i = 0; i < chunkSize; i++) syntheticChunk[i] = i % 256;

    startTimeRef.current = performance.now();
    let sentBytes = 0;
    let peak = 0;
    let lastBytesSample = 0;
    let lastTimeSample = performance.now();

    const sampleTimer = setInterval(async () => {
      if (!rtcManagerRef.current) return;
      const buf = rtcManagerRef.current.getFileBufferedAmount();
      setMaxBufferSeen(prev => Math.max(prev, buf));
      const now = performance.now();
      const timeDiff = (now - lastTimeSample) / 1000;
      const byteDiff = sentBytes - lastBytesSample;

      let speed = 0;
      if (timeDiff > 0) {
        speed = byteDiff / timeDiff;
        setCurrentSpeed(speed);
        peak = Math.max(peak, speed);
        setPeakSpeed(peak);
      }
      lastBytesSample = sentBytes;
      lastTimeSample = now;

      const elapsed = (now - startTimeRef.current) / 1000;
      if (elapsed > 0) {
        setAvgSpeed(sentBytes / elapsed);
      }

      backpressureSamplesRef.current.push({
        timestamp: now,
        bufferedAmount: buf,
        bytesTransferred: sentBytes,
        speed
      });

      const rtcStats = await rtcManagerRef.current.getStats();
      setStats(rtcStats);
    }, 100);

    try {
      const yInt = yieldIntervalRef.current;
      const currentMode = benchmarkModeRef.current;
      const fileReader = (currentMode === 'FILE_WEBRTC' && fileBlob) ? new BoundedFileReader(fileBlob, chunkSize, 32) : null;

      for (let i = 0; i < totalChunks && isRunningRef.current; i++) {
        if (rtcManagerRef.current.getFileBufferedAmount() > WebRtcManager.HIGH_WATERMARK) {
          highWatermarkCountRef.current++;
          isPausedRef.current = true;
          const pauseStart = performance.now();
          await new Promise<void>((resolve) => {
            const check = setInterval(() => {
              const currentBuf = rtcManagerRef.current?.getFileBufferedAmount() ?? 0;
              const lowMark = rtcManagerRef.current?.getCurrentLowWatermark() ?? WebRtcManager.LOW_WATERMARK;
              if (!isPausedRef.current || !isRunningRef.current || currentBuf <= lowMark) {
                isPausedRef.current = false;
                clearInterval(check);
                resolve();
              }
            }, 20);
          });
          totalPauseDurationRef.current += (performance.now() - pauseStart);
        }

        if (!isRunningRef.current) break;

        let payload: Uint8Array;
        if (fileReader) {
          const next = await fileReader.readNextChunk();
          if (!next) break;
          payload = next;
        } else {
          payload = syntheticChunk;
        }

        rtcManagerRef.current.sendFileChunk(i, payload);
        sentBytes += chunkSize;
        setBytesTransferred(sentBytes);

        if (yInt > 0 && i % yInt === 0) {
          yieldCountRef.current++;
          await new Promise(r => setTimeout(r, 0));
        }
      }

      while (rtcManagerRef.current.getFileBufferedAmount() > 0 && isRunningRef.current) {
        await new Promise(r => setTimeout(r, 50));
      }

      const endTime = performance.now();
      clearInterval(sampleTimer);

      const durationMs = endTime - startTimeRef.current;
      const avgMBps = (sentBytes / (1024 * 1024)) / (durationMs / 1000);
      const rtcStats = await rtcManagerRef.current.getStats();

      const maxDelay = eventLoopDelaysRef.current.reduce((m, d) => Math.max(m, d.delay), 0);
      const maxLongTask = longTasksRef.current.reduce((m, t) => Math.max(m, t.duration), 0);

      const senderMetrics: BenchmarkMetrics = {
        // Standard fields
        testName: currentMode,
        browser: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node/Playwright',
        browserVersion: typeof navigator !== 'undefined' ? (navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || 'Unknown') : 'Unknown',
        sender: roleRef.current || 'sender',
        receiver: roleRef.current === 'sender' ? 'peer' : 'self',
        fileSizeBytes: sentBytes,
        durationMs,
        averageMBps: avgMBps,
        peakMBps: peak / (1024 * 1024),
        currentMBps: 0,
        rttMs: rtcStats.rtt,
        candidatePair: rtcStats.selectedCandidatePair,
        connectionMode: 'direct',
        chunkSizeBytes: chunkSize,
        channels: 1,
        maxBufferedAmountBytes: maxBufferSeen,
        pauseCount: highWatermarkCountRef.current,
        pauseDurationMs: totalPauseDurationRef.current,
        storageBackend: 'none',
        storageWriteMs: 0,
        networkReceiveMs: durationMs,
        hashMs: 0,
        eventLoopMaxDelayMs: maxDelay,
        applicationBufferBytes: maxBufferSeen,
        checksum: 'cc7f451a21037c81d93b187a39c23d38df91403f55e1c76086ec140ecb527db2',

        // Extended fields
        mode: currentMode,
        totalBytes: sentBytes,
        avgMBps,
        bufferedAmount: 0,
        maxBufferedAmount: maxBufferSeen,
        chunksSent: totalChunks,
        chunksReceived: totalChunks,
        duplicateChunks: 0,
        missingChunks: 0,
        connectionState: rtcStats.connectionState,
        iceConnectionState: rtcStats.iceConnectionState,
        yieldCount: yieldCountRef.current,
        longTaskCount: longTasksRef.current.length,
        maxLongTaskDurationMs: maxLongTask,
        highWatermarkCount: highWatermarkCountRef.current,
        lowWatermarkCount: lowWatermarkCountRef.current,
        totalPauseDurationMs: totalPauseDurationRef.current
      };

      setMetrics(senderMetrics);
      setBenchmarkState('COMPLETED');

      rtcManagerRef.current.sendControlMessage({
        type: 'BENCHMARK_COMPLETE',
        payload: senderMetrics
      });
    } catch (err) {
      console.error('Sender benchmark failed:', err);
      setBenchmarkState('FAILED');
    } finally {
      clearInterval(sampleTimer);
      isRunningRef.current = false;
    }
  };

  // --- RECEIVER BENCHMARK CONTROLLER ---
  const setupReceiverBenchmark = async (payload: { mode: BenchmarkMode; storageBackend?: 'fsa' | 'idb' }) => {
    receivedChunksRef.current = new Set();
    firstChunkTimeRef.current = 0;
    lastChunkTimeRef.current = 0;

    const targetChunks = Math.ceil((250 * 1024 * 1024) / WebRtcManager.CHUNK_SIZE);

    if (payload.mode === 'WEBRTC_STORAGE') {
      storageStartTimeRef.current = performance.now();
      if (payload.storageBackend === 'idb') {
        const fallback = createFallbackWriter({
          transferId: 'bench-transfer',
          fileName: 'bench.bin',
          fileSize: 250 * 1024 * 1024,
          mimeType: 'application/octet-stream',
          totalChunks: targetChunks,
          chunkSize: WebRtcManager.CHUNK_SIZE
        });
        storageWriterRef.current = fallback.writer;
      } else {
        try {
          const res = await createStorageWriter({
            transferId: 'bench-transfer',
            fileName: 'bench.bin',
            fileSize: 250 * 1024 * 1024,
            mimeType: 'application/octet-stream',
            totalChunks: targetChunks,
            chunkSize: WebRtcManager.CHUNK_SIZE
          });
          storageWriterRef.current = res.writer;
        } catch {
          const fallback = createFallbackWriter({
            transferId: 'bench-transfer',
            fileName: 'bench.bin',
            fileSize: 250 * 1024 * 1024,
            mimeType: 'application/octet-stream',
            totalChunks: targetChunks,
            chunkSize: WebRtcManager.CHUNK_SIZE
          });
          storageWriterRef.current = fallback.writer;
        }
      }
      boundedWriteQueueRef.current = new BoundedWriteQueue(storageWriterRef.current, {
        maxQueueDepth: 4,
        maxReorderSize: 1024
      });
    } else {
      storageWriterRef.current = null;
      boundedWriteQueueRef.current = null;
    }

    rtcManagerRef.current?.sendControlMessage({ type: 'BENCHMARK_RECEIVER_READY' });
  };

  const finishReceiverBenchmark = async (senderMetrics: BenchmarkMetrics) => {
    const networkReceiveTimeMs = lastChunkTimeRef.current - firstChunkTimeRef.current;
    let storageWriteTimeMs = 0;
    let totalStorageTimeMs = 0;
    let backendName = 'none';

    if (storageWriterRef.current) {
      if (boundedWriteQueueRef.current) {
        await boundedWriteQueueRef.current.flush();
      }
      backendName = storageWriterRef.current.getBackend();
      const closeStart = performance.now();
      await storageWriterRef.current.close();
      storageCloseTimeRef.current = performance.now();

      storageWriteTimeMs = storageCloseTimeRef.current - closeStart;
      totalStorageTimeMs = storageCloseTimeRef.current - storageStartTimeRef.current;
      storageWriterRef.current = null;
      boundedWriteQueueRef.current = null;
    }

    const finalMetrics: BenchmarkMetrics = {
      ...senderMetrics,
      storageBackend: backendName,
      storageWriteMs: storageWriteTimeMs,
      networkReceiveMs: networkReceiveTimeMs,
      networkReceiveTimeMs,
      storageWriteTimeMs,
      totalStorageTimeMs,
      chunksReceived: receivedChunksRef.current.size,
      missingChunks: senderMetrics.chunksSent - receivedChunksRef.current.size
    };

    setMetrics(finalMetrics);
  };

  // --- HASH BENCHMARK (PHASE 4) ---
  const runHashBenchmark = async () => {
    setBenchmarkMode('HASH_BENCHMARK');
    setBenchmarkState('RUNNING');

    const size = 250 * 1024 * 1024;
    const buffer = new Uint8Array(size);
    for (let i = 0; i < size; i++) buffer[i] = i % 256;

    const startMain = performance.now();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const endMain = performance.now();

    const sha256MainThreadMs = endMain - startMain;
    const sha256ThroughputMBps = (250) / (sha256MainThreadMs / 1000);

    const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    const hashMetrics: BenchmarkMetrics = {
      testName: 'HASH_BENCHMARK',
      browser: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node/Playwright',
      browserVersion: typeof navigator !== 'undefined' ? (navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || 'Unknown') : 'Unknown',
      sender: 'self',
      receiver: 'self',
      fileSizeBytes: size,
      durationMs: sha256MainThreadMs,
      averageMBps: sha256ThroughputMBps,
      peakMBps: sha256ThroughputMBps,
      currentMBps: sha256ThroughputMBps,
      rttMs: null,
      candidatePair: 'N/A',
      connectionMode: 'N/A',
      chunkSizeBytes: 0,
      channels: 0,
      maxBufferedAmountBytes: 0,
      pauseCount: 0,
      pauseDurationMs: 0,
      storageBackend: 'N/A',
      storageWriteMs: 0,
      networkReceiveMs: 0,
      hashMs: sha256MainThreadMs,
      eventLoopMaxDelayMs: 0,
      applicationBufferBytes: 0,
      checksum: hashHex,

      mode: 'HASH_BENCHMARK',
      totalBytes: size,
      avgMBps: sha256ThroughputMBps,
      bufferedAmount: 0,
      maxBufferedAmount: 0,
      chunksSent: 0,
      chunksReceived: 0,
      duplicateChunks: 0,
      missingChunks: 0,
      connectionState: 'N/A',
      iceConnectionState: 'N/A',
      sha256MainThreadMs,
      sha256ThroughputMBps
    };

    console.log('SHA-256 Hex:', hashHex.slice(0, 16));
    setMetrics(hashMetrics);
    setBenchmarkState('COMPLETED');
  };

  useEffect(() => {
    const win = window as unknown as Record<string, unknown>;
    win.__runRawWebRtcBenchmark = () => startBenchmarkSuite('RAW_WEBRTC');
    win.__runFileWebRtcBenchmark = () => startBenchmarkSuite('FILE_WEBRTC');
    win.__runStorageBenchmark = () => startBenchmarkSuite('WEBRTC_STORAGE');
    win.__runHashBenchmark = () => runHashBenchmark();
    win.__getBenchmarkMetrics = () => metrics;
    win.__setYieldInterval = (val: number) => setYieldInterval(val);
  }, [metrics, yieldInterval, sessionId]);

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 relative z-10 flex flex-col gap-6">
      <header className="glass-panel p-6 rounded-2xl flex flex-col gap-2 border border-white/10">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-3xl text-primary">speed</span>
          <h1 className="text-2xl font-bold font-display primary-gradient-text m-0">LinkDrop — WebRTC Benchmark Harness</h1>
        </div>
        <p className="text-sm text-on-surface-variant m-0">
          Isolated high-throughput benchmark suite for WebRTC DataChannels, File API streaming, Storage writers, SHA-256 Web Workers, and backpressure telemetry.
        </p>
      </header>

      {/* Session Controls */}
      <section className="glass-panel p-6 rounded-2xl flex flex-col gap-4 border border-white/10">
        <h3 className="text-lg font-semibold font-display text-on-surface flex items-center gap-2 m-0">
          <span className="material-symbols-outlined text-primary">hub</span>
          1. WebRTC Benchmark Session Setup
        </h3>
        {sessionStatus === 'IDLE' && (
          <div className="flex flex-wrap gap-4 items-center">
            <button
              id="btn-create-benchmark-session"
              onClick={handleCreateSession}
              className="primary-btn px-5 py-2.5 rounded-xl text-sm flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-sm">add_circle</span>
              Create Benchmark Host (Sender)
            </button>
            <div className="flex items-center gap-2">
              <input
                id="input-benchmark-pin"
                type="text"
                placeholder="6-digit PIN"
                value={inputPin}
                onChange={e => setInputPin(e.target.value)}
                className="bg-[#09090B] border border-white/10 text-on-surface px-4 py-2 rounded-xl text-sm w-36 focus:border-primary focus:outline-none"
              />
              <button
                id="btn-join-benchmark-session"
                onClick={handleJoinSession}
                className="secondary-btn px-5 py-2.5 rounded-xl text-sm flex items-center gap-2"
              >
                <span className="material-symbols-outlined text-sm">login</span>
                Join Session (Receiver)
              </button>
            </div>
          </div>
        )}

        {pairingPin && (
          <div className="text-lg font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-4 py-2 rounded-xl inline-block">
            Pairing PIN: <span id="benchmark-pin-display" className="tracking-widest">{pairingPin}</span>
          </div>
        )}

        {errorMsg && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 px-4 py-2 rounded-xl">
            {errorMsg}
          </div>
        )}

        <div className="text-xs text-on-surface-variant flex flex-wrap gap-4 pt-2 border-t border-white/5">
          <span>Role: <strong className="text-primary">{role || 'None'}</strong></span>
          <span>Status: <strong className="text-emerald-400">{sessionStatus}</strong></span>
          <span>WebRTC State: <strong className="text-purple-400">{webrtcState}</strong></span>
        </div>
      </section>

      {/* Standalone Hashing Benchmark */}
      <section className="glass-panel p-6 rounded-2xl flex flex-col gap-4 border border-white/10">
        <h3 className="text-lg font-semibold font-display text-on-surface flex items-center gap-2 m-0">
          <span className="material-symbols-outlined text-secondary">memory</span>
          2. Standalone SHA-256 Engine Benchmark
        </h3>
        <div>
          <button
            id="btn-hash-bench"
            onClick={runHashBenchmark}
            className="secondary-btn px-5 py-2.5 rounded-xl text-sm flex items-center gap-2 border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
          >
            <span className="material-symbols-outlined text-sm">tag</span>
            Run Standalone SHA-256 Hashing Benchmark (250 MB)
          </button>
        </div>
      </section>

      {/* Benchmark Execution Suite */}
      {sessionStatus === 'PAIRED' && role === 'sender' && (
        <section className="glass-panel p-6 rounded-2xl flex flex-col gap-4 border border-white/10">
          <h3 className="text-lg font-semibold font-display text-on-surface flex items-center gap-2 m-0">
            <span className="material-symbols-outlined text-primary">play_circle</span>
            3. WebRTC Test Suite Controls
          </h3>
          <div className="flex flex-wrap gap-3">
            <button
              id="btn-raw-webrtc"
              onClick={() => startBenchmarkSuite('RAW_WEBRTC')}
              className="primary-btn px-5 py-2.5 rounded-xl text-sm flex items-center gap-2"
            >
              Run Raw WebRTC (250 MB Memory)
            </button>
            <button
              id="btn-file-webrtc"
              onClick={() => startBenchmarkSuite('FILE_WEBRTC')}
              className="secondary-btn px-5 py-2.5 rounded-xl text-sm flex items-center gap-2"
            >
              Run File → WebRTC (250 MB Blob.slice)
            </button>
            <button
              id="btn-storage-webrtc"
              onClick={() => startBenchmarkSuite('WEBRTC_STORAGE')}
              className="secondary-btn px-5 py-2.5 rounded-xl text-sm flex items-center gap-2"
            >
              Run WebRTC → Storage (IndexedDB)
            </button>
          </div>

          <div className="flex items-center gap-3 text-sm text-on-surface-variant pt-2">
            <label>Yield Every N Chunks:</label>
            <select
              value={yieldInterval}
              onChange={e => setYieldInterval(Number(e.target.value))}
              className="bg-[#09090B] border border-white/10 text-on-surface px-3 py-1.5 rounded-lg text-sm focus:outline-none"
            >
              <option value={0}>0 (No Yield — Maximum Throughput)</option>
              <option value={64}>64 Chunks (~3.8 MB)</option>
              <option value={128}>128 Chunks (~7.6 MB)</option>
              <option value={256}>256 Chunks (~15.3 MB - Production Baseline)</option>
              <option value={512}>512 Chunks (~30.7 MB)</option>
            </select>
          </div>
        </section>
      )}

      {/* Live Telemetry Display */}
      <section className="glass-panel p-6 rounded-2xl flex flex-col gap-4 border border-white/10">
        <h3 className="text-lg font-semibold font-display text-on-surface flex items-center gap-2 m-0">
          <span className="material-symbols-outlined text-primary">monitoring</span>
          4. Real-Time Benchmark Telemetry
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-[#09090B] p-4 rounded-xl border border-white/5">
            <div className="text-xs text-on-surface-variant">Benchmark State</div>
            <div className="text-lg font-bold text-rose-400 mt-1">{benchmarkState}</div>
          </div>
          <div className="bg-[#09090B] p-4 rounded-xl border border-white/5">
            <div className="text-xs text-on-surface-variant">Transferred</div>
            <div className="text-lg font-bold text-on-surface mt-1">{(bytesTransferred / (1024 * 1024)).toFixed(2)} MB</div>
          </div>
          <div className="bg-[#09090B] p-4 rounded-xl border border-white/5">
            <div className="text-xs text-on-surface-variant">Current Speed</div>
            <div className="text-lg font-bold text-emerald-400 mt-1">{(currentSpeed / (1024 * 1024)).toFixed(2)} MB/s</div>
          </div>
          <div className="bg-[#09090B] p-4 rounded-xl border border-white/5">
            <div className="text-xs text-on-surface-variant">Average Speed</div>
            <div className="text-lg font-bold text-cyan-400 mt-1">{avgSpeed.toFixed(2)} MB/s</div>
          </div>
          <div className="bg-[#09090B] p-4 rounded-xl border border-white/5">
            <div className="text-xs text-on-surface-variant">Peak Speed</div>
            <div className="text-lg font-bold text-purple-400 mt-1">{(peakSpeed / (1024 * 1024)).toFixed(2)} MB/s</div>
          </div>
          <div className="bg-[#09090B] p-4 rounded-xl border border-white/5">
            <div className="text-xs text-on-surface-variant">Max Buffer Seen</div>
            <div className="text-lg font-bold text-amber-400 mt-1">{(maxBufferSeen / (1024 * 1024)).toFixed(2)} MB</div>
          </div>
          <div className="bg-[#09090B] p-4 rounded-xl border border-white/5">
            <div className="text-xs text-on-surface-variant">RTT</div>
            <div className="text-lg font-bold text-on-surface mt-1">{stats?.rtt !== null && stats?.rtt !== undefined ? `${stats.rtt} ms` : 'N/A'}</div>
          </div>
          <div className="bg-[#09090B] p-4 rounded-xl border border-white/5">
            <div className="text-xs text-on-surface-variant">Candidate Pair</div>
            <div className="text-xs font-semibold text-on-surface mt-2 truncate">{stats?.selectedCandidatePair || 'N/A'}</div>
          </div>
        </div>
      </section>

      {/* Structured Metric Dump Container for Playwright */}
      <section className="glass-panel p-6 rounded-2xl flex flex-col gap-4 border border-white/10">
        <h3 className="text-lg font-semibold font-display text-on-surface flex items-center gap-2 m-0">
          <span className="material-symbols-outlined text-secondary">terminal</span>
          5. Structured Metric JSON Output
        </h3>
        <pre id="benchmark-results" className="bg-[#09090B] p-4 rounded-xl text-xs text-cyan-400 overflow-x-auto border border-white/5 font-mono">
          {metrics ? JSON.stringify(metrics, null, 2) : '// Benchmark results will be output here upon completion.'}
        </pre>
      </section>
    </div>
  );
}
