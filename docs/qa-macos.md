# macOS desktop verification

## Current build — 2026-11-06, version 0.1.2

Fixed two independently reproduced desktop failures and rebuilt from current
source, including the relationship-card right-hand diff drawer.

- Large-repository snapshots previously fetched every file's contents before
  applying scope. Managed caches now fetch shallow commit/tree metadata, query
  missing blob sizes through GitHub, and batch only bounded selected contents.
  Oversized sources, excluded files and unrelated large assets stay absent.
  Modified-rename detection has its own bounded pass; exact renames need no blobs.
- A slow renderer reading a large HTTP/1.0 response reproduced the exact
  `Parser.finish` / `assert(!this.paused)` exception in Electron's Undici parser.
  The API bridge now drains the backend response before returning its body to
  Electron. The regression failed with the reported stack before the change,
  then passed in Electron; the standalone 20-response reproduction passed too.
- Python: 153 tests passed. Node: 84 tests passed. Six real filtered-Git
  regressions cover selective transport, source exclusions, rename handling,
  oversized file reads, literal paths and managed Git configuration isolation.
- Independent review reproduced and caught a wildcard-path rename failure.
  Literal Git pathspecs fix it; the expanded regression passes. Protocol review
  also checked cancellation, failed response streams and JSON/status preservation.
- Fresh-cache analysis of `Rippling/rippling-webapp#227066` using desktop helper
  binaries completed in 58.0 seconds and fetched 9,883,521 bytes of repository
  data. A pinned full source file read succeeded. Default scopes reached the
  existing 2,000-file indexing cap and retained the coverage warning.
- TypeScript/Vite, the relationship-drawer browser regression, packaged Electron
  smoke and installed runtime architecture/library audit passed. Installed
  frontend, frozen backend and protocol code match the freshly built files.
- Version 0.1.2 is installed at `/Applications/PR Flow Review.app` from the
  verified DMG. Version 0.1.1 is preserved under
  `.cache/desktop-work/PR Flow Review-0.1.1-backup.app`.
- A second cold-cache run through the installed app completed in 50.9 seconds
  with no renderer errors. Selecting the `us.endpoints.ts` graph card kept the
  graph visible and displayed its pinned diff in the right-hand code drawer.
  Results and screenshot are under
  `.cache/desktop-work/packaged-227066-0.1.2/`.
- DMG disk-image integrity, SHA-256 and share-ZIP integrity passed. Artifacts are
  `release/PR-Flow-Review-0.1.2-arm64.dmg` and
  `release/PR-Flow-Review-0.1.2-arm64-share.zip`.

Source hashes are in `.cache/desktop-work/rebuild-0.1.2-source.json`. This remains
an unsigned Apple Silicon development build; the external release checks below
still apply. No reviews were submitted.

## Previous build — 2026-11-04, version 0.1.1

Rebuilt the native runtime and frontend from the current source, including the
relationship-card code drawer changes. Installed at `/Applications/PR Flow Review.app`.
The installer is `release/PR-Flow-Review-0.1.1-arm64.dmg`.

- Python: 147 tests passed. Node: 83 tests passed.
- TypeScript/Vite production build and native runtime audit passed.
- Relationship-drawer browser regression passed: graph selection, pinned diff,
  full file, search, resizing, closing/reopening, and graph viewport preservation.
- Packaged Electron smoke passed: startup, API broker, sandbox, native picker
  boundary, persistence, restart, process cleanup, and frozen parser self-test.
- Packaged frontend and runtime match the freshly built files byte for byte.
  Installed frontend assets match the package; installed version is 0.1.1.
- DMG verification and SHA-256 verification passed.
- Live installed app loaded `Rippling/rippling-webapp#231559`. Selecting the
  `routes.tsx` relationship card retained the graph and displayed its diff in
  the right-hand drawer. No real reviews were submitted.

The previously reported GitHub failure was not reproduced. Both system and
bundled GitHub CLI read the PR successfully; Git remote access succeeded with
both the existing SSH URL rewrites and isolated HTTPS configuration. An older
`rippling-main` attempt left a 724 MiB temporary pack, which suggests a large or
interrupted initial download, but does not establish the original error.
No speculative authentication or transport changes were made.

Source hashes and the installed-app screenshot are preserved in
`.cache/desktop-work/rebuild-0.1.1-source.json` and
`.cache/desktop-work/installed-0.1.1.png`. Apple signing prerequisites are unchanged.

## Initial build — 2026-11-03, version 0.1.0

The available artifact is an **unsigned Apple Silicon development installer**.
The user confirmed that the team has no Apple signing setup yet. Signed teammate
distribution and the external release checks below remain pending.

## Delivered

- `release/PR-Flow-Review-0.1.0-arm64.dmg` and its `.sha256` file.
- `release/mac-arm64/PR Flow Review.app`.
- Electron 45.2.1, a frozen Python 3.12 analyzer with native Tree-sitter parsers,
  Git 2.56.0 and GitHub CLI 2.103.3 with plaintext credential fallback disabled.
- Stable `app://flow-review` origin and persistent storage; native repository
  picker; existing-account reuse and GitHub device sign-in controls; startup,
  restart and shutdown management; distinct signed/unsigned build commands.
- Full Git corresponding source, CLI source/patch, Python/parser notices and
  linked Go-module license notices included in application resources.

## Checks performed

| Check | Result |
| --- | --- |
| Python suite | 147 tests passed |
| Node regression and desktop suites | 80 tests passed |
| TypeScript and Vite production build | Passed |
| Browser review-workspace regression | Passed; zero real review submissions |
| Browser reader/search regression | Passed |
| Browser draft/review carry-forward regression | Passed; fixture submissions only |
| Patched CLI credential tests | Passed; ordinary/refreshable Keychain failure and insecure storage rejected |
| Frozen Python/TypeScript parser self-test | Passed from staged and packaged runtimes |
| Runtime binary audit | Correct arm64 binaries; no non-system absolute library dependencies; minimum-OS declarations no newer than 13 |
| Bundled Git transport | Public HTTPS fetch, bare snapshot and full-file reads passed with developer PATH removed |
| Packaged Electron smoke | Startup, API broker/body limits, sandbox, IPC rejection, picker, relaunch persistence, restart and quit passed |
| Real process cleanup | A real helper descendant was terminated with its owned process group |
| Device-flow controller | Successful fixture process, cancellation, failure, concurrent requests and cancellation races checked |
| DMG | Built, mounted, checksum verified, SHA-256 file verified |
| Install copy | Copied from DMG to an installation path with spaces; smoke passed with minimal PATH |
| Replacement identity | Relaunched the same profile from another app location; persisted state survived |
| Release without credentials | Refused before packaging with a clear Developer ID prerequisite |

Native smoke used isolated app data and did not initiate a live login or post a
review. An existing macOS Keychain account could be read and reused, even with
an empty CLI config directory. Successful new-account OAuth/Keychain writes were
tested with fixtures rather than changing the user's credentials.

## Review and fixes

A fresh reviewer inspected the desktop, shared runtime changes and release path.
Three material findings were reproduced and fixed:

1. Auth cancellation during status-check cleanup could launch login after cancel.
   Starts are now serialized and recheck the generation after awaiting cleanup.
2. The pinned CLI enables telemetry by default and detaches its sender. Desktop
   subprocesses now force `GH_TELEMETRY=0`, overriding inherited settings.
3. Retry IPC awaited navigation and lost its response context. It now responds
   before background restart/navigation; the rebuilt packaged smoke passes.

No deferred minor findings were reported.

## Implementation decisions

- Work in the existing project with no new plan-approval pause: the user explicitly
  approved the design and asked to build it. All edits remain locally reviewable.
- No worktree or commits: the parent repository has no HEAD and this project's
  files are untracked. Creating a worktree would omit the project; no unrelated
  parent files were staged or committed. Verification records are preserved.
- Detect native hardware under Rosetta: the installed Node is Intel while this
  host, Python and compiler are Apple Silicon. Runtime audit rejects mixed binary
  architectures. Intel artifacts still require their own build/validation runner.
- Use Git's supported C implementation (`NO_RUST`) and stage the builtin dispatcher
  and HTTPS helper only. Public fetch/read tests verify the app's required commands.
- Deliver the unsigned local arm64 artifact now and describe release prerequisites
  explicitly. Without the remaining checks, distribution readiness must not be
  inferred from successful packaging.

## External release checks still required

- Apple Developer enrollment, Developer ID signing and notarization credentials.
- Actual signed/notarized/stapled app and DMG, Gatekeeper assessment and a
  quarantined clean-machine/account installation.
- Intel artifact build and execution on matching hardware/runner.
- Execution on the macOS 13 baseline; binary load-command inspection alone is
  not a substitute for running on that OS.
- A successful new interactive GitHub device login, real Keychain storage failure
  handling, and organization SSO using an authorized test account.

See `docs/macos.md` for installation, source builds and signed release commands.
Detailed local command logs and the execution ledger are under
`.cache/desktop-work/`; they were preserved because this project has no Git
history containing an equivalent execution record.
