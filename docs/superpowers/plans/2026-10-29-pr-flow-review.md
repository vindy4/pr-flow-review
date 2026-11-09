# PR Flow Review Implementation Plan

> **For agentic workers:** implement the approved prototype continuously; independent analyzer and UI tasks run in parallel, with integration and a fresh review afterward.

**Goal:** Paste a Python GitHub PR URL and explore changed methods with call graphs and linked diffs.
**Architecture:** Independent Python AST analyzer and React Flow frontend meet through the JSON contract in docs/contract.md. Local Python HTTP service reads pinned Git objects through git/gh; it never imports target code.
**Tech Stack:** Python 3.11+ standard library; React, TypeScript, Vite, React Flow, Dagre, Lucide.
**Spec:** docs/design.md; docs/contract.md.

## Constraints and review focus

- Keep all new files inside pr-flow-review. Do not edit target repositories.
- Bind to loopback; reject foreign origins, malformed URLs, unsafe refs, and traversal.
- Prove import/relative/self/cls resolution with real AST fixtures and never invent dynamic edges.
- Preserve removed methods and base-only edges; distinguish argument changes from line moves.
- Show partial scope, excluded tests, parse failures, and missing auth clearly.

## Tasks

- [x] Analyzer: backend/analyzer.py and tests/test_analyzer.py. Test-first fixtures for added/modified/deleted methods, imported aliases, class methods, inherited methods, relative imports, lexical locals, unresolved dispatch, shifted lines, and parse failures. Implement analyze_sources with the shared contract; run unittest.
- [x] Backend: backend/github.py, backend/server.py and tests/test_backend.py. Test URL/ref/scope validation, real temporary Git snapshot reads, local mode, failed jobs, and origin checks. Add asynchronous jobs, honest scope selection, caching and production static serving.
- [x] UI: package.json, Vite/TypeScript config and frontend/. Build the three panels with loading/errors, search and status filters, before/after/overlay, graph expansion, selected-edge call-site evidence, source and diff, local comparison form and provenance.
- [x] Integration: install dependencies, run Python tests and TypeScript production build, launch app, analyze the exact example snapshots, and inspect real browser interactions. Fresh independent review and fix material findings. Write README and leave the app open.

## Execution notes

User approved building this scope after discussing browser behavior and access. Proceed without another approval round. No commits/push/publication required. Existing dependency builder examined: its import resolver does not resolve self/cls and lacks snapshot comparison; implement a small independent analyzer instead of importing application tooling.

## Validation

40 Python tests pass, including AST accuracy, immutable Git snapshots, shared coverage limits, local comparisons, asynchronous jobs and HTTP origin boundaries. TypeScript checks and Vite production build pass.

Real GitHub URL analysis of PR #605463 used merge base `4cccaa03caf385433367e4b0a036e4f479fefd53` and head `b1f83e9d2143bc653b1b5a2e1d64be7a481a7bca`. Within `app/pension_management/ai_onboarding`, it indexed 23 source files and 271 methods; 49 changed methods were found across the PR. `draft/service.py` has three added and seven modified methods. Browser checks confirmed all four `_review_revision` callers, absence in Before, cross-file expansion to `steps.py`, pinned call-site links, and side-specific arguments for `claim_confirmation` at base line 227 / head line 252. Excluded test files and scope limits are explicit in the UI.

Independent review findings were fixed and rechecked: method-relative diff coordinates now display file-absolute lines; Before expressions match Before source. Graph cards show short method names with class context so shared prefixes do not hide the method identity.
