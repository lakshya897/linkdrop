# LinkDrop

LinkDrop is a privacy-first, cross-platform file handoff service that allows two people to transfer files directly between devices with zero setup, zero configuration, no account creation, and no native app installation.

> [!NOTE]
> **DAY 1 FOUNDATION ONLY.** No file-transfer engine, WebRTC connectivity, or final UI has been implemented yet.

## 1. Monorepo Directory Structure

```
linkdrop/
│
├── apps/
│   ├── web/           (React + TypeScript + Vite)
│   └── signaling/     (Fastify + Node.js)
│
├── packages/
│   ├── protocol/      (TypeScript - Shared messages)
│   ├── shared/        (TypeScript - Error model)
│   └── config/        (TypeScript - Configurations)
│
├── docs/              (Technical specs & reports)
├── tests/             (Vitest unit/integration suite)
│
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── eslint.config.js
```

## 2. Local Development Commands

To manage and develop the platform, use the following workspace commands from the repository root:

*   **Install Dependencies:**
    `corepack pnpm install`
*   **Compile All Workspace Targets:**
    `corepack pnpm build`
*   **Run Web Client Development Server:**
    `corepack pnpm dev:web`
*   **Run Signaling Server Development Server:**
    `corepack pnpm dev:signaling`
*   **Run Strict TypeScript Typecheck Checkers:**
    `corepack pnpm typecheck`
*   **Run Linter (ESLint):**
    `corepack pnpm lint`
*   **Run Vitest Test Suite:**
    `corepack pnpm test`
*   **Format Codebase (Prettier):**
    `corepack pnpm format`
*   **Check Formats (Prettier):**
    `corepack pnpm format:check`
