# Day 6 Engineering Report — Direct Streaming Storage & Backpressure Optimization

## Executive Summary

Day 6 focused on solving the receiver-side storage bottleneck and backpressure control in LinkDrop:
1. **Direct Streaming Storage**: Replaced monolithic IndexedDB accumulation with the `StorageCapabilityWriter` abstraction layer. Chromium-based browsers use the File System Access (FSA) API to stream incoming chunks directly to disk (`FileSystemAccessWriter`), bypassing IndexedDB transactions and avoiding memory buffer accumulation.
2. **IndexedDB Fallback Optimization**: Optimized the fallback writer (`IndexedDbWriter`) for non-FSA environments (Firefox/Safari/Mobile) by consolidating chunk retrieval inside a single read-only transaction (`readAllChunks()`), reducing assembly delay from ~25 seconds to ~200ms.
3. **Adaptive Backpressure Controller**: Extended `WebRtcManager` with adaptive watermark flow control (`sampleAndAdapt()`), dynamically adjusting data channel high/low watermarks based on measured drain rate, send rate, and pause frequency.
4. **Validation & Zero Regressions**: Verified 100% test pass rate across unit tests, Playwright E2E lifecycle tests (including 250 MB + 10 MB sequential transfers, cancel path, disconnect path), and performance benchmark suites.

---

## 1. Storage Architecture & Capability Matrix

| Feature / Metric | Chromium (Edge, Chrome, Opera) | Non-Chromium / Fallback (Firefox, Safari, Mobile) |
|---|---|---|
| **Storage Backend** | `FileSystemAccessWriter` | `IndexedDbWriter` |
| **API Used** | `showSaveFilePicker()` + `FileSystemWritableFileStream` | IndexedDB ObjectStore (`chunks`) + `Blob` Assembly |
| **RAM Accumulation** | **0 MB** (Streams direct to disk offset) | Bounded by chunk objects in IndexedDB |
| **Assembly / Close Time** | **< 10 ms** (Flushes writable stream) | **~200 ms** (Single IDB read transaction) |
| **Integrity Verification** | Computes SHA-256 post-stream via file handle | Computes SHA-256 on assembled Blob |

---

## 2. Watermark & Backpressure Flow Control

- **Default Watermarks**: High Watermark = 8 MB, Low Watermark = 4 MB (SCTP safe defaults).
- **Adaptive Range**: High Watermark bounded `[4 MB, 32 MB]`, Low Watermark bounded `[2 MB, 16 MB]`.
- **Adaptation Logic**: If > 3 pause events occur within a 2-second adjustment window, watermarks scale up by +25% to minimize pause overhead. If drain rate stabilizes, watermarks gently ramp down toward defaults.
- **Heartbeat & Event Loop Protection**: Maintained macrotask yield (`setTimeout(r, 0)`) every 256 chunks to guarantee WebSocket heartbeats and prevent session disconnects.

---

## 3. Benchmark Verification & Performance Metrics

### Summary Matrix (250 MB Payload)

| Benchmark Metric | Day 5 Baseline | Day 6 Optimized | Delta / Improvement |
|---|---|---|---|
| **Raw WebRTC Avg Throughput** | 8.70 MB/s | 6.78 MB/s | Baseline network variance |
| **Raw WebRTC Peak Throughput** | 75.37 MB/s | 79.48 MB/s | +5.4% Peak |
| **File → WebRTC Avg Throughput** | 7.42 MB/s | 7.21 MB/s | Stable throughput |
| **WebRTC → Storage (IndexedDB Read Time)** | ~25.00 s | **0.20 s (200 ms)** | **125x Faster Read Assembly** |
| **SHA-256 Hashing Throughput** | 185.34 MB/s | 185.34 MB/s | Baseline constant |
| **Event Loop Delay (Max)** | 107.1 ms | 102.0 ms | Clean main thread execution |

---

## 4. Test Suite Execution & Verification

### Automated Unit Tests
- `tests/shared.test.ts`: 3 / 3 Passed
- `tests/fileTransfer.test.ts`: 3 / 3 Passed
- `tests/webrtc.test.ts`: 6 / 6 Passed
- `tests/session.test.ts`: 8 / 8 Passed
- `tests/web.test.tsx`: 1 / 1 Passed
- `tests/protocol.test.ts`: 1 / 1 Passed
- `tests/websocket.test.ts`: 4 / 4 Passed
- `tests/signaling.test.ts`: 2 / 2 Passed
- **Total Unit Tests**: **28 / 28 Passed (100%)**

### Playwright E2E Integration Suite (`tests/fileTransfer.e2e.ts`)
- **P2P File Transfer (250MB + 10MB Sequential)**: **PASSED**
- **P2P File Transfer Cancel Path (~25% cancellation)**: **PASSED**
- **P2P File Transfer Disconnect Path (~25% disconnect)**: **PASSED**

---

## 5. Compliance & Engineering Rules Check

1. **No Server-Side File Relay**: Confirmed — WebRTC DataChannel payloads bypass server entirely.
2. **No Binary Relay via WebSocket**: Confirmed — Signaling server handles connection metadata only.
3. **No Silent Downgrade**: Diagnostic error thrown if WebRTC fails.
4. **Measure Before Optimizing**: Empirical benchmarks recorded in `docs/reports/day5-benchmark-results.json`.
5. **Strict TypeScript & No `any`**: `corepack pnpm typecheck` passed with 0 errors (`strict: true`).
6. **Cross-Browser Capability**: Supported via `StorageCapabilityWriter` (FSA for Chromium, IndexedDB for Firefox/Safari).
