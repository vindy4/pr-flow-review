# Resizable review workspace and draft comments

> Execute inline with executing-plans and TDD; one fresh final reviewer.

**Goal:** Let the reviewer resize/collapse the inventory and inspector, read code at full width, and draft inline GitHub comments before explicitly submitting a review.
**Spec:** User requested movable panel widths and commenting while reading the inspector; selected draft GitHub review comments submitted later.
**Architecture:** Shared PanelWorkspace across both perspectives. ReviewProvider holds snapshot-scoped browser drafts, eligible PR-diff lines and composer/queue UI. A loopback review service validates current GitHub snapshots and diff anchors, then posts a COMMENT review only on explicit submission.
**Tech stack:** Existing React/TypeScript/Python/GitHub CLI; no new production dependencies.

## Constraints
- Standalone project only; no parent Git changes. Target repositories stay read-only.
- Local drafts until the user presses Submit review in the preview. Never post a real review during agent verification.
- Exact path, side and file line from the PR diff; Before/deletion anchors supported. Full-source lines outside the diff cannot become inline PR comments.
- Preserve drafts on refresh, navigation, permission errors, changed heads, and failed submissions. Prevent duplicate submission on repeated requests/ambiguous failures.
- Both views get keyboard-accessible draggable dividers, collapse/reopen controls, reading mode, saved widths and a narrow-screen layout.

## Review focus
- Renamed files and LEFT-side deletions map to GitHub's canonical review path.
- New commits or changed merge base cannot silently reanchor saved comments.
- A successful or ambiguous network write cannot be automatically repeated.
- Draft/composer state survives selection changes; failed writes retain all text.
- Resizing cannot make another pane unreachable or overflow narrow screens.

## Task 1: Resizable layout
Files: frontend/PanelWorkspace.tsx, App.tsx, ArchitectureOverview.tsx, styles.css; browser acceptance.
Interface: PanelWorkspace({left,center,right,leftLabel,rightLabel,revealKey?,className?}).
- [x] Write/run RED real-PR browser assertions for draggable widths, keyboard resizing, collapse/reopen and inspector reading mode in both perspectives.
- [x] Implement shared shell with persisted widths and integrate without changing selection or graph semantics.
- [x] Build and browser checks GREEN.

## Task 2: Review service
Files: backend/reviews.py, server.py, tests/test_reviews.py, tests/test_server.py.
Interface: POST /api/reviews/context {prUrl,baseSha,headSha} → {files:[{path,previousPath,baseLines,headLines}]}; POST /api/reviews/submit same + {body,comments:[{path,side:'base'|'head',line,body}]} → {url,id}.
- [x] RED fixtures for patch parsing, renamed/removed anchors, unknown lines, permissions, stale snapshots, success payload and duplicate/ambiguous requests. HTTP origin protection applies to both routes.
- [x] Read metadata, merge base and paginated files via gh api; validate anchors afresh before a single COMMENT review POST. Persist a submission receipt before writing and its result after success.
- [x] Full Python suite GREEN. Unit tests replace only GitHub transport; no live posting.

## Task 3: Inspector drafting and acceptance
Files: frontend/ReviewDrafts.tsx, Inspector.tsx, ArchitectureOverview.tsx, App.tsx, styles.css, docs.
- [x] RED browser assertions: eligible line + button, draft edit/delete, queue preview, persistence, source/deletion sides, failed submission retains drafts.
- [x] Wrap source/evidence/diff readers with line anchors. Use browser-local snapshot-scoped storage and an explicit review preview/submit action. Clearly label lines outside the PR diff and local comparisons.
- [x] Full build/suite + isolated Chromium acceptance and visual inspection; fresh review, one fix pass, final checks. No live GitHub writes in testing.
