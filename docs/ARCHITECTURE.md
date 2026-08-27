# System Architecture Blueprint

This document defines the technical architecture of LinkDrop, detailing memory boundaries, storage pipelines, data channels, and reconnection constraints.

## 1. High-Level System Components

```
                    LINKDROP SYSTEM TOPOLOGY
                               |
        +----------------------+----------------------+
        |                                             |
   WEB CLIENT (React Client SPA)            SIGNALING NODE (Fastify)
        |                                             |
        | <========== HTTPS / WebSocket ============> | (SDP / ICE Metadata Only)
        |                                             |
   RTCPeerConnection (WebRTC)                      Redis (Ephemeral State)
        |
        +-----------------+-----------------+
        |                                   |
  (Direct P2P Link)                (Relayed Fallback)
    LAN/WAN Route                     TURN Server
        |                                   |
        +-----------------+-----------------+
                          |
             SCTP DataChannel (Ordered & Reliable)
                          |
                   Transfer Engine
                          |
             +------------+------------+
             |                         |
          Chunking                  Storage
       (Worker Thread)       (Capability-Based API)
```

### Protocol & Infrastructure Boundaries:

- **Signaling Server:** Relays Session Description Protocol (SDP) offers, answers, and ICE candidates. **File bytes must NOT be relayed through the signaling WebSocket.**
- **TURN Server:** Core relay infrastructure deployed separately. Used to relay encrypted WebRTC packet streams only when firewalls or NAT configurations block direct P2P connections.
- **Redis State Cache:** Ephemeral database on the backend managing short-lived session states, join-token resolution, and rate-limiting counters.

---

## 2. Memory Boundaries & Buffering Strategy

> [!IMPORTANT]
> **LinkDrop must never load an entire large file into JavaScript memory. Application-managed transfer buffering must remain bounded through chunk streaming, backpressure, and supported streaming storage APIs. Browser/WebRTC internal memory is outside the application's direct control.**

The system isolates memory allocations across four distinct tiers:

1.  **Application-managed Buffers:** Slices of the file read by the JavaScript engine (limited to 32 KiB chunk sizes). Written immediately to disk or storage APIs.
2.  **Browser-managed Buffers:** Heap memory allocated by the browser engine for DOM operations and event loops. Keep allocations flat using Garbage Collection-friendly ArrayBuffers.
3.  **WebRTC/SCTP Internal Buffers:** Memory managed by the browser's WebRTC protocol stack for network transmission, controlled using the `bufferedAmount` API.
4.  **OS/Filesystem Buffers:** Disk cache memory managed by the host operating system.

---

## 3. WebRTC Data Channel Configuration

The application establishes a single, reliable `RTCDataChannel` configured as follows:

```typescript
const dataChannelConfig: RTCDataChannelInit = {
  ordered: true, // Guarantees sequential packet arrival
  maxRetransmits: undefined, // Enforces reliable delivery (SCTP retransmission)
  maxPacketLifeTime: undefined,
};
```

### Rules:

- **No Multi-Channel Complexity:** The MVP uses a single data channel to prioritize correctness and compatibility over theoretical multi-channel scheduling optimizations.
- **Packet Slicing:** Outgoing file streams are sliced into **32 KiB configurable chunks** before transmitting over the channel to prevent buffer fragmentation issues in standard browser engines.

---

## 4. Backpressure Control Algorithm

To prevent unbounded memory consumption within the WebRTC internal buffer, the application implements backpressure:

- **HIGH_WATER_MARK:** 4 MiB (`4 * 1024 * 1024` bytes).
- **LOW_WATER_MARK:** 1 MiB (`1 * 1024 * 1024` bytes).

### Send Loop Behavior:

1.  Sender Worker reads a 32 KiB chunk.
2.  Checks `RTCDataChannel.bufferedAmount`.
3.  If `bufferedAmount > HIGH_WATER_MARK`, the sender halts reading and sending.
4.  Waits for the browser to emit the `onbufferedamountlow` event (triggered when buffer falls below `LOW_WATER_MARK`).
5.  Resumes reading and sending chunks.

---

## 5. Capability-Based Storage Strategy

Browsers cannot write directly to arbitrary paths on the user's filesystem. LinkDrop uses progressive capability detection to determine how to save incoming files:

1.  **Receiver Receives Chunk:** Arrives over the WebRTC data channel in order.
2.  **Capability-Based Write:**
    - _File System Access API:_ If supported, streams chunks directly to the user-selected folder.
    - _Origin Private File System (OPFS):_ Fallback for browsers (like Firefox and Safari) that do not support the File System Access API. Chunks are appended to an internal virtual file.
    - _Memory/IndexedDB Fallback:_ Smaller-file fallback where native streaming APIs are unavailable.
3.  **Track Progress & Finalize:** Check off chunk indexes and verify integrity.
4.  **Save/Download Trigger:** Once verified, trigger a browser-native download/save dialog to move the file to the host system.
5.  **Failure Check:** If capability detection confirms that the browser cannot reliably store files of the requested size, the transfer is **failed before it begins** with a clear explanation.

---

## 6. Connection Recovery (Reconnection Rules)

The MVP implements recovery under strict boundaries:

- **Tabs Must Remain Open:** Reconnection is supported only if both the sender's and receiver's browser tabs remain open. The application does **not** support resuming transfers after a browser crash, reload, or tab closure.
- **Recovery Lifecycle:**
  1.  _Loss Detection:_ Monitor WebRTC connection state changes to `disconnected` or `failed`.
  2.  _Freeze:_ Freeze the transfer state machine (no reading, no sending, UI shows "Reconnecting").
  3.  _Signaling renegotiation:_ Initiate WebSocket handshake and exchange new ICE candidates to restore connection.
  4.  _Resume:_ Resume transmission from the last contiguous chunk index acknowledged by the receiver before the drop.
  5.  _Timeout:_ If the connection cannot be restored within 30 seconds, fail the transfer safely and clean up state.
