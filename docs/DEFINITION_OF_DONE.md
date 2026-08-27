# Definition of Done (DoD)

A task in LinkDrop is NOT complete merely because code has been written and compiles. To ensure code quality and stability, we define the criteria for task completion below.

## 1. Code Quality & Compilation

- **Compilation:** The TypeScript project compiles without errors. Strict mode checks (`strict: true`) must pass.
- **No `any` Types:** All variables, parameters, and return types must be explicitly typed.
- **Linting:** ESLint (or equivalent linter) passes with zero errors and zero warnings.
- **Code Review:** The code has been reviewed and approved by at least one other engineer.

---

## 2. Test Coverage & Verification

- **Unit Tests:** Unit tests exist for new logic, utility functions, and protocol message parsers.
- **E2E Validation:** For features altering network, storage, or protocol flows, E2E tests are updated or added.
- **Test Execution:** All tests in the test suite pass.
- **Multi-Device Verification:** The UI changes are verified on both desktop and mobile viewports.

---

## 3. Operations & Safety

- **No Mock Code:** Production code must not contain mocked or stubbed functions.
- **No Insecure Headers:** Web application configurations must enforce Content Security Policy (CSP) guidelines.
- **No Exposed Secrets:** Credentials, private keys, or certificates must not be committed to the repository.

---

## 4. Documentation

- **API & Protocol Docs:** If the transfer protocol is updated, `docs/TRANSFER_PROTOCOL.md` must be updated.
- **Changelog:** The pull request description must summarize the changes and list any modifications to configuration files or dependencies.
- **Walkthrough Update:** The `walkthrough.md` file is updated to reflect new functionality and include screenshots/recordings of any UI modifications.
