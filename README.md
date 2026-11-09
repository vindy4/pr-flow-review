# PR Flow Review

A standalone local browser tool for reviewing Python, JavaScript, TypeScript, and React pull requests through feature maps, application layers, method diffs, and source-backed relationships. The interface uses the Midnight theme: navy surfaces, cyan accents, and distinct change-status colors shared across graphs and code readers.

## macOS desktop app

The Electron app bundles the Python analyzer, native parsers, Git, and GitHub CLI.
Teammates install a DMG and sign into GitHub without installing developer tools.
See [macOS installation, building, and signed releases](docs/macos.md).

```bash
npm ci
npm run desktop:prepare
npm run desktop:dev
# Local unsigned development installer:
npm run desktop:build
```

Normal teammate distribution requires a signed and notarized release:
`npm run desktop:release` checks for the Apple credentials documented above.
Build separately on Apple Silicon and Intel Macs. Desktop saved state is separate
from browser saved state and persists when replacing the installed app.

## Start

Requires Node.js 20.19+ (or 22.12+), npm, Python 3.11+, [uv](https://docs.astral.sh/uv/), Git, and [GitHub CLI](https://cli.github.com/).

```bash
cd /path/to/pr-flow-review
npm install
npm run build
./run.sh
```

Open **http://127.0.0.1:8765**, paste a GitHub PR URL, and choose **Analyze flow**. For private repositories, run `gh auth login` and authorize organization SSO if required. The app inherits your GitHub account's repository access; it neither requests nor displays a token in the browser. Analysis uses read operations. Submitting a review from the draft preview requires GitHub write permission; drafts remain local until that explicit action.

The example PR URL is prefilled for convenience. Any accessible GitHub PR can be entered; supported sources are Python, JS/JSX, and TS/TSX (including .mjs/.cjs/.mts/.cts; declaration files are excluded).

## Explore

- Select a changed file in the left inventory. The reader and relationship map follow the same file. Group files by folder or layer and search by path or symbol name.
- **Diff** shows the complete file diff with syntax colors, separate Before/After line numbers, and long lines wrapped by default. **Full file** reads the entire pinned Before or After file with copy and inline review drafts. Search highlights every occurrence in the current view, including removed lines in Diff; Enter advances and Shift+Enter goes back while keeping the match visible. Selecting a component, hook, function, or callback jumps to its source line inside that file.
- **Relationships** always shows the current PR snapshot, starting with the selected file and its immediate incoming/outgoing dependencies, including unchanged files. Selecting a graph card or inventory file opens its **Diff** in a right drawer while the graph stays visible. Switch the drawer to **Full file** to read or search the complete file; selecting a function or call jumps to its source line there. Choose **All changed files** for PR-wide context, or **Functions and callbacks** for the method graph. Local callbacks/helpers start folded; their summaries and source paths can be expanded. Folded paths keep explicit callback provenance.
- Backend files use eight review layers: **APIs & routing**, **Authorization**, **Business logic & rules**, **Data & persistence**, **Jobs & workflows**, **Integrations & delivery**, **Reporting & projections**, and **Operations & migrations**. Source syntax and directory conventions identify the primary responsibility and any secondary roles. Empty graph layers stay hidden; **Group by → Layer** uses the same architectural order. Tests, documentation, and contracts remain supporting changes. Existing webapp layers stay available in mixed-language PRs.
- **Previous file** and **Next visited file** restore the file's reader tab, snapshot, and reading position. **Mark reviewed** and **Next unreviewed file** track progress in browser storage. After new commits are analyzed, unchanged files keep their reviewed marker when both Before and After contents still match; changed files need another review.
- **PR overview** expands without changing your selected file. Reanalyzing refreshes file coverage and relationships; saved progress for the same commits remains available.
- Drag the inventory or reader divider to resize; focused dividers also support arrow keys and Home/End. Hide the inventory or choose **Expand reader** for full-width code, then **Restore layout** to return. Close or hide the drawer to give the graph more room; **Show reader** or selecting a file reopens it. Narrow windows show the drawer as a right sheet over the graph.
- Use **+** beside an eligible source/diff line to save a draft comment. **Review drafts** automatically checks saved comments against the latest PR commits, including drafts from earlier snapshots. A comment is **Ready** when its entire source file is unchanged and its line remains in the latest diff. Changed, missing, or unverifiable files and invalid lines show **Needs attention** and stay saved. **Submit review** (or **Submit ready comments** for a mixed queue) checks again and explicitly posts ready comments as one GitHub COMMENT review, without requiring manual copying or reanalysis.
- Removed and renamed files retain their matching Before paths. Changed test, configuration, and documentation text remains readable even when excluded from graph analysis. Binary files, symlinks, and files over 1 MiB are not displayed as source.

## Repository access and scope

The Python backend calls `gh`; the browser talks only to the loopback backend. The server rejects foreign origins and unexpected hosts. It never imports or executes analyzed code, switches a target branch, changes a target working file, or writes PR comments during analysis. The explicit Submit review action posts the comments shown in its preview.

When a matching checkout exists beside this project, its Git objects are read directly, including unchanged callers. An optional checkout-path field supports other locations. Otherwise the app fetches the two required snapshots to its own `.cache/repositories/` directory through GitHub CLI's Git credential helper.

Default analysis scopes are the feature packages containing changed source files; webapp paths under `app/products/` default to the changed product. **This is a scoped graph, not a complete repository call graph.** The analysis summary shows the indexed file count; **Analysis scope** expands the indexed directories and coverage details. Supply comma-separated repository-relative directories in the scope field to widen coverage, or `.` for the repository. Tests are excluded unless enabled. A shared cap of 2,000 file paths across both snapshots, 1 MiB per file, and 32 MiB of selected sources per snapshot keeps the prototype bounded; the app warns if it omits files. A path is omitted from both versions if either exceeds a limit, so limits cannot fabricate additions or removals.

Source graphs are static relationships, not execution traces. Imports, aliases, lexical functions, and statically resolvable `self`/`cls`/inherited method calls are analyzed conservatively. Variable receivers, runtime registries, dependency injection, monkey-patching, callbacks, decorators, and task dispatch may remain unresolved. An unresolved call is not evidence that no caller or execution path exists. Base/head comparison identifies structural method changes; imports and data declarations can alter behavior without changing a method's syntax, so the full PR still needs review.

Analysis results and source snippets stay in `.cache/` on your machine and are excluded by `.gitignore`. Remove that directory to discard caches (stop running analyses first). Draft versions and the review summary use browser storage; submitted versions leave the queue while concurrent edits remain. If a submission response is lost, **Confirm previous submission** checks its exact saved receipt before allowing a new batch. Clear this site’s browser data to remove local draft history. Review submission receipts are stored in `.cache/reviews/`. No cloud analytics, LLM, or telemetry is used.

## Development and checks

```bash
# Terminal 1: backend
UV_CACHE_DIR=.cache/uv uv run python -m backend.server

# Terminal 2: frontend with /api proxy to the backend
npm run dev

# Verification (API tests bind temporary loopback ports)
UV_CACHE_DIR=.cache/uv uv run python -m unittest discover -s tests -v
npm run build
node --test tests/*.cjs
# Browser regression, with PLAYWRIGHT_MODULE and PLAYWRIGHT_BROWSERS_PATH set if needed:
node tests/browser/review-workspace.cjs
node tests/browser/review-carry-forward.cjs
node tests/browser/reader-search.cjs
node tests/browser/backend-layers.cjs
node tests/browser/relationship-drawer.cjs
```

Development UI: http://127.0.0.1:5173. Production UI and API: http://127.0.0.1:8765. Use `./run.sh --port 8766` if the default production port is occupied. Stop with Ctrl+C.

## Project layout

```text
backend/analyzer.py   Python symbols, conservative call resolution, version comparison
backend/javascript.py Tree-sitter JS/TS symbols, import bindings, JSX and callback references
backend/comparison.py Symbol movement reconciliation with versioned paths
backend/architecture.py Layer/feature models and precise semantic evidence
backend/javascript_bindings.py Static object and framework binding resolution
backend/github.py     GitHub metadata, immutable Git snapshots, scope and disk cache
backend/server.py     Loopback HTTP API, asynchronous jobs, built frontend serving
backend/files.py     Allowlisted full-file reads from pinned Git objects
frontend/             File-first reader, review context and React Flow maps
tests/                AST fixtures, temporary Git snapshots, HTTP boundaries
docs/                 Design, JSON contract, implementation plan
```

This is a review-navigation prototype. Runtime traces, AI summaries, hosted authentication, and deeper type-based resolution are future work. Framework recognition currently covers direct imports of common React Query APIs, React useState/useReducer, and Zustand create/createStore with explicit initializer actions. Custom wrappers and more advanced middleware may remain unresolved.

## Webapp relationships

JS/TS uses Tree-sitter to parse both immutable snapshots. The graph includes function and arrow definitions, methods, React components, hooks, and callbacks. Relative imports, repository-root imports such as `app/...`, explicit named/default re-exports, and namespace imports resolve inside the displayed scope. Known React `useCallback` imports preserve named handler bindings. JSX renders and callback references have separate labels and dashed styles: neither implies execution timing or order. External components and libraries remain unresolved.

Explicit object-literal façades, nested property aliases, and imported implementations can resolve when their bindings are static. Spread/computed properties and detected property writes invalidate those bindings. Dynamic object/prop dispatch, custom tsconfig aliases, export-star barrels, CommonJS `require`, and runtime registries remain unresolved. HOC-generated exports may not resolve to their inner components; the underlying function definitions remain inspectable. Anonymous callback IDs use their ordinal within the containing function; inserting callbacks can change alignment. Comments and whitespace do not mark a function modified. Syntax errors exclude that path on both sides and produce a warning.

Tests (`__tests__`, `tests`, `test`, `*.test.*`, `*.spec.*`, integration/component tests and `__mocks__`) are excluded unless enabled. Ordinary service mocks remain source context. GitHub permissions and source access work the same for webapp as for backend PRs.
