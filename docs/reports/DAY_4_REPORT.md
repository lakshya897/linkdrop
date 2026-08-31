# Day 4 Engineering Report — WebRTC Direct P2P File Transfer Vertical Slice

## Executive Summary
Day 4 objective was to build and strictly verify a memory-safe, backpressure-managed WebRTC direct P2P file transfer vertical slice. All required features have been implemented and verified locally and via automated integration tests. Zero binary payloads touch the signaling server; all bytes stream directly peer-to-peer over WebRTC data channels with end-to-end SHA-256 integrity verification.

---

## Key Achievements & Implementation Details

### 1. Zero-Relay Protocol Schema (`@linkdrop/protocol`)
- Extended protocol definitions with `FileTransferStartPayloadSchema`, `FileTransferCompletePayloadSchema`, `FileTransferCancelPayloadSchema`, and `FileTransferErrorPayloadSchema`.
- Enforced strict payload validation rules on WebSocket messages.

### 2. High-Performance WebRTC DataChannel Engine (`WebRtcManager`)
- **Dedicated Channels**: Established a dedicated reliable binary `file` DataChannel alongside the control signaling channel.
- **SCTP Transport Constraints**: Tuned chunk sizes to **60 KB** (fitting within SCTP max message bounds and avoiding 256 KB browser limit exceptions).
- **Watermark Backpressure**: Integrated high watermark (**8 MB**) and low watermark (**4 MB**) event-driven pause/resume triggers. The sender loop monitors `rtcManager.getFileBufferedAmount()`, pausing execution until the SCTP buffer drains below the lower watermark.
- **Binary Header Packing**: Each chunk is prepended with a 4-byte big-endian uint32 sequence index (`[index (4B) | chunk payload]`), ensuring deterministic ordered reassembly.

### 3. Progressive File Storage & FSA Stream Fallbacks (`StorageWriter`)
- **FileSystem Access API (`FileSystemAccessWriter`)**: Streams incoming WebRTC binary chunks directly to disk using `createWritable()` streams.
- **IndexedDB Fallback (`IndexedDbWriter`)**: In headless browser environments (like Playwright CI) or unsupported browsers where `showSaveFilePicker` is absent, binary blocks write directly into IndexedDB, returning a Blob Object URL upon completion.

### 4. End-to-End Integrity Verification (`calculateSha256`)
- Full SHA-256 hex checksum generated before transfer on the sender side and transmitted via `FILE_TRANSFER_START`.
- Receiver hashes the assembled disk/IDB payload upon receipt and matches it against the sender's hex checksum, updating UI state to `Integrity Verification: Verified`.

---

## Deep-Dive Analysis of Root Causes Identified & Resolved

During Day 4 implementation & E2E verification, three critical technical challenges were isolated and fixed:

### Issue 1: React State Closure Traps in WebSockets & WebRTC Callbacks
- **Symptom**: `FILE_TRANSFER_COMPLETE` control messages sent with `sessionId: null`, and `bytesTransferred` remaining at 0.
- **Root Cause**: Asynchronous WebSocket event listeners captured transient component state variables (`sessionId`, `incomingMetadata`, `transferState`) at connection setup time, freezing their initial `null` values within callback closures.
- **Fix**: Synchronized state tracking via React `useRef` handles (`sessionIdRef`, `incomingMetadataRef`, `transferStateRef`, `roleRef`). All callback handlers dereference `.current` dynamically to consume active state.

### Issue 2: SCTP Max Message Size Exceeded in Chromium
- **Symptom**: Sender loop threw `TypeError: Failed to execute 'send' on 'RTCDataChannel': Trying to send message larger than max-message-size`.
- **Root Cause**: Initial chunk size of 256 KB + 4-byte header exceeded Chromium's strict 262,144 byte DataChannel SCTP message limit.
- **Fix**: Standardized `WebRtcManager.CHUNK_SIZE` to 60 KB (~61,444 bytes total frame size), safely within cross-browser SCTP message boundaries.

### Issue 3: Event Loop Starvation & WebSocket Heartbeat Timeouts
- **Symptom**: Long transfers (e.g. 250 MB synthetic files) triggered `SESSION_ERROR` and peer disconnects at ~70 MB.
- **Root Cause**: Microtask chain in the sender's file-slicing loop (`file.slice().arrayBuffer()`) monopolized the main JavaScript thread, blocking macrotask execution (preventing WebSocket PING/PONG message processing). The signaling server's 10-second heartbeat check flagged missed PONG responses and terminated the connection.
- **Fix**:
  1. Inserted periodic macrotask yields (`await new Promise(r => setTimeout(r, 0))`) in the sender slicing loop every 256 chunks.
  2. Increased signaling server heartbeat tolerance to allow up to 3 missed PONG cycles (30s) before peer termination.
  3. Added `isSendingRef.current = false` inside `PEER_LEFT` disconnect handlers to halt sender loops immediately if a peer leaves mid-transfer.

---

## Verification Summary

- **Unit Tests (`vitest`)**: Passed (`tests/fileTransfer.test.ts` verifying binary header packing/unpacking and watermark thresholds).
- **TypeScript & Lint**: Passed clean across all workspace packages with zero warnings.
- **Production Build**: Verified (`pnpm build`).

---
*End of Day 4 Engineering Report.*
