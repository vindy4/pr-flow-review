# Architecture overview implementation plan

> **For agentic workers:** Use executing-plans inline, with test-driven development and one fresh final code reviewer.

**Goal:** Explain a PR through feature flows and application layers, with source evidence and method drilldown.

**Architecture:** Keep immutable snapshots and language adapters. Reconcile symbol moves before adding a versioned file/layer architecture model derived from syntax and proven imports. Default the UI to the After feature overview; retain detailed method graphs and evidence.

**Tech stack:** Existing Python, Tree-sitter, React, TypeScript and React Flow. No target code execution or new production dependencies.

**Spec:** User-approved five-part proposal in this conversation: overview, layer grouping, feature map, explicit moves, progressive disclosure.

## Global constraints

- Standalone folder only; target repositories read-only; no parent Git commits or branch changes.
- Layers: screens/JSX, client state (including local React state and Zustand), server state (React Query), services, integrations, supporting changes, unclassified.
- Syntax/import evidence and path classification must be distinguished. Type-only imports are supporting context, never execution edges.
- Calls, renders, query registration, state access and imports must retain honest meanings and pinned source links.
- A moved symbol retains both paths/versions. Ambiguous moves remain separate. Anonymous callbacks are collapsed by default in method inventory.
- After is the default view; removed code remains accessible in Before/Changes. Overview summaries use deterministic facts, no inferred business behavior or cloud service.

## Review focus

- Reassigned/spread/dynamic object facades must not invent definite method calls.
- Imported React Query/Zustand names can be shadowed; recognition must follow actual bindings.
- Ambiguous/repeated function bodies must not be paired merely by name; moved evidence must use the correct path and side.
- Files with multiple roles retain their tags; unclassified or type-only changes remain accessible.
- Feature filtering and After view must not hide genuine deletions from the change inventory.

## Task 1 — Movement comparison

Files: backend/github.py, backend/comparison.py, backend/analyzer.py, backend/javascript.py; tests/test_backend.py, tests/test_comparison.py.
Interface: analyze_sources(base, head, changed_paths, renames=None); existing arguments remain valid. Symbols gain moved/moved_modified statuses, basePath/headPath/baseId. Git files gain previousPath for detected renames.

- [ ] Write tests for Git renames, moved unchanged/modified symbols, unique exact cross-file moves, ambiguous candidates and aligned versioned edges. Observe RED.
- [ ] Read Git rename metadata; match same qualname within proven renamed file pairs, then unique exact structural candidates with the same qualname. Remap edges to canonical head IDs and preserve source paths on both sides. No fuzzy name-only merging.
- [ ] Run comparison/backend/analyzer suite; expect all green.

## Task 2 — Framework and facade relationships

Files: backend/javascript.py, backend/architecture.py; tests/test_architecture.py and tests/test_javascript.py.
Interface: analysis.architecture contains versioned file nodes, layer definitions, evidence-backed connections, feature roots and change summaries. File nodes include primary layer, role tags and classification reasons; semantic evidence includes symbolId when known.

- [ ] Add RED tests for nested exported object-literal facade calls, mutation/shadowing refusal, React Query options/queryFn/mutations, imported Zustand hooks/selectors/actions, type-only imports and mixed-role files.
- [ ] Extend lexical resolver to explicit local/imported const object literals and property aliases. Reject spreads/computed/dynamic receivers and explicit writes. Recognize library APIs only through their imported bindings.
- [ ] Build file-level semantic relationships and import fallbacks from parsed snapshots; preserve facade delegation as an intermediate step. Include only proven relationships, with explicit import labels for fallback context.
- [ ] Derive feature roots from changed screen/component files (fallback to changed service roots), classify file roles with reasons, and build deterministic review summaries for layers, boundaries and moves.
- [ ] Run the full suite; expect green.

## Task 3 — Progressive review UI

Files: frontend/ArchitectureOverview.tsx, frontend/ArchitectureMap.tsx, frontend/types.ts, frontend/App.tsx, frontend/Inspector.tsx, frontend/FlowGraph.tsx, frontend/styles.css.

- [ ] Add a failing browser acceptance harness for default overview, layer inventory, current PR feature path, move badges, layer evidence and method drilldown.
- [ ] Add Overview/Method details navigation, feature selection, version controls and layered file map. Keep supporting files collapsible and show layer tags/reasons in file details. Click a connection to inspect exact evidence; click an operation to open method detail.
- [ ] Default to After and a changed screen; retain removed changes in inventory and Before. Add moved status styles, base/head path-aware links and source/diff evidence. Collapse anonymous callbacks/helpers by default with an explicit reveal control.
- [ ] Build and run browser checks; expect no runtime errors and readable screenshot.

## Task 4 — Acceptance and review

- [ ] Analyze real rippling-webapp #230710 and verify page → query → client → service → CAPS, correct moved listings and genuine removals. Exercise Zustand on #229275 and Python #605463 as regressions.
- [ ] Run full unittest suite and npm production build. Request one fresh read-only code review; fix Important findings with RED→GREEN tests and one fix pass.
- [ ] Re-run affected acceptance checks, visually inspect screenshots, update docs/contract.md and QA record, leave localhost server running.
