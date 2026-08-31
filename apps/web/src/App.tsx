import { useState, useEffect, useRef } from 'react';
import { PROTOCOL_VERSION } from '@linkdrop/protocol';
import { WebRtcManager, WebRtcState, WebRtcStats } from './lib/webrtc/WebRtcManager';
import { StorageWriter, StorageWriteResult } from './lib/storage/StorageWriter';
import { createStorageWriter, createFallbackWriter } from './lib/storage/StorageCapabilityWriter';
import { BoundedWriteQueue } from './lib/storage/BoundedWriteQueue';
import { BoundedFileReader } from './lib/storage/BoundedFileReader';
import { BenchmarkPage } from './BenchmarkPage';
import { CrystalBackground } from './components/CrystalBackground';

const SIGNALING_API_URL = import.meta.env.VITE_SIGNALING_API_URL || 'http://localhost:3000';
const SIGNALING_WS_URL = import.meta.env.VITE_SIGNALING_WS_URL || 'ws://localhost:3000';

function MainApp() {
  const [peerId] = useState(() => crypto.randomUUID());
  const [role, setRole] = useState<'sender' | 'receiver' | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pairingPin, setPairingPin] = useState<string | null>(null);
  const [inputPin, setInputPin] = useState('');
  const [landingMode, setLandingMode] = useState<'send' | 'receive'>('send');
  const [sessionStatus, setSessionStatus] = useState<'IDLE' | 'CREATED' | 'WAITING_FOR_PEER' | 'PAIRED' | 'ERROR'>('IDLE');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);

  // WebRTC States
  const [webrtcState, setWebrtcState] = useState<WebRtcState>('WEBRTC_IDLE');
  const [dataChannelState, setDataChannelState] = useState<RTCDataChannelState | 'closed'>('closed');
  const [stats, setStats] = useState<WebRtcStats | null>(null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [pingCount, setPingCount] = useState(0);
  const [pongCount, setPongCount] = useState(0);

  // File Transfer States
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [transferState, setTransferState] = useState<'IDLE' | 'PREPARING' | 'TRANSFERRING' | 'PAUSED' | 'COMPLETING' | 'COMPLETED' | 'CANCELLED' | 'FAILED'>('IDLE');
  const [bytesTransferred, setBytesTransferred] = useState(0);
  const [transferSpeed, setTransferSpeed] = useState(0);
  const [avgSpeed, setAvgSpeed] = useState(0);
  const [peakSpeed, setPeakSpeed] = useState(0);
  const [eta, setEta] = useState<number | null>(null);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [incomingMetadata, setIncomingMetadata] = useState<{ transferId: string; fileName: string; fileSize: number; mimeType: string; totalChunks: number; chunkSize: number; hash: string } | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [integrityMatch, setIntegrityMatch] = useState<boolean | null>(null);
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [remoteHash, setRemoteHash] = useState<string | null>(null);
  const [storageBackend, setStorageBackend] = useState<string>('unknown');

  const wsRef = useRef<WebSocket | null>(null);
  const rtcManagerRef = useRef<WebRtcManager | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // File Sender & Receiver Refs
  const isSendingRef = useRef(false);
  const isPausedRef = useRef(false);
  const storageWriterRef = useRef<StorageWriter | null>(null);
  const boundedWriteQueueRef = useRef<BoundedWriteQueue | null>(null);
  const receivedChunksRef = useRef<Set<number>>(new Set());
  const saveHandleRef = useRef<FileSystemFileHandle | null>(null);
  const stallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const roleRef = useRef<'sender' | 'receiver' | null>(null);
  const sessionStatusRef = useRef<'IDLE' | 'CREATED' | 'WAITING_FOR_PEER' | 'PAIRED' | 'ERROR'>('IDLE');

  const selectedFileRef = useRef<File | null>(null);
  const incomingMetadataRef = useRef<{ transferId: string; fileName: string; fileSize: number; mimeType: string; totalChunks: number; chunkSize: number; hash: string } | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const transferStateRef = useRef<string>('IDLE');
  const transferIdRef = useRef<string | null>(null);
  const bytesTransferredRef = useRef<number>(0);

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    incomingMetadataRef.current = incomingMetadata;
  }, [incomingMetadata]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    transferStateRef.current = transferState;
  }, [transferState]);

  useEffect(() => {
    bytesTransferredRef.current = bytesTransferred;
  }, [bytesTransferred]);

  // Unified real-time telemetry calculation for both sender and receiver
  useEffect(() => {
    if (transferState !== 'TRANSFERRING') {
      return;
    }

    const startTime = Date.now();
    let lastTime = Date.now();
    let lastBytes = 0;

    const telemetryInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - startTime) / 1000;
      const currentBytes = bytesTransferredRef.current;

      // Current Speed
      const bytesDiff = currentBytes - lastBytes;
      const timeDiff = (now - lastTime) / 1000;
      if (timeDiff > 0) {
        const speed = bytesDiff / timeDiff;
        setTransferSpeed(speed);
        setPeakSpeed(prev => Math.max(prev, speed));
      }
      lastBytes = currentBytes;
      lastTime = now;

      // Average Speed & ETA
      const totalSize = incomingMetadataRef.current?.fileSize || selectedFileRef.current?.size || 0;
      if (elapsed > 0) {
        const avg = currentBytes / elapsed;
        setAvgSpeed(avg);
        const remaining = totalSize - currentBytes;
        setEta(avg > 0 && remaining > 0 ? Math.ceil(remaining / avg) : null);
      }
      setBytesTransferred(currentBytes);
    }, 500);

    return () => clearInterval(telemetryInterval);
  }, [transferState]);

  useEffect(() => {
    transferIdRef.current = transferId;
  }, [transferId]);

  // Clean up WebRTC & WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (rtcManagerRef.current) rtcManagerRef.current.close();
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      if (stallTimeoutRef.current) clearTimeout(stallTimeoutRef.current);
    };
  }, []);

  // Connection timeout monitoring
  useEffect(() => {
    if (webrtcState === 'WEBRTC_CONNECTING' || webrtcState === 'WEBRTC_ICE_CONNECTING') {
      if (!connectionTimeoutRef.current) {
        connectionTimeoutRef.current = setTimeout(() => {
          if (rtcManagerRef.current && rtcManagerRef.current.getConnectionState() !== 'connected') {
            console.warn('WebRTC connection timed out');
            setWebrtcState('WEBRTC_FAILED');
            rtcManagerRef.current.close();
          }
        }, 15000);
      }
    } else {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    }
  }, [webrtcState]);

  // Telemetry updates
  useEffect(() => {
    let statsInterval: ReturnType<typeof setInterval> | null = null;
    if (webrtcState === 'WEBRTC_CONNECTED') {
      statsInterval = setInterval(() => {
        if (rtcManagerRef.current) {
          rtcManagerRef.current.getStats().then(report => {
            setStats(report);
          });
        }
      }, 1000);
    } else {
      setStats(null);
    }
    return () => {
      if (statsInterval) clearInterval(statsInterval);
    };
  }, [webrtcState]);

  // Stall Detection: Monitor progress state
  useEffect(() => {
    if (transferState === 'TRANSFERRING' || transferState === 'PAUSED') {
      if (stallTimeoutRef.current) clearTimeout(stallTimeoutRef.current);
      stallTimeoutRef.current = setTimeout(() => {
        console.warn('File transfer stalled: no progress in 45 seconds');
        handleCancelTransfer('Transfer stalled');
      }, 45000);
    } else {
      if (stallTimeoutRef.current) {
        clearTimeout(stallTimeoutRef.current);
        stallTimeoutRef.current = null;
      }
    }
  }, [bytesTransferred, transferState]);

  const initWebRtcManager = (sessId: string, currentPeerId: string, currentWs: WebSocket) => {
    if (rtcManagerRef.current) return rtcManagerRef.current;

    let iceServers: RTCIceServer[] | undefined;
    const rtcIceServersEnv = import.meta.env.VITE_RTC_ICE_SERVERS;
    if (rtcIceServersEnv) {
      try {
        iceServers = JSON.parse(rtcIceServersEnv);
      } catch {
        // ignored
      }
    }

    const manager = new WebRtcManager({
      iceServers,
      onSignalingMessage: (type, payload) => {
        if (currentWs.readyState === 1 /* OPEN */) {
          currentWs.send(JSON.stringify({
            type,
            sessionId: sessId,
            peerId: currentPeerId,
            payload
          }));
        }
      },
      onStateChange: (state) => {
        setWebrtcState(state);
        if (state === 'WEBRTC_FAILED' || state === 'WEBRTC_DISCONNECTED' || state === 'WEBRTC_CLOSED') {
          setTransferState(current => {
            if (current === 'TRANSFERRING' || current === 'PAUSED' || current === 'PREPARING' || current === 'COMPLETING') {
              setErrorMsg('WebRTC connection disconnected');
              isSendingRef.current = false;
              if (storageWriterRef.current) {
                storageWriterRef.current.abort().catch(() => {});
                storageWriterRef.current = null;
              }
              return 'FAILED';
            }
            return current;
          });
        }
      },
      onDataChannelStateChange: (state) => {
        setDataChannelState(state);
      },
      onDataChannelMessage: (data) => {
        const dataObj = data as Record<string, unknown>;
        if (dataObj.type === 'WEBRTC_TEST_PING') {
          setPongCount(p => p + 1);
          manager.sendControlMessage({
            type: 'WEBRTC_TEST_PONG',
            messageId: dataObj.messageId as string,
            timestamp: dataObj.timestamp as number
          });
        } else if (dataObj.type === 'WEBRTC_TEST_PONG') {
          const now = Date.now();
          const elapsed = now - (dataObj.timestamp as number);
          setRtt(elapsed);
          setPongCount(p => p + 1);
        } else if (dataObj.type === 'FILE_TRANSFER_ACCEPT') {
          console.log('Received FILE_TRANSFER_ACCEPT control message from peer');
          if (roleRef.current === 'sender' && selectedFileRef.current) {
            startSendingFile(selectedFileRef.current, dataObj.transferId as string);
          }
        }
      },
      onFileDataChannelMessage: (index, payload) => {
        if (receivedChunksRef.current.has(index)) return; // duplicate
        receivedChunksRef.current.add(index);

        const meta = incomingMetadataRef.current;
        if (meta) {
          const currentBytes = Math.min(receivedChunksRef.current.size * meta.chunkSize, meta.fileSize);
          bytesTransferredRef.current = currentBytes;
          if (receivedChunksRef.current.size % 32 === 0 || currentBytes >= meta.fileSize) {
            setBytesTransferred(currentBytes);
          }
        }

        if (boundedWriteQueueRef.current) {
          boundedWriteQueueRef.current.enqueue(index, payload).catch((err) => {
            console.error('Storage write queue error:', err);
            handleCancelTransfer('Storage write failed');
          });
        }
      },
      onBufferedAmountLow: () => {
        isPausedRef.current = false;
      }
    });

    rtcManagerRef.current = manager;
    return manager;
  };

  const connectWebSocket = (sessId: string, currentPeerId: string) => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const wsUrl = `${SIGNALING_WS_URL}/ws/signaling/${sessId}/${currentPeerId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket signaling connection opened');
      ws.send(JSON.stringify({
        type: 'CLIENT_HELLO',
        sessionId: sessId,
        peerId: currentPeerId
      }));
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('Received message:', JSON.stringify(msg));

        if (msg.type === 'PING') {
          ws.send(JSON.stringify({
            type: 'PONG',
            sessionId: sessId,
            peerId: currentPeerId
          }));
          return;
        }

        if (msg.type === 'PEER_JOINED') {
          setSessionStatus('WAITING_FOR_PEER');
          setConnectedPeers(prev => [...new Set([...prev, msg.peerId])]);
        }

        if (msg.type === 'SESSION_PAIRED') {
          setSessionStatus('PAIRED');
          const otherPeers = (msg.payload?.peers || []).filter((id: string) => id !== currentPeerId);
          setConnectedPeers(otherPeers);

          if (roleRef.current === 'sender') {
            const manager = initWebRtcManager(sessId, currentPeerId, ws);
            manager.createPeerConnection();
            manager.createControlChannel();
            manager.createFileChannel();
            manager.createOffer().then(offer => {
              ws.send(JSON.stringify({
                type: 'WEBRTC_OFFER',
                sessionId: sessId,
                peerId: currentPeerId,
                payload: offer
              }));
            });
          }
        }

        if (msg.type === 'PEER_LEFT') {
          setSessionStatus('WAITING_FOR_PEER');
          setConnectedPeers(prev => prev.filter(id => id !== msg.peerId));
          if (rtcManagerRef.current) {
            rtcManagerRef.current.close();
            rtcManagerRef.current = null;
          }
          setWebrtcState('WEBRTC_DISCONNECTED');
          setDataChannelState('closed');
          setRtt(null);

          if (transferStateRef.current === 'TRANSFERRING' || transferStateRef.current === 'PAUSED' || transferStateRef.current === 'PREPARING' || transferStateRef.current === 'COMPLETING') {
            isSendingRef.current = false;
            setTransferState('FAILED');
            setErrorMsg('Peer disconnected mid-transfer');
          }
        }

        if (msg.type === 'SESSION_ERROR') {
          setSessionStatus('ERROR');
          setErrorMsg(msg.payload?.message || 'A session error occurred');
          ws.close();
        }

        if (msg.type === 'WEBRTC_OFFER') {
          const manager = initWebRtcManager(sessId, currentPeerId, ws);
          manager.handleOffer(msg.payload).then(answer => {
            ws.send(JSON.stringify({
              type: 'WEBRTC_ANSWER',
              sessionId: sessId,
              peerId: currentPeerId,
              payload: answer
            }));
          });
        }

        if (msg.type === 'WEBRTC_ANSWER') {
          if (rtcManagerRef.current) {
            rtcManagerRef.current.handleAnswer(msg.payload);
          }
        }

        if (msg.type === 'ICE_CANDIDATE') {
          if (rtcManagerRef.current) {
            rtcManagerRef.current.handleIceCandidate(msg.payload);
          }
        }

        // File Transfer Messages
        if (msg.type === 'FILE_TRANSFER_START') {
          incomingMetadataRef.current = msg.payload;
          setIncomingMetadata(msg.payload);
          setTransferState('PREPARING');
          setBytesTransferred(0);
          setDownloadUrl(null);
          setIntegrityMatch(null);
          setLocalHash(null);
          setRemoteHash(msg.payload.hash);
        }

        if (msg.type === 'FILE_TRANSFER_COMPLETE') {
          setTransferState('COMPLETING');
          await handleReceiveComplete();
        }

        if (msg.type === 'FILE_TRANSFER_CANCEL') {
          isSendingRef.current = false;
          setTransferState('CANCELLED');
          setErrorMsg(`Transfer cancelled by peer: ${msg.payload.reason}`);
          if (storageWriterRef.current) {
            await storageWriterRef.current.abort();
            storageWriterRef.current = null;
          }
        }
      } catch (err) {
        console.error('Error parsing signaling message:', err);
      }
    };

    ws.onclose = (event) => {
      console.log('WebSocket signaling connection closed', event);
      if (sessionStatusRef.current !== 'ERROR' && sessionStatusRef.current !== 'IDLE') {
        setSessionStatus('ERROR');
        setErrorMsg('Signaling channel disconnected');
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      ws.close();
    };
  };

  const handleCreateSession = async () => {
    try {
      setErrorMsg(null);
      const res = await fetch(`${SIGNALING_API_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorPeerId: peerId })
      });

      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.message || 'Failed to create session');
      }

      const data = await res.json();
      setRole('sender');
      setSessionId(data.sessionId);
      setPairingPin(data.pairingPin);
      setSessionStatus('CREATED');
      connectWebSocket(data.sessionId, peerId);
    } catch (err) {
      setSessionStatus('ERROR');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create session');
    }
  };

  const handleJoinSession = async () => {
    if (inputPin.length !== 6) {
      setErrorMsg('PIN must be exactly 6 digits');
      return;
    }

    try {
      setErrorMsg(null);
      const res = await fetch(`${SIGNALING_API_URL}/api/sessions/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingPin: inputPin, peerId })
      });

      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.message || 'Failed to join session');
      }

      const data = await res.json();
      setRole('receiver');
      setSessionId(data.sessionId);
      setSessionStatus('WAITING_FOR_PEER');
      connectWebSocket(data.sessionId, peerId);
    } catch (err) {
      setSessionStatus('ERROR');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to join session');
    }
  };

  const handleReset = () => {
    if (wsRef.current) wsRef.current.close();
    if (rtcManagerRef.current) rtcManagerRef.current.close();
    setRole(null);
    setSessionId(null);
    setPairingPin(null);
    setInputPin('');
    setSessionStatus('IDLE');
    setErrorMsg(null);
    setConnectedPeers([]);
    setWebrtcState('WEBRTC_IDLE');
    setDataChannelState('closed');
    setRtt(null);
    setStats(null);
    setPingCount(0);
    setPongCount(0);

    // Reset transfer state
    setSelectedFile(null);
    setTransferState('IDLE');
    setBytesTransferred(0);
    setTransferSpeed(0);
    setAvgSpeed(0);
    setPeakSpeed(0);
    setEta(null);
    setTransferId(null);
    setIncomingMetadata(null);
    setDownloadUrl(null);
    setIntegrityMatch(null);
    setLocalHash(null);
    setRemoteHash(null);
    isSendingRef.current = false;
    isPausedRef.current = false;
    storageWriterRef.current = null;
    boundedWriteQueueRef.current = null;
    saveHandleRef.current = null;
    setStorageBackend('unknown');
  };

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__resetTransfer = () => {
      setSelectedFile(null);
      setTransferState('IDLE');
      setBytesTransferred(0);
      setTransferSpeed(0);
      setAvgSpeed(0);
      setPeakSpeed(0);
      setEta(null);
      setTransferId(null);
      setIncomingMetadata(null);
      setDownloadUrl(null);
      setIntegrityMatch(null);
      setLocalHash(null);
      setRemoteHash(null);
      incomingMetadataRef.current = null;
      isSendingRef.current = false;
      isPausedRef.current = false;
      storageWriterRef.current = null;
      boundedWriteQueueRef.current = null;
      saveHandleRef.current = null;
    };
  }, []);

  const handleSendPing = () => {
    if (rtcManagerRef.current && dataChannelState === 'open') {
      const pingId = crypto.randomUUID();
      const pingMsg = {
        type: 'WEBRTC_TEST_PING',
        messageId: pingId,
        timestamp: Date.now()
      };
      setPingCount(p => p + 1);
      try {
        rtcManagerRef.current.sendControlMessage(pingMsg);
      } catch (err) {
        console.error('Failed to send WebRTC ping:', err);
      }
    }
  };

  // Helper: SHA-256 integrity calculator
  const calculateSha256 = async (fileObj: File | Blob): Promise<string> => {
    const buffer = await fileObj.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  };

  // Sender: Start File Transfer
  const handleStartTransfer = async () => {
    if (!selectedFile || !sessionId) return;
    setErrorMsg(null);
    setTransferState('PREPARING');
    setTransferSpeed(0);
    setAvgSpeed(0);
    setPeakSpeed(0);
    setEta(null);

    const tId = crypto.randomUUID();
    setTransferId(tId);

    try {
      const chunkSize = WebRtcManager.CHUNK_SIZE;
      const fileSize = selectedFile.size;
      const totalChunks = Math.ceil(fileSize / chunkSize);

      // Send start message instantly without blocking or RAM pre-allocation
      wsRef.current?.send(JSON.stringify({
        type: 'FILE_TRANSFER_START',
        sessionId: sessionIdRef.current!,
        peerId,
        payload: {
          transferId: tId,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          mimeType: selectedFile.type || 'application/octet-stream',
          totalChunks,
          chunkSize,
          hash: ''
        }
      }));
    } catch (err) {
      console.error('Hash generation or transfer initiation failed:', err);
      setTransferState('FAILED');
      setErrorMsg('Failed to initialize transfer');
    }
  };

  const startSendingFile = async (fileObj: File, tId: string) => {
    isSendingRef.current = true;
    isPausedRef.current = false;
    setTransferState('TRANSFERRING');
    setBytesTransferred(0);

    const chunkSize = WebRtcManager.CHUNK_SIZE;
    const fileSize = fileObj.size;

    // Reset adaptive watermark state for this transfer
    rtcManagerRef.current?.resetAdaptiveState();

    // Periodic adaptive watermark sampling
    const adaptiveInterval = setInterval(() => {
      rtcManagerRef.current?.sampleAndAdapt();
    }, 250);

    let chunkIndex = 0;
    const fileReader = new BoundedFileReader(fileObj, chunkSize, 256);

    try {
      while (isSendingRef.current) {
        if (rtcManagerRef.current && rtcManagerRef.current.getFileBufferedAmount() > rtcManagerRef.current.getCurrentHighWatermark()) {
          isPausedRef.current = true;
          await new Promise<void>((resolve) => {
            const checkInterval = setInterval(() => {
              const currentBuf = rtcManagerRef.current?.getFileBufferedAmount() ?? 0;
              const lowMark = rtcManagerRef.current?.getCurrentLowWatermark() ?? WebRtcManager.LOW_WATERMARK;
              if (!isPausedRef.current || !isSendingRef.current || currentBuf <= lowMark) {
                isPausedRef.current = false;
                clearInterval(checkInterval);
                resolve();
              }
            }, 5);
          });
        }

        if (!isSendingRef.current) break;

        const payload = await fileReader.readNextChunk();
        if (!payload) break; // End of file

        try {
          rtcManagerRef.current?.sendFileChunk(chunkIndex, payload);
        } catch (err) {
          // If socket buffer temporarily full, wait 10ms for drain and retry chunk without crashing
          await new Promise(r => setTimeout(r, 10));
          continue;
        }

        chunkIndex++;
        const sentBytes = Math.min(chunkIndex * chunkSize, fileSize);
        bytesTransferredRef.current = sentBytes;
        if (chunkIndex % 32 === 0 || sentBytes === fileSize) {
          setBytesTransferred(sentBytes);
        }

        // Yield to macrotask queue every 2048 chunks (~122 MB) so WebSocket
        // PING/PONG and UI events can process cleanly without stalling
        // network throughput.
        if (chunkIndex % 2048 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }

      if (isSendingRef.current) {
        setTransferState('COMPLETING');
        // Wait for buffer drain
        while (rtcManagerRef.current && rtcManagerRef.current.getFileBufferedAmount() > 0) {
          await new Promise(r => setTimeout(r, 100));
        }

        wsRef.current?.send(JSON.stringify({
          type: 'FILE_TRANSFER_COMPLETE',
          sessionId: sessionIdRef.current!,
          peerId,
          payload: { transferId: tId }
        }));
        setTransferState('COMPLETED');
      }
    } catch (err) {
      console.error('File transmission failed:', err);
      setTransferState('FAILED');
      setErrorMsg('Transmission failure');
    } finally {
      clearInterval(adaptiveInterval);
      isSendingRef.current = false;
    }
  };

  // Receiver: Accept & Prepare Save Location
  const handleAcceptFile = async () => {
    if (!incomingMetadata) return;
    setErrorMsg(null);
    setBytesTransferred(0);

    const tId = incomingMetadata.transferId;
    const totalChunks = incomingMetadata.totalChunks;
    const chunkSize = incomingMetadata.chunkSize;
    const mimeType = incomingMetadata.mimeType;
    const fileName = incomingMetadata.fileName;
    const fileSize = incomingMetadata.fileSize;

    let writer: StorageWriter;
    let backend: string;

    try {
      const result = await createStorageWriter({
        transferId: tId,
        fileName,
        fileSize,
        mimeType,
        totalChunks,
        chunkSize
      });
      writer = result.writer;
      backend = result.backend;
      if (result.fileHandle) {
        saveHandleRef.current = result.fileHandle;
      }
    } catch (err) {
      // User cancelled the file picker
      if (err instanceof DOMException && err.name === 'AbortError') {
        setErrorMsg('Save location selection was cancelled.');
        handleCancelTransfer('Save picker cancelled by receiver');
        return;
      }
      // Unexpected error: fall back to IndexedDB
      console.warn('Storage init failed, falling back to IndexedDB:', err);
      const fallback = createFallbackWriter({
        transferId: tId,
        fileName,
        fileSize,
        mimeType,
        totalChunks,
        chunkSize
      });
      writer = fallback.writer;
      backend = fallback.backend;
    }

    storageWriterRef.current = writer;
    boundedWriteQueueRef.current = new BoundedWriteQueue(writer, {
      maxQueueDepth: 4,
      maxReorderSize: 1024
    });
    setStorageBackend(backend);
    setTransferState('TRANSFERRING');

    receivedChunksRef.current = new Set();

    // Send accept notification over control DataChannel to kick off sender loop
    try {
      rtcManagerRef.current?.sendControlMessage({
        type: 'FILE_TRANSFER_ACCEPT',
        transferId: tId
      });
    } catch (err) {
      console.error('Failed to transmit FILE_TRANSFER_ACCEPT:', err);
    }
  };

  const handleReceiveComplete = async () => {
    if (!storageWriterRef.current || !incomingMetadataRef.current) return;
    const meta = incomingMetadataRef.current;

    try {
      if (boundedWriteQueueRef.current) {
        await boundedWriteQueueRef.current.flush();
      }
      const result: StorageWriteResult = await storageWriterRef.current.close();
      setTransferState('COMPLETED');

      // Check integrity match
      let match = false;
      let calculated = '';

      if (result.mode === 'file-system') {
        // FSA path: hash was computed during close()
        if (result.hash) {
          calculated = result.hash;
        } else if (saveHandleRef.current) {
          // Fallback: read from handle
          const fileObj = await saveHandleRef.current.getFile();
          calculated = await calculateSha256(fileObj);
        }
        setLocalHash(calculated);
        match = meta.hash ? calculated === meta.hash : true;
      } else if (result.mode === 'blob' && result.url) {
        setDownloadUrl(result.url);
        if (result.hash) {
          calculated = result.hash;
        } else {
          const res = await fetch(result.url);
          const blob = await res.blob();
          calculated = await calculateSha256(blob);
        }
        setLocalHash(calculated);
        match = meta.hash ? calculated === meta.hash : true;
      }

      setIntegrityMatch(match);
      if (!match) {
        setErrorMsg('Integrity checksum mismatch! The file is corrupt.');
        setTransferState('FAILED');
      }
    } catch (err) {
      console.error('Failed to complete file receipt:', err);
      setTransferState('FAILED');
      setErrorMsg('File assembly or integrity verification failed.');
    } finally {
      storageWriterRef.current = null;
    }
  };

  const handleCancelTransfer = (reason = 'Cancelled by user') => {
    isSendingRef.current = false;
    setTransferState('CANCELLED');
    if (storageWriterRef.current) {
      storageWriterRef.current.abort();
      storageWriterRef.current = null;
    }

    if (sessionIdRef.current) {
      wsRef.current?.send(JSON.stringify({
        type: 'FILE_TRANSFER_CANCEL',
        sessionId: sessionIdRef.current,
        peerId,
        payload: {
          transferId: transferId || incomingMetadata?.transferId,
          reason
        }
      }));
    }
  };

  const formatSpeed = (bytesPerSec: number): string => {
    if (bytesPerSec === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="min-h-screen flex flex-col relative bg-[#09090B] text-[#e5e1e4] selection:bg-purple-500 selection:text-white">
      <CrystalBackground />

      {/* Stitch Top Navigation Bar */}
      <nav className="sticky top-0 z-50 w-full bg-[#09090B]/60 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-bold text-2xl tracking-tight primary-gradient-text font-display">
              LinkDrop
            </span>
            <span className="text-[10px] uppercase font-semibold font-mono tracking-widest px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-300 border border-purple-500/20">
              Protocol v{PROTOCOL_VERSION}
            </span>
          </div>

          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-on-surface-variant">
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); setLandingMode('send'); handleReset(); }}
              className={`hover:text-primary transition-colors ${landingMode === 'send' ? 'text-primary font-semibold border-b-2 border-primary pb-0.5' : ''}`}
            >
              Send
            </a>
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); setLandingMode('receive'); handleReset(); }}
              className={`hover:text-primary transition-colors ${landingMode === 'receive' ? 'text-primary font-semibold border-b-2 border-primary pb-0.5' : ''}`}
            >
              Receive
            </a>
            <a href="/benchmark" className="hover:text-primary transition-colors flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">speed</span>
              Benchmark
            </a>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
              <span>Direct P2P Encrypted</span>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="flex-grow w-full max-w-7xl mx-auto px-4 md:px-8 py-8 relative z-10 flex flex-col gap-12">
        {/* Landing Hero Section */}
        {sessionStatus === 'IDLE' && (
          <section className="flex flex-col lg:flex-row items-center justify-between gap-12 py-8">
            <div className="w-full lg:w-1/2 flex flex-col items-start gap-6">
              <h1 className="text-4xl md:text-6xl font-bold font-display tracking-tight leading-tight m-0">
                Share Anything.<br />
                <span className="primary-gradient-text">Instantly.</span>
              </h1>
              <p className="text-base md:text-lg text-on-surface-variant max-w-lg m-0">
                Fast, private, direct peer-to-peer file transfer between your devices. No clouds, no servers, no file size limits.
              </p>

              <div className="w-full max-w-md flex flex-col gap-4 mt-2">
                <div className="glass-panel p-6 rounded-2xl flex flex-col gap-4 border border-white/10 shadow-2xl">
                  {/* Transfer Action Controls */}
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-xs font-semibold text-on-surface flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-base text-primary">send</span>
                        Host a Transfer Session
                      </label>
                      <button
                        onClick={handleCreateSession}
                        className="primary-btn w-full py-3.5 px-6 rounded-xl font-semibold text-sm flex items-center justify-center gap-2"
                        id="btn-create-session"
                      >
                        <span className="material-symbols-outlined text-base">send</span>
                        SEND FILES (START SESSION)
                      </button>
                    </div>

                    <div className="relative flex items-center justify-center my-1">
                      <div className="border-t border-white/10 w-full"></div>
                      <span className="bg-[#09090B] px-3 text-[10px] uppercase font-mono tracking-widest text-on-surface-variant absolute">OR RECEIVE FILES</span>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-xs font-semibold text-on-surface flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-base text-secondary">download</span>
                        Enter Receiver Pairing PIN
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          maxLength={6}
                          placeholder="Enter 6-digit PIN"
                          value={inputPin}
                          onChange={(e) => setInputPin(e.target.value.replace(/\D/g, ''))}
                          id="input-pin"
                          className="bg-[#09090B] border border-white/10 text-on-surface px-4 py-3 rounded-xl text-base text-center tracking-widest font-mono font-bold w-full focus:border-primary focus:outline-none"
                        />
                        <button
                          onClick={handleJoinSession}
                          className="secondary-btn py-3 px-6 rounded-xl text-sm font-semibold whitespace-nowrap flex items-center justify-center gap-1"
                          id="btn-join-session"
                        >
                          <span className="material-symbols-outlined text-base">download</span>
                          Join
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Spacer for 3D Crystal artifact */}
            <div className="w-full lg:w-1/2 h-64 lg:h-[450px] pointer-events-none"></div>
          </section>
        )}

        {/* Active Session Coordination Panel */}
        {sessionStatus !== 'IDLE' && (
          <section className="w-full max-w-3xl mx-auto flex flex-col gap-6">
            <div className="glass-panel p-6 md:p-8 rounded-2xl flex flex-col gap-6 border border-white/10 shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-2xl text-primary">sync</span>
                  <h2 className="text-xl font-bold font-display text-on-surface m-0">P2P Session Coordination</h2>
                </div>
                <span id="session-status-text" className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${sessionStatus === 'PAIRED' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}`}>
                  {sessionStatus}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-on-surface-variant bg-[#09090B]/60 p-4 rounded-xl border border-white/5">
                <div>
                  <span className="block text-[10px] text-gray-500 uppercase">Your Peer ID</span>
                  <span className="font-mono text-on-surface text-[11px] truncate block">{peerId}</span>
                </div>
                <div>
                  <span className="block text-[10px] text-gray-500 uppercase">Session ID</span>
                  <span id="session-id-display" className="font-mono text-on-surface text-[11px] truncate block">{sessionId}</span>
                </div>
                <div>
                  <span className="block text-[10px] text-gray-500 uppercase">Role</span>
                  <span className="font-semibold text-primary capitalize">{role || 'Unassigned'}</span>
                </div>
              </div>

              {pairingPin && (
                <div className="flex flex-col items-center justify-center p-6 rounded-xl bg-purple-500/5 border border-purple-500/20 text-center gap-2 pulse-glow">
                  <span className="text-xs uppercase font-mono tracking-widest text-purple-300">Pairing PIN Code</span>
                  <div id="pairing-pin-display" className="text-4xl md:text-5xl font-extrabold font-mono tracking-widest text-purple-400">
                    {pairingPin}
                  </div>
                  <span className="text-xs text-on-surface-variant">Enter this 6-digit PIN on the receiving device to initiate direct P2P link.</span>
                </div>
              )}

              {sessionStatus === 'PAIRED' && (
                <div className="flex flex-col gap-6">
                  <div className="flex items-center gap-2 text-emerald-400 bg-emerald-500/10 p-3 rounded-xl border border-emerald-500/20">
                    <span className="material-symbols-outlined text-lg">check_circle</span>
                    <div>
                      <p id="peer-connected-indicator" className="font-bold text-sm m-0">Peer Connected</p>
                      <p className="text-xs text-emerald-300/80 m-0">Connected Peer ID: <span className="font-mono">{connectedPeers[0]}</span></p>
                    </div>
                  </div>

                  {/* Sender File Selection */}
                  {role === 'sender' && transferState === 'IDLE' && (
                    <div className="flex flex-col gap-4 p-6 rounded-xl border-2 border-dashed border-white/10 hover:border-primary/40 transition-colors bg-[#09090B]/40 text-center">
                      <span className="material-symbols-outlined text-4xl text-primary mx-auto">cloud_upload</span>
                      <h3 className="text-base font-semibold text-on-surface m-0">Select File to Transfer</h3>
                      <input
                        type="file"
                        id="file-input"
                        onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                        className="block w-full text-xs text-on-surface-variant file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-primary file:text-white hover:file:bg-purple-600 cursor-pointer"
                      />
                      {selectedFile && (
                        <div className="flex flex-col items-center gap-2 pt-2 border-t border-white/5">
                          <p className="text-sm font-semibold text-on-surface m-0">Selected: {selectedFile.name} ({formatSize(selectedFile.size)})</p>
                          <button
                            onClick={handleStartTransfer}
                            id="btn-start-transfer"
                            className="primary-btn py-3 px-8 rounded-xl text-sm mt-2 flex items-center gap-2"
                            disabled={webrtcState !== 'WEBRTC_CONNECTED'}
                          >
                            <span className="material-symbols-outlined text-base">send</span>
                            Start File Transfer
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Receiver Accept Prompt */}
                  {role === 'receiver' && incomingMetadata && transferState === 'PREPARING' && (
                    <div className="flex flex-col gap-4 p-6 rounded-xl bg-purple-500/10 border border-purple-500/20">
                      <h3 className="text-base font-bold text-on-surface m-0 flex items-center gap-2">
                        <span className="material-symbols-outlined text-primary">download</span>
                        Incoming File Transfer Request
                      </h3>
                      <div className="text-sm text-on-surface-variant space-y-1 font-mono">
                        <p className="m-0"><strong>File:</strong> {incomingMetadata.fileName}</p>
                        <p className="m-0"><strong>Size:</strong> {formatSize(incomingMetadata.fileSize)}</p>
                      </div>
                      <div className="flex items-center gap-3 mt-2">
                        <button
                          onClick={handleAcceptFile}
                          id="btn-accept-transfer"
                          className="primary-btn py-2.5 px-6 rounded-xl text-sm flex items-center gap-2"
                        >
                          <span className="material-symbols-outlined text-base">check</span>
                          Accept & Save
                        </button>
                        <button
                          onClick={() => handleCancelTransfer('Rejected by receiver')}
                          className="secondary-btn py-2.5 px-6 rounded-xl text-sm"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Active Transfer Progress Dashboard */}
                  {transferState !== 'IDLE' && transferState !== 'PREPARING' && (
                    <div className="flex flex-col gap-4 p-6 rounded-xl bg-[#09090B]/60 border border-white/10">
                      <div className="flex items-center justify-between">
                        <h3 className="text-base font-bold text-on-surface m-0">Transfer Dashboard</h3>
                        <span className="text-xs font-mono font-bold text-primary">State: <span id="transfer-state-display">{transferState}</span></span>
                      </div>

                      {/* Progress Bar */}
                      <div className="w-full bg-white/5 rounded-full h-3 overflow-hidden p-0.5 border border-white/10">
                        <div
                          id="transfer-progress-bar"
                          className="bg-gradient-to-r from-primary to-secondary h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${incomingMetadata || selectedFile ? Math.round((bytesTransferred / (incomingMetadata?.fileSize || selectedFile?.size || 1)) * 100) : 0}%`
                          }}
                        />
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div className="bg-surface p-3 rounded-lg border border-white/5">
                          <span className="text-gray-500 block text-[10px]">Transferred</span>
                          <span className="font-mono text-on-surface font-semibold">
                            <span id="bytes-transferred-display">{formatSize(bytesTransferred)}</span> / {formatSize(incomingMetadata?.fileSize || selectedFile?.size || 0)}
                          </span>
                        </div>
                        <div className="bg-surface p-3 rounded-lg border border-white/5">
                          <span className="text-gray-500 block text-[10px]">Current Speed</span>
                          <span id="current-speed-display" className="font-mono text-emerald-400 font-semibold">{formatSpeed(transferSpeed)}</span>
                        </div>
                        <div className="bg-surface p-3 rounded-lg border border-white/5">
                          <span className="text-gray-500 block text-[10px]">Average Speed</span>
                          <span id="avg-speed-display" className="font-mono text-cyan-400 font-semibold">{formatSpeed(avgSpeed)}</span>
                        </div>
                        <div className="bg-surface p-3 rounded-lg border border-white/5">
                          <span className="text-gray-500 block text-[10px]">Buffered Amount</span>
                          <span id="buffered-amount-display" className="font-mono text-amber-400 font-semibold">
                            {formatSize(rtcManagerRef.current?.getFileBufferedAmount() || 0)}
                          </span>
                        </div>
                      </div>

                      <div className="text-xs text-on-surface-variant flex flex-wrap gap-4 pt-1">
                        <span>Peak Speed: <strong className="text-purple-300">{formatSpeed(peakSpeed)}</strong></span>
                        <span>Storage Backend: <strong id="storage-backend-display" className="text-purple-300">{storageBackend}</strong></span>
                        {eta !== null && <span>ETA: <strong id="eta-display" className="text-cyan-300">{eta}s</strong></span>}
                      </div>

                      {/* Integrity Verification Card */}
                      {transferState === 'COMPLETED' && (
                        <div className="flex flex-col gap-3 p-4 rounded-xl bg-purple-500/10 border border-purple-500/20 mt-2">
                          <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-base text-cyan-400">verified</span>
                            <span id="integrity-verification-display" className="font-bold text-sm text-cyan-300">
                              Integrity Verification: {integrityMatch === false ? 'Failed' : 'Verified'}
                            </span>
                          </div>
                          {localHash && remoteHash && (
                            <div className="text-[11px] font-mono text-on-surface-variant break-all">
                              <p className="m-0">Local SHA-256: {localHash}</p>
                              <p className="m-0">Remote SHA-256: {remoteHash}</p>
                            </div>
                          )}
                          {downloadUrl && (
                            <a
                              href={downloadUrl}
                              download={incomingMetadata?.fileName || 'downloaded-file'}
                              className="primary-btn py-2.5 px-6 rounded-xl text-xs inline-flex items-center justify-center gap-2 text-center text-white no-underline"
                            >
                              <span className="material-symbols-outlined text-sm">download</span>
                              Download File
                            </a>
                          )}
                          <button
                            onClick={() => {
                              const winObj = window as unknown as Record<string, () => void>;
                              if (winObj.__resetTransfer) winObj.__resetTransfer();
                            }}
                            id="btn-transfer-another"
                            className="primary-btn py-2.5 px-6 rounded-xl text-xs w-full flex items-center justify-center gap-2"
                          >
                            <span className="material-symbols-outlined text-sm">sync</span>
                            Transfer Another File
                          </button>
                        </div>
                      )}

                      {transferState !== 'COMPLETED' && transferState !== 'FAILED' && transferState !== 'CANCELLED' && (
                        <button
                          onClick={() => handleCancelTransfer()}
                          id="btn-cancel-transfer"
                          className="secondary-btn py-2 px-4 rounded-xl text-xs w-fit border-red-500/30 text-red-400 hover:bg-red-500/10"
                        >
                          Cancel Transfer
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* WebRTC Diagnostics */}
              {webrtcState !== 'WEBRTC_IDLE' && (
                <div className="flex flex-col gap-3 p-4 rounded-xl bg-[#09090B] border border-white/5 text-xs text-on-surface-variant">
                  <h4 className="font-bold text-on-surface m-0 text-sm flex items-center gap-2">
                    <span className="material-symbols-outlined text-sm text-primary">find_in_page</span>
                    WebRTC Diagnostics
                  </h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div>WebRTC State: <strong id="webrtc-state-display" className="text-purple-400 block">{webrtcState}</strong></div>
                    <div>DataChannel: <strong id="datachannel-state-display" className="text-emerald-400 block">{dataChannelState}</strong></div>
                    <div>Candidate Pair: <strong id="connection-type-display" className="text-cyan-400 block truncate">{stats?.selectedCandidatePair || 'unknown'}</strong></div>
                    <div>RTT: <strong id="rtt-display" className="text-amber-400 block">{stats?.rtt !== null && stats?.rtt !== undefined ? `${stats.rtt} ms` : (rtt !== null ? `${rtt} ms` : 'unknown')}</strong></div>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-white/5">
                    <button
                      onClick={handleSendPing}
                      disabled={dataChannelState !== 'open'}
                      id="btn-send-ping"
                      className="secondary-btn px-3 py-1.5 rounded-lg text-xs flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-xs">radar</span>
                      Send WebRTC Ping
                    </button>
                    <span>Pings sent: <span id="ping-count">{pingCount}</span> | Pongs received: <span id="pong-count">{pongCount}</span></span>
                  </div>
                </div>
              )}

              <button onClick={handleReset} className="secondary-btn py-2.5 px-6 rounded-xl text-xs w-full" id="btn-reset">
                Cancel / Reset Session
              </button>
            </div>

            {errorMsg && (
              <div id="error-message-display" className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-base">error</span>
                {errorMsg}
              </div>
            )}
          </section>
        )}

        {/* Bento Feature Grid */}
        <section className="w-full py-8">
          <div className="text-center mb-12">
            <h2 className="text-2xl md:text-3xl font-bold font-display text-on-surface m-0">The Next Evolution of P2P Sharing</h2>
            <p className="text-sm text-on-surface-variant mt-2 m-0">Direct device-to-device transport powered by WebRTC and File System Access API.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="glass-panel rounded-2xl p-8 flex flex-col justify-between gap-6 md:col-span-2 border border-white/10 hover:border-primary/40 transition-colors">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-2xl">hub</span>
              </div>
              <div>
                <h3 className="text-xl font-bold font-display text-on-surface mb-2">Direct P2P Connection</h3>
                <p className="text-sm text-on-surface-variant m-0">
                  Files travel directly from your device to the recipient. No intermediate relay servers touch binary byte payloads, providing uncompromised speed and privacy.
                </p>
              </div>
            </div>
            <div className="glass-panel rounded-2xl p-8 flex flex-col justify-between gap-6 border border-white/10 hover:border-secondary/40 transition-colors">
              <div className="w-12 h-12 rounded-xl bg-secondary/10 flex items-center justify-center text-secondary">
                <span className="material-symbols-outlined text-2xl">bolt</span>
              </div>
              <div>
                <h3 className="text-xl font-bold font-display text-on-surface mb-2">Blazing Fast</h3>
                <p className="text-sm text-on-surface-variant m-0">
                  Utilizes native WebRTC DataChannels with adaptive backpressure watermarks for multi-gigabit throughput.
                </p>
              </div>
            </div>
            <div className="glass-panel rounded-2xl p-8 flex flex-col justify-between gap-6 border border-white/10 hover:border-emerald-500/40 transition-colors">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                <span className="material-symbols-outlined text-2xl">lock</span>
              </div>
              <div>
                <h3 className="text-xl font-bold font-display text-on-surface mb-2">Zero Knowledge</h3>
                <p className="text-sm text-on-surface-variant m-0">
                  Streaming SHA-256 Web Worker integrity verification guarantees tamper-proof delivery directly into browser storage.
                </p>
              </div>
            </div>
            <div className="glass-panel rounded-2xl p-8 flex flex-col justify-between gap-6 md:col-span-2 border border-white/10 hover:border-primary/40 transition-colors">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-2xl">devices</span>
              </div>
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                  <h3 className="text-xl font-bold font-display text-on-surface mb-2">Universal Compatibility</h3>
                  <p className="text-sm text-on-surface-variant m-0">
                    Works natively across Windows, macOS, Linux, iOS, and Android Safari/Chrome without installing apps.
                  </p>
                </div>
                <div className="flex gap-4 text-on-surface-variant/40">
                  <span className="material-symbols-outlined text-3xl">computer</span>
                  <span className="material-symbols-outlined text-3xl">smartphone</span>
                  <span className="material-symbols-outlined text-3xl">laptop_mac</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="w-full bg-[#09090B] border-t border-white/5 py-8 mt-auto relative z-10">
        <div className="max-w-7xl mx-auto px-4 md:px-8 flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-on-surface-variant">
          <div>
            <span className="font-bold text-on-surface">LinkDrop</span> — End-to-End Encrypted Zero-Server P2P Protocol.
          </div>
          <div className="flex items-center gap-6">
            <a href="#" className="hover:text-primary transition-colors">Security Protocol</a>
            <a href="#" className="hover:text-primary transition-colors">Privacy</a>
            <a href="/benchmark" className="hover:text-primary transition-colors">Benchmark Engine</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function App() {
  const isBenchmarkRoute = typeof window !== 'undefined' && (window.location.pathname === '/benchmark' || window.location.search.includes('mode=benchmark'));
  if (isBenchmarkRoute) {
    return (
      <>
        <CrystalBackground />
        <BenchmarkPage />
      </>
    );
  }
  return <MainApp />;
}

export default App;
