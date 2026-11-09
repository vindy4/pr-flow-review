# Architecture overview QA — 2026-10-31

Local production UI: http://127.0.0.1:8765/. Verification uses isolated headless Chromium through Playwright; it does not open or automate the user's Chrome. No target application code is executed.

## Acceptance data

- rippling-webapp #230710: base `7179a544b7939b743fc2a4c97d358378a853d248`, head `99bfe6b275824af33f1216b1a93ec4e39bf5c384`. 40 Git changed files, 104 indexed source paths; 40 symbol moves, 9 modified symbols, 23 additions, 2 unmatched removals. Git rename detection accounts for the difference from the previous 49-file inventory.
- rippling-webapp #229275: base `e6983fcbcf42754c8a96436ad2271ddcc30a24c8`, head `d8ad421f5c50be36c91c13643f153fa011522453`.
- rippling-main #605463: base `4cccaa03caf385433367e4b0a036e4f479fefd53`, head `b1f83e9d2143bc653b1b5a2e1d64be7a481a7bca`.

## Browser checks

The main browser harness lives at `.cache/architecture-work/browser-test.cjs`; regression harness at `.cache/architecture-work/regression-browser.cjs`. Runs submit real GitHub PR URLs through the async local API, without mocking analysis results.

Verified:

- Overview opens with After and SelectRetirementBenefitsPage as the selected feature.
- Page → React Query options → service facade → benefit service → CAPS categories/products → CAPS client. Unrelated plans-listing facade operations and unchanged utility wrappers are excluded from the default feature.
- Mixed JSX/React Query/local-state roles appear on the actual page. No separate Zustand store is invented for that page.
- Every changed file is available by layer; supporting files start collapsed. Excluded tests show their scope explanation.
- Explicit Removed filters reveal both unmatched nested removals even with helpers collapsed; After shows their absence and Before displays their source.
- A moved listing retains its old Before path and new After path. Method drilldown opens the matching pinned source. Callback/helper inventory starts collapsed.
- Zustand contribution PR connects the screen/components, store reads/subscriptions, query/mutation hooks, and service functions. JSX render evidence still uses exact source and immutable SHA.
- Invalid GitHub URL shows a recoverable error and preserves the prior comparison.
- Layout has no page-level horizontal overflow at 1050px.
- Python overview and method drilldown retain `prepare_confirmation` → `_review_revision` caller context. Added methods are absent Before; modified methods' Before source links use the pinned base SHA.
- No uncaught browser JavaScript errors in either acceptance run.

Visual inspection: `.cache/architecture-work/overview.png` and `zustand.png` (current redesign). File cards group by layer; method detail remains a separate perspective. Large feature maps can be zoomed and panned; all connections also have explicit evidence buttons.

## Automated checks

Full unittest suite: 80 tests green after final-review fixes (seven new regression test methods cover 21 failing cases observed before fixes). TypeScript and Vite production build passed. Vite reports a bundle-size advisory at approximately 509 KB (163 KB gzip); it does not prevent the local build.

The reviewed store initializer in #229275 contains a spread, so its store-function targets remain unresolved; read/subscription edges stay visible. Dedicated fixtures verify neutral store-function calls, explicit setState writes, and rejection of overwritten actions. Named query/mutation references, unchanged useState/useReducer hooks, equivalent duplicate keys, and computed property writes/deletes have regression coverage.

Final acceptance reruns passed after fixes, with no browser page errors. The local server was restarted on the current backend/cache version.

Final-review findings, fixes, final test counts, and reruns are recorded in `.cache/architecture-work/progress.md`.
