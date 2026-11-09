# Webapp verification — 2026-10-31

Production app: http://127.0.0.1:8765/. Tested with an isolated Playwright headless browser after the user requested a fallback from Chrome automation. The user's Chrome app was not opened or controlled. Real GitHub metadata and Git snapshots were used; analysis responses were not mocked.

PR: https://github.com/Rippling/rippling-webapp/pull/229275

Merge base: `e6983fcbcf42754c8a96436ad2271ddcc30a24c8`.
Head: `d8ad421f5c50be36c91c13643f153fa011522453`.

Observed: 27 changed files, 76 indexed source files, 249 symbols (91 added, 9 modified, 1 removed, 148 unchanged). Relationships: 74 calls, 36 renders, 150 callback references. Scope: `app/products/hr/Retirements`. No source limit or parse warnings.

| Check | Result |
| --- | --- |
| Real GitHub URL through async API | Completes with pinned provenance and product scope. |
| Hook graph | useCompanyContributionPage connects to useSaveCompanyContributionDraft, its callbacks, and CompanyContributionForm. |
| Callback evidence | Shows exact expression/line and explains that timing or execution is not proven. |
| Before/After | Added hook absent Before and present After. |
| Component diff | Added CompanyContributionForm displays unified source changes. Modified CompanyContributionPageBase displays its diff and both source snapshots. |
| JSX evidence | CompanyContributionForm → CappingStrategySection is labeled Renders; evidence points to head line 286 and exact immutable SHA. |
| Graph fitting | Focus node fits within the graph canvas after Fit graph to view. |
| Exclusions | CappingStrategySection.test.tsx says Outside indexed scope; coverage identifies product scope and excluded tests. |
| Error recovery | Invalid PR URL displays error and preserves prior comparison. |
| Python regression | Original rippling-main #605463 loads; _review_revision connects to prepare_confirmation. |
| Browser runtime | No uncaught page errors during the tested flows. |

Screenshot: `.cache/webapp-qa.png`. Browser harness and output: `.cache/webapp-work/browser-test.cjs` and `browser-results.json`.

Verification: all 59 unit/integration tests passed, including temporary Git snapshot and loopback HTTP tests. TypeScript checking and Vite production build passed. A fresh code review found five incorrect-binding cases; each received a failing regression test and a fix before the final suite and browser run. Deferred minor: a named function expression's declarator alias remains unresolved. Dynamic receivers, HOC-generated exports, custom aliases, CommonJS and export-star remain documented limitations.
