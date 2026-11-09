# PR Flow Review for macOS

Status: approved by the user and implemented for Apple Silicon. See `docs/qa-macos.md` for verification evidence and remaining external release validation. The team has no Apple signing setup yet; the available installer is an unsigned development build.

## Intent and confirmed requirements

The user wants PR Flow Review to become a Mac app that teammates can install.
The existing project is a local React/Vite application served by a Python
backend. It analyzes immutable Git snapshots and can submit explicitly reviewed
GitHub comments. Preserve those capabilities and the local processing model.

The installation experience should be: download a DMG, drag PR Flow Review to
Applications, open it, sign into GitHub when needed, and paste a PR URL. A local
checkout is optional. There is no requirement to install developer tools.

Only teammate installation is confirmed by the user. The remaining decisions
below are proposed implementation defaults, not previously approved choices.

## Proposed scope and defaults

- Use Electron with the existing React frontend and Python analyzer.
- Ship separate Apple Silicon and Intel DMGs. Target macOS 13 or later, subject
  to confirming support in the pinned Electron and bundled runtime versions.
- Bundle Python, its dependencies including Tree-sitter native extensions, Git,
  and GitHub CLI. Do not require Node, Python, uv, Homebrew, Git, GitHub CLI, or
  Xcode Command Line Tools on the recipient's machine.
- Distribute directly to teammates, outside the Mac App Store. Public/team
  releases must be Developer ID signed, notarized, and stapled. Developer builds
  may be unsigned but must be clearly labeled unsuitable for normal distribution.
- Keep the current browser development/start commands working.
- Updates initially mean downloading a replacement app. Keep the same bundle ID,
  storage identity, and data paths across versions. Automatic updates are deferred.
- Limit GitHub support to github.com, matching the current URL validation.
- Keep analysis, repositories, drafts, and receipts local. Analysis and sign-in
  necessarily contact GitHub. Add no telemetry or cloud analysis service.

## User experience

The app opens one main review window with the existing reader, inventory,
relationships, and drafts. Launching a second copy focuses the running app.
Closing its window follows normal macOS behavior; reopening from the Dock shows
the window. Quit ends its backend and any owned authentication/analysis processes.

A startup view appears while the backend starts. Backend errors offer a retry
and a way to locate a sanitized diagnostic log. Unexpected backend exit preserves
saved drafts and allows restart; it must not silently replay review submissions.

On first launch, check GitHub authentication using the bundled GitHub CLI. Reuse
the user's existing GitHub CLI account if usable. Otherwise offer a Sign in to
GitHub action that starts GitHub CLI's browser/device flow. Display the short
user code and verification link when needed; open only the validated GitHub
verification URL in the default browser. Cancellation, expired codes, denied
authorization, network errors, organization SSO, and insufficient repository
access receive actionable messages and retry controls. No token entry in React.

Authentication intentionally uses GitHub CLI's normal credential configuration
and macOS Keychain. Explain that the account is shared with GitHub CLI when
installed separately. Do not provide account switching/logout in this version,
run global Git configuration changes, or delete CLI credentials. Login may update
the standard GitHub CLI account configuration. Do not use insecure token-storage
flags or persist a plaintext credential fallback; surface a recoverable error if
Keychain storage cannot be established. The installed CLI's help explicitly says
it can fall back to plaintext. Proposed builder decision: build the bundled CLI
from pinned source with a minimal patch that makes that fallback an error, and
include the patch and reproducible source-build instructions. Do not assume a
preflight Keychain check alone prevents a later write failure. Validate this
behavior before shipping the flow; existing user credential files are not deleted.

The local checkout field gains a native directory picker. Keep manual path entry
available and remember the last directory selected. For packaged mode, do not
search the application bundle's parent or an arbitrary launch working directory
for checkouts; use an explicitly selected matching repository, otherwise the
app-managed snapshot cache. Existing origin validation still applies.

PR links open in the default browser. Review submission keeps its existing
preview and explicit Submit action. Startup, login, and analysis never post a
review. The shipped PR input is blank; do not distribute the developer's prefilled
private repository example as an initial value.

## Runtime architecture

Electron owns the Python backend as a subprocess. Freeze it using PyInstaller
in one-directory mode, with native libraries collected explicitly, built on the
matching Mac architecture. Keep executable resources outside app.asar. Package
all non-system Git runtime libraries and helper programs needed for HTTPS fetch;
package the GitHub CLI executable and required runtime resources. The installed
app must run from a path containing spaces without shell interpolation.

Set an explicit child environment and bundled-tool search path so Finder launch
works without shell initialization. Use argument arrays rather than shell command
strings. Clear inherited token overrides such as GH_TOKEN and GITHUB_TOKEN for
the desktop credential flow; pin GH_HOST to github.com. Do not change the user's
shell environment or Git configuration. Existing Git credential-helper invocation
must resolve the bundled gh, including when git launches it as a helper.

Use an OS-assigned loopback port instead of reserving 8765. The backend emits a
structured readiness record on stdout after binding; Electron validates it and
waits for an authenticated health response before showing the review UI. Limit
startup waits and cap logged output. Termination must include owned descendant
processes and be verified during slow fetches and pending login, with a bounded
grace period before forced termination. Do not signal unrelated processes.

The renderer uses a stable application origin, app://flow-review, registered as
a standard secure Electron protocol. Serve only built frontend assets and proxy
allowlisted /api paths to this instance's backend in the main process. Preserve
the current relative fetch URLs. Use one persistent Electron session partition,
so changing backend ports does not lose localStorage drafts or progress.

The backend gets a cryptographically random per-launch API secret over inherited
process state, never URLs or logs. Desktop-mode API requests require that secret,
including health and reads, in addition to existing loopback host/origin checks.
Electron adds the secret to proxied requests; the renderer never receives it.
Proxy requests use the actual loopback Host and a trusted loopback origin. Do not
broaden the backend's allowed origins to accept arbitrary custom or null origins.
Browser mode retains its existing host/origin restrictions and behavior.

Use context isolation and renderer sandboxing, disable Node integration, keep a
restrictive Content Security Policy, and expose only narrow preload operations
for directory selection, authentication status/start/cancel, and diagnostics.
Validate the sender origin and main frame for privileged IPC, and validate all
arguments. Block in-app remote navigation/new windows and open only explicitly
allowed HTTPS GitHub links externally. Protocol handling rejects unexpected
hosts, traversal, symlinks escaping the static root, unknown API routes, and
unsupported methods. Preserve backend request-body limits and response statuses.

Login is managed by the main process through the bundled CLI, with a finite
timeout and cancellation. The implementation must explicitly test browser launch
and the device-code presentation with the pinned CLI, rather than assuming its
human-readable output is a stable machine protocol. Do not send captured tokens,
full CLI credential files, or raw authentication diagnostics to the renderer.

## Storage and migration

Use stable macOS locations outside the application bundle:

- Application Support/PR Flow Review: Electron user data, preferences, persistent
  renderer storage, review submission receipts and full-file analysis descriptors.
- Caches/PR Flow Review: fetched repositories and regenerable analysis results.
- Logs/PR Flow Review: bounded and rotated diagnostic logs without credentials,
  source contents, review comment bodies, or full API payloads.

Separate immutable packaged resource paths from configurable writable backend
paths. backend/github.py currently derives PROJECT and CACHE from __file__,
backend/server.py serves PROJECT/dist, and reviews/files share the cache root.
Introduce a small runtime configuration layer and route all these consumers
through it, retaining their current browser-mode defaults. Receipts and descriptors
must not accidentally move into an expendable OS cache. An app replacement must
preserve drafts, progress, preferences, and receipts.

Existing browser localStorage cannot be automatically read by Electron. Browser
draft/progress migration is deferred; document that the desktop app starts with
separate saved state and that existing drafts remain in the original browser.
The current project .cache is not automatically imported or deleted.

## Packaging and release

Use electron-builder for app/DMG packaging, a stable bundle identifier chosen in
the implementation plan, and native per-architecture backend/tool staging.
Pin Electron, packaging tools, runtime/tool versions and downloads, verify archive
checksums, and include required dependency license notices and Git source-access
information. Avoid runtime downloads on teammates' first launch.

Build release artifacts on macOS for each target architecture. Release commands
must distinguish local unsigned builds from signed distribution builds and fail
closed when signing/notarization credentials are absent. Sign nested executables
and native libraries correctly with the hardened runtime and only the entitlements
actually needed by Electron and its bundled executables. Notarize, staple, verify
signatures and Gatekeeper assessment, and publish checksums with artifacts.

Signing requires the user's/team's Apple Developer membership, Developer ID
certificate, and notarization access. Those credentials have not been provided.
Implement local build/validation without them; do not claim a teammate-ready
signed release until that external release prerequisite is satisfied. Do not
publish artifacts, configure a new release host, or add secrets to source control.
Provide a documented release command and output directory; the team chooses the
download destination later. There is currently no standalone Git repository or
release remote for this project, so repository/CI hosting is outside this change.

## Verification and acceptance

1. Existing Python tests, frontend build, Node regression tests and relevant browser
   regression checks pass after shared backend/frontend changes.
2. Desktop tests cover startup timeout/crash/retry, single-instance behavior,
   protocol and IPC boundaries, absent/invalid backend secrets, directory selection,
   external navigation, and shutdown during active subprocess work.
3. An installed build launches without terminal shell configuration, developer
   runtimes, Homebrew, or Command Line Tools. Confirm Python parsing, JS/TS parsing,
   private GitHub metadata access and HTTPS snapshot fetch using bundled tools.
4. Login succeeds, cancels and retries correctly; organization SSO errors remain
   actionable; credentials are stored securely and never appear in logs/UI storage.
5. Review a fixture, save drafts/progress, quit/relaunch, change the loopback port,
   and replace the app with a newer build: saved state and receipts remain intact.
6. Test review posting only against an explicitly authorized disposable PR; all
   other validation uses fixtures/mocked GitHub responses. Do not post to a user's
   real PR merely to validate packaging. Preserve ambiguous-submission recovery.
7. Quit leaves no owned backend, login, Git, or helper processes running. Launch
   and fetch succeed from an installed path with spaces, with no local checkout.
8. For distribution, both architecture artifacts pass actual launch/runtime checks
   on matching hardware or runners, signing verification, notarization/stapling,
   Gatekeeper assessment, and a quarantined clean-machine/account installation.
   Document any checks unavailable in the current environment; never treat a
   successful packaging command as evidence that those checks passed.

## Explicitly deferred

Mac App Store distribution, Windows/Linux, auto-updates, account management UI,
GitHub Enterprise, browser-state import, AI features, analyzer rewrites, remote
processing, and changes to review semantics.

## Builder review

A fresh desktop software reviewer read this design and reported "nothing
important left" to answer before planning. A subsequent CLI help check confirmed
the documented plaintext fallback; the explicit fail-closed CLI build decision
above resolves it without asking the user to choose an implementation detail.

## Left to the builder

Exact supported dependency versions, stable bundle identifier, app icon derived
from the existing mark, source file organization, test harness choice, build-cache
layout, and timeout values. Confirm chosen runtime versions support the stated
macOS baseline. Any discovery that requires external setup on the recipient's
machine or plaintext credential storage changes this design and must be surfaced.
