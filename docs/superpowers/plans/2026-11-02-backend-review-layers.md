# Backend review layers implementation plan

> **For agentic workers:** Use test-driven development and verify the integrated backend and browser behavior before completion.

**Goal:** Give Python/backend reviews the eight layers approved in chat, while retaining existing webapp layers and file-first navigation.

**Architecture:** Add a conservative backend classifier using source syntax and directory conventions. Feed its primary layer, secondary responsibilities, and source evidence into the existing architecture contract. Existing graph rendering already hides empty layers; order the inventory using the same layer order.

**Tech Stack:** Python stdlib AST, existing analyzer, React/TypeScript, unittest, Node tests, Playwright browser regression.

**Spec:** The eight-layer proposal approved immediately before this implementation: APIs & routing; Authorization; Business logic & rules; Data & persistence; Jobs & workflows; Integrations & delivery; Reporting & projections; Operations & migrations. Supporting tests/docs remain separate.

## Global constraints

- No new dependencies, GitHub review writes, or changes to analyzed repositories.
- This project is untracked inside an unrelated parent repository. Work in place; do not commit, stage, or create a worktree from the parent repository.
- Preserve webapp classification, Before/After file snapshots, current-only graphs, draft anchors, and viewed progress.
- Countries/providers are not layers. A layer does not prove that a side effect executes.
- Backend layer IDs: `backend_api`, `backend_auth`, `backend_logic`, `backend_data`, `backend_async`, `backend_integrations`, `backend_reporting`, `backend_operations`.

## Review focus

- Mixed JS/Python analyses retain both layer profiles without reclassifying frontend API clients.
- Source signals distinguish outbox services and external-facing repositories; comments/strings do not create responsibilities.
- Moved/removed files retain side-specific classification; excluded files get honest path-only classification.
- Generic Python remains unclassified rather than all becoming Services; supporting artifacts stay supporting.
- Existing cached analyses must not mask the new model after reanalysis.

### Task 1: Backend responsibility classification

**Files:** Create `backend/backend_layers.py`, `tests/test_backend_layers.py`.

**Interfaces:** Export `BACKEND_LAYERS` (the eight layer dictionaries) and `classify_backend(path, source=None)` returning `None` for non-backend input or `{layer, reason, roles, facts}`. Facts follow the existing architecture evidence contract. Missing source permits path-only classification; Python syntax is never executed.

- [x] Write and run failing tests for primary responsibilities, secondary evidence, naming exceptions, supporting files, and false signals.
- [x] Implement conservative classification; verify the focused tests.

### Task 2: Architecture, inventory, and review flow

**Files:** Modify `backend/architecture.py`, `backend/github.py`, `frontend/FileInventory.tsx`, `frontend/architecture.ts`, `README.md`; add `tests/test_backend_architecture.py`, `tests/browser/backend-layers.cjs`, and focused frontend regression tests as needed.

**Interfaces:** Consume Task 1 exports. Preserve existing architecture JSON shape. Backend direct-call relation IDs: `checks_permission`, `calls_data_access`, `calls_job`, `calls_integration`, `calls_report`, `calls_operation`; business calls retain `calls_service`; unknown calls retain `calls`. These labels describe resolved direct calls and do not claim enqueue/event dispatch.

- [x] Write and observe failing integration tests for all eight layers, mixed languages, side-specific classification, excluded files, and resolved edge semantics.
- [x] Wire classifier metadata into Python snapshots and path-only files, include the backend layer definitions, and invalidate the previous analysis cache generation.
- [x] Use architectural order in Group by layer and add readable connection labels/inverse labels without changing webapp behavior.
- [x] Add a browser regression using real analyzer output for backend layer headings, inventory grouping, current-file focus, and supporting artifacts.
- [x] Run the full Python and Node suites, production build, backend browser regression, and existing workspace/search/carry-forward regressions.
- [x] Inspect the rendered backend graph, obtain a scoped independent review, restart the local backend if needed, and report the refresh/reanalysis step.

## Verification results

- Full Python suite: 143 passing tests; full Node suite: 60 passing tests; production TypeScript/Vite build succeeds.
- Browser regressions: backend layers (6 checks), review workspace (13), reader search (7), draft carry-forward (6). No live review submissions.
- Inspected `.cache/backend-layers/permissions-relationships.png`; populated backend lanes render without card overlap.
- Independent review found one scoped-rename issue: a move indexed on only one side lost its other snapshot. Added a regression that failed in both directions, then fixed path-only completion while preserving parsed metadata. All 26 focused backend tests pass.
- Validated all 12 changed files at PR 615848's pinned base/head and 22 broader pension files. Expected primary responsibilities are preserved with downstream syntax recorded as secondary evidence.
- Restarted the existing local app backend on port 8765 with the updated classifier and cache generation.
- Live reanalysis of GitHub PR 615848 completed successfully after restart: 662 indexed files, all eight backend layers populated, no analysis limit. Its 13 changed files classify as 4 API, 2 authorization, 1 integration, and 6 supporting files. The fresh result is cached for the next UI analysis.
