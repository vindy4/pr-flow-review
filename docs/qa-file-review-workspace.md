# File-first review workspace — QA

Implemented the approved UX review in a unified reader: shared file selection, complete Diff and Full file views, file/function Relationships, contextual source navigation, imports/exports, changed tests, visited-file history, and reviewed-file markers. The previous disconnected Overview/Code review perspectives are replaced by reader tabs and an expandable PR overview.

Source reads use opaque private descriptors and exact Git objects, including unchanged dependencies and changed text files outside graph scope. File and diff comments keep actual snapshot paths and file-absolute line numbers; draft submission remains explicit.

Regression evidence:

- `tests/test_files.py`: pinned whole-file reads/diffs, local comparisons, cached analyses, dependencies without functions, excluded text, rename aliases, removed files, path/descriptor validation, binary/symlink/size boundaries, and HTTP protections.
- `tests/graph-projection.cjs`: file scope, snapshots, parallel relations, incoming wording, helper folding/reveal, external calls through callbacks, and snapshot-consistent provenance.
- `tests/source-facts.cjs`: Python/JS/TS declarations, multiline source coordinates, ordinary Python imports, comments, strings, regexes, and nested templates.
- `tests/browser/review-workspace.cjs`: real React/React Flow UI with hand-checked source-boundary fixture. Covers synchronized file/graph/context, full source, symbol jumps, stale responses, tab/history/scroll restoration, progress persistence, draft preservation, removed/renamed/excluded/documentation files, both graph levels, source search, Before-only connection evidence, atomic evidence navigation, narrower reanalysis and same-descriptor test-coverage changes.
- `tests/browser/file-navigation.cjs` remains a compatibility entry point to the current navigation regression.

Observed RED before initial implementation and before scope, overlay-evidence, and search fixes. An independent reviewer identified those edge cases plus unreachable function graphs, stale source-navigation persistence and missing plain Python imports; all are covered by focused fixes and tests.

Verification: Python suite 101/101; frontend Node suite 14/14; TypeScript and Vite production build pass. Browser regression reports zero client runtime errors and zero submitted reviews, including 1720px, 800px and 360px layout checks. The existing Vite advisory about a bundle over 500 kB remains.

Results, RED evidence, screenshots and the real-PR read-only smoke are stored under `.cache/review-workspace-work/`. The app runs on `http://127.0.0.1:8765`. No target checkout files, GitHub comments or reviews were changed.

Real-PR smoke: PR230710 at head473d719 loaded 39 changed files and rendered all379 lines of SelectRetirementBenefitsPage.tsx, including its initial imports. The selected file stayed synchronized with context and a three-file/two-connection map. Browser errors and review submissions both remained zero. That PR is closed; the existing review context correctly reports that local drafts are preserved.

A final function-graph Overlay regression reproduced an incorrect After jump for a removed call; navigation now uses the same version-selection helper as source evidence. File-path searches also retain callback folding, and file-map lane gaps leave room for connection labels.
