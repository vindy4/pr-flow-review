# macOS Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship PR Flow Review as a self-contained Electron macOS application with a reproducible DMG build and a signed release path.

**Architecture:** Keep React and Python. Electron serves a stable app origin, proxies authenticated loopback requests, manages a frozen Python subprocess and GitHub CLI authentication, and retains user state outside the bundle.

**Tech Stack:** Electron, electron-builder, React/Vite, Python/PyInstaller, bundled Git and patched GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-11-03-macos-desktop-design.md` (approved by user).

## Global Constraints

- No developer tools required on the recipient's machine; separate arm64/x64 builds.
- Target macOS 13+, confirming the selected dependencies support it.
- Keep browser mode and all existing review semantics; only explicit submission posts comments.
- Local data persists outside the app; no tokens in renderer or logs.
- Unsigned development builds and signed/notarized distribution builds are distinct.
- Do not publish, change user's global Git configuration, or post test comments to real PRs.
- No signing credentials are available; report release validation that cannot be performed.

## Review Focus

- Finder's minimal PATH and installed paths with spaces must not require Homebrew at runtime.
- Port changes/app replacement must not lose drafts, progress, or ambiguous submission receipts.
- Login errors, cancellation and Keychain failures must preserve existing credentials.
- Quit during Git/login work must terminate owned descendants without signaling other processes.
- Hostile navigation, protocol traversal and foreign IPC must not gain backend access.

## Execution record

Implementation is authorized by the user's "yes build it". Execute inline without another plan-approval pause. The project has no standalone Git history and the parent repo has no commits; record progress in `.cache/desktop-work/progress.md`, leave files in place, and do not commit unrelated parent data.

### Task 1: Configurable backend runtime and authenticated desktop server

**Files:** `backend/runtime.py`, `backend/github.py`, `backend/files.py`, `backend/reviews.py`, `backend/server.py`, `tests/test_desktop_runtime.py`.

**Interfaces:** runtime paths resolve `PR_FLOW_DATA_DIR`, `PR_FLOW_CACHE_DIR`, `PR_FLOW_RESOURCE_DIR`; `make_handler(jobs, reviews=None, api_secret=None)` preserves browser defaults; `--desktop --port 0` emits JSON readiness.

- [x] Write failing tests for path separation, persistent receipts/descriptors, secret enforcement, origin preservation, and desktop checkout discovery.
- [x] Run `uv run python -m unittest discover -s tests -p 'test_desktop_runtime.py'`; confirm failures.
- [x] Implement runtime configuration and secret gate, suppress desktop sensitive traceback output, preserve all existing browser-mode boundaries.
- [x] Run the focused tests and Python suite; expected all pass.

### Task 2: Electron protocol, process manager and native capabilities

**Files:** `desktop/main.cjs`, `desktop/preload.cjs`, `desktop/protocol.cjs`, `desktop/backend.cjs`, `desktop/auth.cjs`, `desktop/security.cjs`, `desktop/startup.html`, `tests/desktop/*.test.cjs`.

**Interfaces:** app origin `app://flow-review`; backend controller `start()/stop()` exposes private `{port, secret}` to main only; preload `window.desktop` exposes auth status/start/cancel, folder selection, diagnostics, retry, status subscription.

- [x] Write failing Node tests for protocol path/route/method validation, traversal including encoded paths and symlinks, sender validation, readiness, lifecycle, environment sanitation, auth output parsing and failure/cancel cleanup.
- [x] Run `node --test tests/desktop/*.test.cjs`; confirm failures.
- [x] Implement secure protocol routing, narrow IPC, bounded backend startup, detached process groups, single-instance behavior, startup/retry and navigation controls.
- [x] Implement login with the bundled fail-closed CLI, finite timeout, device-code UI events and no renderer token access.
- [x] Run Node tests; expected all pass. Smoke-launch Electron against the real backend.

### Task 3: Desktop-aware frontend

**Files:** `frontend/DesktopSetup.tsx`, `frontend/desktop.ts`, `frontend/App.tsx`, `frontend/desktop.css`, desktop browser tests.

**Interfaces:** typed optional `window.desktop`; desktop mode uses blank initial PR input and folder picker; browser mode retains existing initial value and manual path.

- [x] Write failing integration checks for login states, cancellation/retry, folder picker and persistent state under the stable origin.
- [x] Implement desktop sign-in/setup controls and actionable status; keep credentials outside React.
- [x] Build frontend and run desktop UI checks; expected no console failures and state survives relaunch.

### Task 4: Bundled runtimes, application and DMG

**Files:** `scripts/desktop/*`, `desktop/backend-entry.py`, `desktop/entitlements.mac.plist`, `electron-builder.config.cjs`, `package.json`, lockfiles, `pyproject.toml`, `.gitignore`.

**Interfaces:** `npm run desktop:dev`, `npm run desktop:build`, `npm run desktop:release`; architecture-specific staging under `.cache/desktop-runtime/<arch>`; artifacts under `release/`.

- [x] Add failing build validation tests for missing runtime files, foreign architecture, missing release credentials and development/release distinction.
- [x] Pin dependencies; freeze Python, collect native parser libraries; stage self-contained Git with non-system libraries and helper tools; build pinned patched gh with Keychain fallback disabled.
- [x] Record source versions/checksums/notices and build metadata, create the app icon, configure Electron resources, signed release gating and notarization/stapling.
- [x] Build the native-architecture unsigned app/DMG; expected artifacts exist and installed backend parsing, CLI auth check and bundled Git work without developer PATH.
- [x] Verify release mode fails clearly without signing credentials. Do not claim x64/native release checks without matching hardware/runner.

### Task 5: End-to-end verification, review and delivery

**Files:** `tests/desktop/smoke.cjs`, `docs/macos.md`, `README.md`, QA record.

- [x] Exercise installed app startup/relaunch, native dependency reads, storage persistence, hostile navigation, restart and quit during work; test login UI using fixtures without changing user credentials.
- [x] Run Python suite, Node suite, frontend build and relevant browser regressions; record command results and environment limits.
- [x] Have a fresh reviewer inspect all desktop/shared changes against the spec and Review Focus; fix material findings with regression tests.
- [x] Document install/build/release steps and exact unverified signing, clean-machine and Intel checks; deliver the actual local app/DMG paths.

## Verification status

All implementation steps are complete for the available Apple Silicon environment. See `docs/qa-macos.md` for verification evidence and external release checks. Signed distribution, Intel/macOS 13 execution, clean-account Gatekeeper installation, and a successful new interactive OAuth login remain unverified. The user confirmed there is no Apple signing setup yet. No artifacts were published or real reviews posted.
