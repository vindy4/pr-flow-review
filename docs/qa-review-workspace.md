# Adjustable review workspace and draft comments — QA

The user requested movable panel widths and chose draft GitHub review comments to submit later.

Both perspectives share draggable/keyboard-accessible dividers, collapse/reopen controls, saved widths, reset, and a full-width inspector reading mode. Narrow screens stack the panes.

Commenting is available on PR-diff lines in source, method diff, and architecture connection evidence. Drafts retain file path, snapshot side, file-absolute line and source text. They are kept in browser storage, scoped to the repository, PR, base and head. The review queue previews all current comments, supports editing/deleting, and submits one COMMENT review only when the user presses Submit review. Repository write permission is required at that point. Local Git comparisons cannot publish PR comments.

GitHub context and submission validate the live PR head, merge base, and paginated changed-file patch lines. Before lines in renamed files map to GitHub's canonical filename and LEFT side; removed-file lines are supported. Lines outside the diff stay unavailable. Submission receipts in `.cache/reviews/submissions/` deduplicate a completed batch across refresh/restart; uncertain writes remain blocked for manual verification. Known permission/validation rejections stay retryable. No target checkout files are modified.

Verification artifacts:

- `.cache/review-ux-work/panels.cjs`: real PR, pointer/keyboard resize, collapse/reopen, full-width inspector in both views, 800px overflow check. Observed RED before layout implementation, then GREEN.
- `.cache/review-ux-work/comments.cjs`: real GitHub context, After/Before source comments, edit/delete, queue preview, persistence, explicit submission boundary, error retention, deletion-diff Before anchors, and simulated successful submission clearing the submitted batch. The submit route is intercepted in the browser, so testing never posts a live review.
- `.cache/review-ux-work/draft-recovery.cjs`: older-head drafts stay accessible without being silently reanchored.
- `.cache/review-ux-work/multitab.cjs`: two tabs save/edit/delete, conflicting edits retain both versions, and a held simulated submission preserves new/edited drafts in another tab; reload retains the unsent versions. Observed RED then GREEN.
- `.cache/review-ux-work/context-retry.cjs`: a transient context failure can be retried without refresh. Desktop and 800px/360px checks pass with no horizontal overflow. The narrow-screen button first had a failing visibility check, then passed.
- `tests/test_reviews.py`: real patch/anchor validation and submission logic, replacing only the external GitHub transport. Covers canonical rename paths, removed files, stale commits, invalid lines and malformed side values, permission retry and persistent duplicate/ambiguous receipts.
- `tests/test_server.py`: both review endpoints retain origin/host and JSON-body protection.

The example PR received new commits during this work: head changed from `99bfe6b275824af33f1216b1a93ec4e39bf5c384` to `b9afbaebc6a6499aa59e023603e58f29f7c6e532`; browser checks use the current analysis rather than hard-coded old counts.

The real-context browser runs passed with zero JavaScript page errors. Draft and summary persistence and earlier-snapshot recovery each had failing checks before implementation and passing reruns after it. The final 90-test Python suite and production build passed. Vite retains its existing advisory for a bundle larger than 500 kB. All browser scripts above passed after the recovery fixes; no real GitHub review was posted. Screenshots `review-drafts.png` and `reader.png` live in the work directory.

Final suite/build/browser results and review findings are recorded in `.cache/review-ux-work/progress.md`. Draft screenshots are local QA artifacts, not GitHub comments.

Final fresh review found no Critical issues. Important findings were cross-tab draft overwrites and context recovery without a refresh; both were fixed and regression-tested. Malformed side validation was also fixed so arrays and objects return a validation error before any GitHub access. Submission previews use the displayed versions; concurrent edits remain unsent. The server was restarted with the final backend and remains available on port 8765.
