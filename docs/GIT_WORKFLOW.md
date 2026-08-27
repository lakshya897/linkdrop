# Git Workflow Strategy

This document outlines the branching model, commit standards, and release management rules for LinkDrop.

## 1. Branching Model

LinkDrop follows a structured branching strategy to maintain stability:

```
[ main ]  ======================== (Production Releases)
    ^
    | (Merge Pull Request - Squash Only)
[ develop ]  ===================== (Integration Branch)
    ^
    | (Feature Branching)
  +---+--------------------+
  |                        |
[ feat/webrtc ]       [ fix/resume-index ]
```

- **`main`:** Contains production-ready code. Commits here are tagged with version numbers (e.g., `v1.0.0`).
- **`develop`:** The main development integration branch. Feature branches are merged here.
- **Feature Branches (`feat/*`, `fix/*`, `perf/*`, `test/*`):** Temporary branches used for isolated development. They are squashed and merged into `develop` once tests pass.

---

## 2. Commit Message Standards

Commit messages must follow the Conventional Commits specification:

```
<type>(<scope>): <short description>

[Optional Body]
```

### Commit Types:

- **`feat`:** A new user-facing feature.
- **`fix`:** A bug fix.
- **`perf`:** Code changes that improve performance.
- **`test`:** Adding or correcting tests.
- **`refactor`:** Code changes that do not fix bugs or add features.
- **`docs`:** Documentation changes.
- **`chore`:** Build process updates, dependency changes, or auxiliary tool updates.

### Examples:

- `feat(protocol): add TRANSFER_RESUME schema validation`
- `fix(engine): resolve memory leak during block write operations`
- `perf(wasm): compile BLAKE3 package to WASM target`
- `test(e2e): add disconnect and reconnect E2E test cases`

---

## 3. Pull Requests & Code Reviews

Before code is merged into `develop` or `main`, it must meet these requirements:

1.  **Build Check:** The application build must complete successfully without errors.
2.  **Lint Check:** Code must pass linting and type checks with zero errors.
3.  **Test Coverage:** All unit, integration, and E2E tests must pass.
4.  **Review Approval:** Every pull request requires approval from at least one core engineer.
5.  **Squash Merging:** Commits are squashed on merge to keep a clean history.
