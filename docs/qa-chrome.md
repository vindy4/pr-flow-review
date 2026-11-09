# Chrome verification — 2026-10-30

Tested the production app at `http://127.0.0.1:8765/` directly in the running Google Chrome app using native clicks and keyboard input. Chrome's extension automation surface was unavailable; the tests below used the actual Chrome window, not the in-app browser.

Example: `Rippling/rippling-main#605463`, merge base `4cccaa03caf385433367e4b0a036e4f479fefd53`, head `b1f83e9d2143bc653b1b5a2e1d64be7a481a7bca`.

| Check | Observed result |
| --- | --- |
| GitHub URL analysis | Completes with 22 changed files, 49 changed methods, 23 indexed source files, and 271 indexed methods. |
| Method search | `_review_revision` filters the inventory to the intended service method. Clearing the search restores the inventory. |
| Before/After graphs | The added `_review_revision` is absent Before; After displays its four callers. |
| Graph expansion | Expanding `prepare_confirmation` adds `_describe_active_draft` from `steps.py`, plus unchanged context methods. Original focus remains `_review_revision`. |
| Graph node selection | Clicking `_describe_active_draft` changes the inspector without changing the graph focus. |
| Graph edge selection | Clicking the `cdt_matches_configuration` → `cdt_specific_matches` edge opens source-backed evidence at head line 204. |
| Call-site evidence | `prepare_confirmation` → `_review_revision` shows the matching expression and source at head line 218. Clicking its snapshot link opens the exact commit/path/line in a new Chrome tab. |
| Versioned arguments | `claim_confirmation` → `_validate_confirmation` shows the original arguments at base line 227 and the new `review_revision` argument at head line 252. |
| Source and diff | Full source renders with file lines. Modified diff hunks and gutters show file-absolute coordinates, including old line 227 and new line 252. |
| Status filter | Added filter shows the 15 added methods, including three in `draft/service.py`. |
| Excluded files and scope | Test helper file explicitly says “Outside indexed scope.” Coverage details identify the indexed package, excluded tests, and static-analysis limits. |
| Invalid URL | A non-GitHub PR URL shows a clear validation error and preserves the previous comparison. Error dismissal works. |
| Local Git fallback | Comparing the same SHAs from the existing checkout completes with the same counts, is labeled “Local branch comparison,” and uses local snapshot labels. |
| Recovery | Switching back to GitHub and submitting the valid example URL succeeds after the invalid and local comparisons. |

Fresh automated checks also passed: all 40 Python tests (including loopback HTTP tests), TypeScript checking, and the Vite production build. No functional defect requiring a source change was found in this Chrome verification. This checks the listed flows; it does not establish runtime-call completeness or support for other languages.
