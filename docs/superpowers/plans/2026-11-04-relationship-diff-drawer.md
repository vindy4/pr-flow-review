# Relationship diff drawer implementation plan

**Goal:** Review a selected file's diff in a right drawer while keeping Relationships visible and interactive.

**Spec:** User request and screenshot in this conversation. Selecting a graph card should show its diff without a second tab click or removing the graph.

**Architecture:** Reuse the existing file reader in PanelWorkspace's right pane while Relationships occupies the center. Keep a separate drawer reader mode, shared source loading and reading positions, and stable graph mounting. Reuse current diff, search and comment anchoring.

**Constraints:** No dependencies, analyzed-repository changes, live review submissions, commits, staging, or parent-repository worktrees. Preserve current graph semantics, file history, full-width reading, reviewed markers, drafts and static current-snapshot relationships.

**Review focus:** Same-card selection after closing, stale source responses during quick navigation, source jumps from function graphs, renamed/removed/context files, independent pane resizing, narrow-screen closure and overflow, duplicate tab IDs, source scrolling and exact comment anchors.

- [x] Add failing reader tests for a two-tab drawer and independent accessible reader IDs, then implement optional reader configuration and shared scroll positions.
- [x] Add and observe a failing browser regression for a persistent graph and automatically populated diff drawer.
- [x] Extend PanelWorkspace with controlled right visibility, reader labels, readable saved widths, and responsive drawer styling.
- [x] Integrate drawer selection, close/reopen, source jumps, and navigation state in ReviewWorkspace while retaining ordinary code-only views.
- [x] Run the new browser regression, adjust existing browser locators for simultaneous readers, and verify workspace/search/backend-layer/draft regressions.
- [x] Run Node suite, production build, inspect desktop/narrow screenshots, and obtain a scoped independent review before completion.

## Verification

- Reader tests: observed two expected failures before implementation; all three pass afterward.
- Browser regressions: observed missing-drawer failure, expanded-reader hiding the graph, and duplicate cross-file history, then all eight drawer behavior groups passed with no runtime errors or review submissions.
- Existing browser suites passed: review workspace (14 groups, including preserved manual scroll when leaving the drawer), backend layers (6), reader search (7), and review carry-forward (6; all submissions mocked).
- Node suite: 63 passed. Python suite: 147 passed. Production TypeScript/Vite build passed.
- Desktop and 760px drawer screenshots inspected; code, search and close controls are reachable, with no page overflow.
- Independent scoped review reproduced two navigation issues: duplicate history for cross-file call evidence and replayed source jumps when moving from drawer to full-width code. Both have permanent browser regressions with observed failures before fixes, then passing runs after fixes. Reviewer confirmed the fixes resolve both findings without new material issues.
