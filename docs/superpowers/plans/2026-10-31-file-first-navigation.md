# File-first code review navigation implementation plan

> Execute inline with executing-plans and TDD. This standalone folder has no Git repository; preserve its baseline and leave target repositories unchanged.

**Goal:** Start reviews from changed files, keep graph/inspector synchronized, and drill from file to method with a way back.
**Spec:** User feedback in this chat: inventory must put files first; selecting a file must update the relationship graph.
**Architecture:** FileInventory renders file rows with expandable method children. App owns file/method graph focus independently of evidence selection. FlowGraph seeds the selected file's methods plus immediate callers/callees; Inspector offers method drilldown. Existing method search remains secondary.
**Tech stack:** Existing React, TypeScript, React Flow and Python. No dependencies added.

## Constraints and review focus
- Existing overview, resize controls and draft comments continue to work.
- Unsupported, excluded and method-free files clear stale graph content and explain the reason.
- Renames and moves match actual Before/After source paths; added/removed files choose an available snapshot.
- Graph clicks, inventory clicks and inspector method links synchronize selection; edge inspection preserves graph scope.
- Search can locate a method through its containing file; empty states and narrow screens remain usable.

## Task 1: File-first navigation and synchronized focus
Files: frontend/FileInventory.tsx, frontend/fileSelection.ts, frontend/App.tsx, frontend/FlowGraph.tsx, frontend/Inspector.tsx, frontend/styles.css; tests/browser/file-navigation.cjs; README.md and QA notes.
- [x] Write browser regression with literal hand-checked graph memberships: default file tree, file switch, nested method drilldown/back, external callers, method-free/unsupported files, removal and rename snapshots.
- [x] Observe RED on current UI. Implement file tree and explicit file/method focus, including file inspector links and graph breadcrumb.
- [x] Build and browser regression GREEN; use the isolated Chromium runtime and intercept external analysis transport. Never post a GitHub review.
- [x] Recheck real PR navigation and saved-draft flow; run complete Python suite and production build. Final fresh reviewer, one fix pass if required; leave server running.
