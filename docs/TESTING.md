# Testing Strategy & Test Matrix

This document defines the testing strategy, execution matrices, and browser compatibility configurations for LinkDrop.

## 1. Test Levels

LinkDrop implements a multi-tiered testing strategy:

### Unit Tests (Vitest)

- **Target:** Protocol parser functions, token generation, state machines, sequence verification, and error code maps.
- **Command:** `npm run test:unit`

### Integration Tests (Vitest)

- **Target:** Session creation flow, Redis token resolution, rate limit triggers, and WebSocket signaling relays.
- **Command:** `npm run test:integration`

### End-to-End Tests (Playwright)

- **Target:** Browser-to-browser file transfer, connection renegotiation, and TURN fallback paths.
- **Execution:** Spawns two separate, isolated browser contexts (Sender and Receiver) in a single E2E script.
- **Command:** `npm run test:e2e`

---

## 2. Browser Verification Matrix

Testing prioritizes mobile and cross-ecosystem transfers:

### P0 Priority Matrix (Must Pass)

- **Android Chrome** $\rightarrow$ **iPhone Safari** (Testing on same Wi-Fi)
- **Android Chrome** $\rightarrow$ **iPhone Safari** (Testing on different networks)
- **Android Chrome** $\rightarrow$ **Android Chrome**

### P1 Priority Matrix

- **iPhone Safari** $\rightarrow$ **Android Chrome**
- **Windows Chrome/Edge** $\rightarrow$ **Android Chrome**
- **Android Chrome** $\rightarrow$ **Windows Chrome/Edge**
- **macOS Chrome/Safari** $\rightarrow$ **Android Chrome**

---

## 3. Network Conditions Test Matrix

To verify transfer stability, tests must succeed under simulated and real-world network conditions:

| Network Profile       | Latency (RTT) | Packet Loss | Target Connection | Verification Goal                               |
| :-------------------- | :------------ | :---------- | :---------------- | :---------------------------------------------- |
| **Local LAN / Wi-Fi** | < 5ms         | 0.0%        | Direct Host-Host  | Baseline maximum transfer throughput.           |
| **Mobile 4G/5G**      | 30 - 80ms     | 0.5%        | STUN Reflexive    | Bounded buffering and throughput stability.     |
| **Symmetric NAT**     | 50ms          | 1.0%        | TURN Relay        | Verify relay routing and TURN allocation.       |
| **Restrictive / VPN** | 100ms         | 2.0%        | TURN Relay        | Verify reconnect performance after brief drops. |

---

## 4. File Sizes Test Matrix

We test files of various sizes up to the MVP limit:

- **1 KB / 1 MB:** Verifies quick session setup and immediate transfer termination.
- **10 MB / 100 MB:** Verifies standard media handoff scenarios.
- **500 MB / 1 GB:** Verifies backpressure mechanisms and memory stability.
- **2 GB (MVP Guest Limit):** Verifies streaming storage reassembly and quota enforcement. Files exceeding 2 GB must be rejected before transfer.
