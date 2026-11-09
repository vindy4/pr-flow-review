# File-first code review navigation — QA

The Code review perspective now opens its Files inventory, with methods nested under expandable changed-file rows. Selecting a file updates graph scope and inspector together. The graph seeds top-level file methods and their direct callers/callees, marking file methods with IN FILE. The helper toggle broadens seeds. A method click in inventory, graph or file inspector focuses the method; Back to file relationships restores file scope. The secondary Methods index remains available. File names appear above the graph, with the complete path on hover.

Files with no analyzed methods, unsupported files, excluded source files, and absent snapshots have explicit empty states. Added/removed files select an available snapshot automatically. Before/After membership uses the actual source paths, including renamed and moved methods. Inspecting an edge keeps graph scope. Changing snapshots resets context expansion, and an absent root cannot seed unrelated expanded methods.

The new regression is tests/browser/file-navigation.cjs. It uses a hand-checked fixture at the external analysis boundary and exercises real React/React Flow components: default file selection, file-switch graph membership, nested method and inspector drilldown, back navigation, search, unsupported/method-free files, removal/rename/addition snapshots, edge inspection, graph node click, fit bounds and narrow layout. The initial Methods default and stale file-switch graph both failed before implementation and passed afterward. The final reviewer reproduced an expansion leak when switching an added file to Before; the corrected regression failed against the old graph and passed after the snapshot fix.

Run against the built app at port8765 with an installed Playwright runtime:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright PLAYWRIGHT_BROWSERS_PATH=.cache/browsers node tests/browser/file-navigation.cjs
```

Verification: production build and all90 Python tests passed; browser file-navigation regression, real-PR query/component selection, resizing in both perspectives, and draft-comment workflow passed. Browser runs reported no JavaScript page errors. Screenshots are in .cache/file-navigation-work/.

The real example PR230710 closed during the task. Its pinned snapshots still support navigation. Live review context correctly rejects the closed PR, so the comment integration test replays its real read-only /files patches through an intercepted context response and intercepts submission. No real GitHub comment or review was posted. The backend and target repositories were not modified. The server remains on127.0.0.1:8765.

One fresh final review found the snapshot expansion leak; it was fixed with a failing/passing regression and a green full suite. No other actionable findings or deferred minors.
