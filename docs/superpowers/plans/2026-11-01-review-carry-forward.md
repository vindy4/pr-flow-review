# Unchanged-file review carry-forward

**Approved requirement:** Automatically carry comments and viewed-file markers to the latest PR commits when complete source content is unchanged. Changed files or no longer commentable anchors need attention; ready comments can be submitted without copying or manually reanalyzing.

**Implementation:** Read-only `POST /api/reviews/refresh` validates original file Git blob identities against the latest PR snapshots. Frontend refreshes on draft-preview/open and before explicit submission, retaining original storage records until success. The existing submit route still verifies exact latest SHAs, line eligibility, and receipt deduplication.

## Contract

Request: `{prUrl,baseSha,headSha,comments?:[{id,path,side,line,baseSha,headSha}],reviewed?:[{id,path,baseSha,headSha}]}`. Item SHAs identify the original comparison; top-level SHAs identify the displayed analysis. Empty lists are allowed. Paths must be repository-relative; IDs are opaque stable local-record identifiers.

Response: `{baseSha,headSha,files:[{path,previousPath,baseLines,headLines}],comments:[{id,status:'ready'|'needs_attention',path,side,line,reason}],reviewed:[{id,status:'ready'|'needs_attention',path,reason}]}`. Top-level SHAs always identify the validated latest open PR. Return one result per item, preserving identifiers. Comment paths correspond to the returned snapshot side and remain acceptable to the submit route.

## Tasks

- Backend: add tests and observe RED; validate GitHub metadata, current merge base and diff lines, compare immutable file blob IDs for original/current comment sides; only carry matching blobs with valid current diff anchors. Resolve explicit unambiguous PR renames, reject ambiguous/missing/changed/unavailable source. Viewed files require both comparison-side blob identities unchanged. Recheck PR tips after reading files to reject races. Add route validation and run Python suite.
- Draft UI: gather current and earlier-snapshot drafts with stable record provenance, preview ready/needs-attention status, refresh latest state before submit and post only ready comments under latest SHAs. Preserve attention records, summary, and cross-tab/concurrent edits. Delete each successfully submitted origin version from its actual storage key; do not silently duplicate/reanchor stored drafts. Existing receipt recovery and explicit submission boundary remain.
- Viewed markers: migrate earlier snapshot progress into a new comparison only after full-file verification. Preserve current user decisions and protect in-flight/unmark actions from resurrection; ordinary local comparisons retain existing behavior.
- Verification: Node tests, production build, Python tests, browser regression for unrelated commits, changed files, vanished diff lines, Before/After/rename cases, mixed batches, failed refresh/submission, draft cleanup, viewed carry/reset/unmark. Independent read-only review and fix material findings.

No new dependencies, GitHub comments, or actual review submissions during verification. Work in the existing standalone folder without committing the unrelated parent workspace.
