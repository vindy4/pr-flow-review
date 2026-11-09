# PR Flow Review prototype

Approved scope: a standalone local browser app. Paste a GitHub PR URL, identify changed Python methods, explore their callers and callees, and inspect method diffs and exact call-site evidence. Read through GitHub CLI credentials in the backend, never expose credentials to the browser. No target checkout edits, no PR comments, and no cloud service. Also support explicitly labeled local Git comparisons for offline work.

React + TypeScript + React Flow UI, Python standard-library HTTP API and AST analyzer. Git snapshots are pinned to merge base and head. Reuse existing matching Git object stores read-only, otherwise fetch snapshots to this project's private cache. Default analysis indexes the changed Python packages and their package-local callers; the UI must show the scope and clarify that callers outside it are not included. Optional custom scope allows larger scans. Never infer a definite call by matching a method name alone. Surface unresolved calls, parse errors, and analysis limits. Methods present only in the base remain available.

Three panels: searchable changed-method inventory, expandable graph, evidence inspector. Before/after/overlay controls filter versioned edges and nodes. Graph selection displays source/diff; changing the focus method changes its neighborhood. Graphs are static source relationships, not runtime traces. Skip lifecycle inference and AI summaries in this prototype.

## Webapp extension — 2026-10-31

The initial Python analyzer remains intact behind a language dispatcher. Tree-sitter adapters add JavaScript, JSX, TypeScript and TSX definitions, lexical/import resolution, and version comparisons. Components, hooks, arrows and callbacks share the source/diff contract. Edges distinguish calls, JSX renders and callback references; none imply runtime order. Known imported React useCallback bindings preserve handler identity. Unknown receivers, custom aliases, HOC-generated values and external dependencies remain unresolved. Default webapp scope is the changed product under app/products, with tests excluded unless requested. Both snapshots use shared file coverage and bilateral parse-error exclusion.


## Architecture overview — 2026-10-31

The default review perspective is a file-level feature map in the After snapshot. A separate layer inventory retains every changed file regardless of selected feature or snapshot. Layers distinguish JSX screens, client state, React Query server state, services, API integrations, supporting code, and unclassified files. A file can carry several roles; a React page with local state and queries stays a single file card with all three tags. Directory-based classification explains its evidence separately from imported-framework recognition.

Explicit object-literal bindings retain service facades in the flow instead of jumping directly from the caller to the implementation. Incoming target symbol identities constrain which facade properties appear for a selected feature. The map collapses duplicate file-pair relationships; all relationships and their precise source sites remain inspectable. Framework registration (including named queryFn/mutationFn references), store reads, neutral store-function calls, explicit setState writes, facade delegation, calls, renders, and import context have distinct labels. The feature map follows dependencies, not runtime order.

Move reconciliation uses Git rename evidence and otherwise unique identical structural functions. It keeps canonical head IDs, original base IDs, both paths, code, and versioned edges. Ambiguity stays visible as separate changes. A method-level perspective remains available for drilldown with diff/source/relationships and collapsed callback inventory. Source links always use the matching snapshot path and SHA. The prototype has no cloud summaries or runtime instrumentation.
