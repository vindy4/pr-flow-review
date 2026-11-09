# Review carry-forward — QA

Approved behavior: an unrelated PR commit must not force copying and reattaching comments on unchanged files. Draft preview now checks every saved version against the latest open PR and separates ready comments from comments needing attention. Explicit submission checks again, posts only the ready batch, and leaves the other versions saved at their original keys. Viewed files carry when both sides of their complete comparison remain unchanged.

The service reads immutable Git commit/tree identities rather than comparing displayed snippets. A comment also needs its original side and line to remain commentable in the latest PR patch. Changed, unavailable, ambiguous or missing files, and vanished diff anchors, stay saved for attention. PR tips are rechecked after verification. Unambiguous explicit renames preserve source-side paths. There is no fuzzy relocation of comments onto changed content.

Draft versions retain snapshot provenance, including identical local IDs in different snapshots. Successful cleanup tombstones only submitted origin versions. Concurrent edits and unsent summaries remain. A durable pending-submission envelope preserves the exact backend receipt payload through network loss, reloads and later commits. Ready batches respect the existing 50-comment and 64 KiB submission limits; the remainder requires another explicit submission.

## Regression coverage

- `tests/test_reviews.py`: full-file identity, Before/After sides, changed/missing/unavailable files, invalid current diff anchors, added/deleted files, renamed paths and rename chains, ambiguity, latest-tip races, receipt recovery, uncertain writes, and safe rejection.
- `tests/test_server.py`: refresh dispatch, read-only request size, and existing Host/Origin/JSON protections.
- `tests/review-drafts.cjs`: provenance, immutable versions, concurrent replacement/deletion, storage failures, origin-specific cleanup, complete refresh results, durable receipt envelopes, comment/UTF-8 batch limits.
- `tests/review-progress.cjs`: verified migration, current decisions, explicit empty arrays, durable unmark/re-mark choices and renamed paths across future commits, in-flight toggles, stale SHAs, cancellation/remount, concurrent decisions, bounded historical batches, local mode and original-key isolation.
- `tests/browser/review-carry-forward.cjs`: real React UI with mocked GitHub boundaries; mixed older/current drafts, latest-SHA submission, original-key cleanup, concurrent edits, retained summary, failed refresh and submission, exact-payload recovery after reload, viewed carry/reset, and explicit choices across new commits.
- `tests/browser/review-workspace.cjs`: existing file-first reader, source/graph navigation, drafts, progress, scope updates and narrow viewport regression.

Meaningful RED was observed before the new backend/helper/UI behavior and for the subsequent across-commit explicit-unmark regression. Independent review checked blob/anchor correctness, mixed submission, origin cleanup, batching and receipts, and found the viewed-history and concurrent-decision edge cases for correction.

Final verification: all 117 Python and 48 Node tests pass, including strict no-write stale-head/base rejection with guidance to refresh drafts and try again. The viewed helper has 25 focused regressions, including interleaved decision writes, stale-array remounts, legacy event migration, deterministic simultaneous decisions, newly connected rename lineages and distinct files reusing an old rename path. Production TypeScript/Vite build passes; the existing advisory about a bundle larger than 500 kB remains. Both browser suites pass (six carry-forward scenarios and 13 existing workspace scenarios) with zero client runtime errors. Carry-forward tests intercept six submission requests and publish zero live reviews; the existing workspace suite sends zero submission requests.

Independent review reproduced and checked fixes for future-snapshot unmark resurrection, historical refresh limits, interleaved different-file decisions, and distinct files reusing a renamed path. Positive decisions within the same comparison restore only their exact file path; negative decisions remain durable through remounts.

Final independent verdict: approved; all reported findings fixed.

The app runs at `http://127.0.0.1:8765`. Browser review submissions are intercepted by fixtures; no live GitHub comments or reviews are published. Reports, screenshots and test output live under `.cache/review-carry-work/` and `.cache/review-carry-*-report.md`.
