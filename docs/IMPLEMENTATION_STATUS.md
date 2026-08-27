# Implementation Status & Roadmap

This document tracks the active implementation status of the LinkDrop platform.

## 1. Feature Implementation Matrix

| Component | Status | Details |
| :--- | :--- | :--- |
| **Foundation** | **IMPLEMENTED** | Monorepo structure, pnpm workspaces, TS strict compiler configurations, Prettier, ESLint flat configuration, and Vitest. |
| **Web application** | **FOUNDATION ONLY** | Vite + React application setup with render smoke tests. No transfer UI implemented. |
| **Signaling** | **HEALTH ENDPOINT ONLY** | Fastify + Node server. Ephemeral endpoints setup. `/health` active. WebSocket connections not implemented. |
| **Protocol** | **FOUNDATION ONLY** | `@linkdrop/protocol` workspace package exporting `PROTOCOL_VERSION = 1`. No schemas implemented. |
| **WebRTC** | **NOT IMPLEMENTED** | Direct browser connectivity not started. |
| **File transfer** | **NOT IMPLEMENTED** | Chunk splitting and DataChannel streaming not started. |
| **TURN** | **NOT IMPLEMENTED** | Relay infrastructure not started. |
| **Redis** | **NOT IMPLEMENTED** | Ephemeral memory cache connection not started. |
| **BLAKE3** | **NOT IMPLEMENTED** | WebAssembly integrity calculations not started. |
| **Resume** | **NOT IMPLEMENTED** | Reconnection checkpoints not started. |
| **3D UI** | **NOT IMPLEMENTED** | 3D rendering not started. |

---

## 2. Monorepo Directory Structure Verification

```
linkdrop/
│
├── apps/
│   ├── web/           (React SPA Vite Client)
│   └── signaling/     (Fastify Node Signaling Server)
│
├── packages/
│   ├── protocol/      (Shared protocol specifications)
│   ├── shared/        (Shared error primitives)
│   └── config/        (Shared configurations)
│
├── docs/
│   └── reports/       (Architecture & phase reports)
│
├── tests/             (Root Vitest E2E/Integration/Unit)
│
├── package.json       (Root workspace runners)
├── pnpm-workspace.yaml
├── tsconfig.base.json (Strict tsconfig base)
├── eslint.config.js   (ESLint configuration rules)
├── .prettierrc
└── README.md
```

---

## 3. Exit Criteria - Phase 0 (Foundation)
*   [x] Monorepo workspace configuration setup.
*   [x] Root-level typecheck, build, and formatting tasks configured.
*   [x] Strict TypeScript configuration enabled.
*   [x] Web client rendering smoke test passing.
*   [x] Signaling health server returning HTTP 200 on `/health`.
*   [x] Protocol package version exported correctly.
*   [x] Clean installation and resolution check verified.
