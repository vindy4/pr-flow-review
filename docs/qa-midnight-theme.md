# Midnight theme QA

Applied the user-selected Midnight palette from the standalone theme preview to the actual app. Shared CSS variables live in frontend/theme.css; existing layout CSS now consumes those tokens. Both graph components use the same variables for labels, edges, arrows, backgrounds and minimap. Native controls use the dark color scheme. Added, modified, removed, moved and moved/modified states retain distinct colors. The layout and review behavior are unchanged.

Verification: production TypeScript/Vite build passed. Existing isolated-browser file navigation, snapshot/rename cases, graph edge and node selection, panel resizing, full-width inspector, narrow layout, and draft-comment workflow passed. Draft submission was intercepted; no live GitHub review was posted. Browser checks recorded no JavaScript errors. A computed-style audit checks visible text contrast and catches unexpected light surfaces in the comparison form, overview and code review. Screenshots and the local audit script are in .cache/midnight-work/. The initially white native feature selector and low-contrast cyan secondary button were corrected during visual inspection.

The existing Vite bundle-size advisory remains. No backend or target repository files changed.
