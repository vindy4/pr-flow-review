# File review workspace implementation plan

> For agentic workers: implement the approved UX proposal with focused regression tests and an independent final review.

**Goal:** One continuous file-first review session with full file reading, contextual relationships, and review progress.

**Approved design:** The eight recommendations in this conversation, approved by the user's “do it”.

**Architecture:** App owns the current file, symbol, snapshot, reader mode, history, and progress. A pinned-snapshot file API serves full source and diffs. The main reader provides Diff, Full file, and Relationships; the right panel explains the selected file with source-linked context. Existing draft comments remain inside ReviewProvider.

**Tech stack:** Existing React/TypeScript, React Flow, Python and Git; no new runtime dependencies.

## Constraints

- Work in the requested standalone directory; it is untracked in the parent repository, so do not commit unrelated parent contents.
- Preserve pinned before/after snapshots, moved/removed paths, local comparisons, source scope honesty, and explicit review submission.
- Source reads use server-owned analysis descriptors, allowlisted paths and immutable SHAs; reject traversal, binary, oversized and symlink content.
- Short callbacks remain in source and can be expanded in graphs; graph grouping must preserve callback provenance.
- User authorization covers implementation; continue without another plan approval.

## Tasks

1. Full-file source API: add regression tests for pinned code/diff, imports/constants, moves, removals, local mode, unindexed files and invalid reads; observe failures; implement; run Python suite. Contract: POST /api/files/read {analysisId,path} -> {path,base:{path,code,startLine:1}|null,head:...|null,diff}; Analysis.meta.analysisId identifies server-owned repository/snapshot descriptors.
2. Graph projection: reproduce helper leakage and parallel relation loss; collapse local helpers with explicit provenance, retain meaningful external calls, expose full relationship bundles, correct incoming wording; implement fileGraph(architecture,fileId,view,imports) for selected file and immediate neighbors; verify targeted tests/build.
3. Unified workspace: reproduce Overview/file context mismatch and lack of full file reader in browser fixture; implement App-owned file selection, Diff/Full file/Relationships reader, context sidebar, inline source links, symbol jumps, file search/folder grouping, review markers, next unreviewed, navigation history and restored reading positions. Remove disconnected perspective navigation. Keep PR-wide map as explicit Relationships scope.
4. Verify: production build, Python suite, browser regression including comments/draft preview, removed/renamed/unchanged/unsupported files, keyboard operation and 800/360px layouts. Independent review; fix material findings; document final behavior and results.

## Review focus

- Dependency files that are unchanged and absent from the changed-file inventory remain readable and navigable.
- Snapshot/path changes and rapid file switches cannot display stale code or comment anchors.
- File/source reading, graph clicks and evidence inspect keep one shared file context; back restores source position.
- Hidden helpers do not imply direct runtime execution or conceal meaningful mutations/state changes.
- Storage failures, new analysis snapshots and excluded tests do not lose draft comments or misstate review progress.

## Execution record

- Baseline: 90 Python tests and production build passed.
- Source API complete: 101 Python tests passed, including 11 new full-file/HTTP regressions.
- Graph/source context complete: 14 Node regressions pass.
- Unified workspace/browser regression passed after observed RED checks; zero runtime errors or external review submissions.
- Final review findings fixed: refreshed-analysis state, overlay Before evidence, accessible function graph, atomic evidence persistence, source search/history isolation, and Python import facts.
- Detailed evidence and screenshots: docs/qa-file-review-workspace.md and .cache/review-workspace-work/.
