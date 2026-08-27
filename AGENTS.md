# LinkDrop AI Engineering Rules

As an AI coding assistant (Antigravity), you must strictly follow these engineering rules and constraints throughout the implementation of the LinkDrop platform:

## 1. Code Integrity & Functional Safety

1.  **Never modify unrelated functionality:** Keep edits localized to the target feature or bug fix context.
2.  **Never delete working functionality without explicit justification:** Retain existing, functioning features unless refactoring is explicitly approved.
3.  **Never claim a feature works without testing it:** Verify code changes through automated unit, integration, or E2E tests before declaring completion.
4.  **Never introduce unnecessary dependencies:** Maintain a minimal dependency footprint; evaluate native browser APIs before installing external libraries.
5.  **Strict TypeScript Mode:** Compile configurations must use strict settings (`strict: true`, `noImplicitAny: true`, `noUnusedLocals: true`).
6.  **Avoid `any`:** Do not use `any` in application or protocol typing. All received network or disk data must use strict type assertion guards.

## 2. Transfer Protocol Rules

7.  **No Server-Side File Relay:** File bytes must never touch LinkDrop application servers during direct P2P transfers.
8.  **No Binary Relay via WebSocket:** The signaling server must only handle connection metadata. Never route binary file payloads through WebSocket connections.
9.  **Never silently downgrade to server-side relay:** If WebRTC connection fails (even after TURN relay attempts), raise a clear diagnostic error in the UI.

## 3. Optimization & Telemetry Integrity

10. **Measure before optimizing:** Never optimize parameters (chunk size, data channel count, window size) based on assumptions. Perform baselines, measure performance, and compare results before committing changes.
11. **Never fabricate telemetry:** Real-time throughput indicators, RTT, buffer stats, and bottleneck diagnoses must represent real measured values retrieved via browser APIs.

## 4. UI/UX & Compatibility

12. **Keep UI responsive:** Heavy computation (hashing, chunking, file reads) must be offloaded to Web Workers to keep input latency low and prevent browser-tab freezes.
13. **Responsive Viewport Support:** The user interface must be fully optimized for mobile (Android/iOS Safari) and desktop browsers.
14. **Cross-Browser Compatibility:** Support native file storage fallbacks (OPFS/IndexedDB) to maintain compatibility with Chrome, Firefox, and Safari.
