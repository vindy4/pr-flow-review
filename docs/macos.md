# PR Flow Review for macOS

Download the DMG matching your Mac (Apple Silicon or Intel), open it and drag
**PR Flow Review** to **Applications**. Open the app, sign in to GitHub if prompted,
and paste a pull request URL. macOS 13 or later is the target baseline.

The app includes Python, the parsers, Git and GitHub CLI. Recipients do not need
Node, Python, uv, Homebrew, Git, GitHub CLI or Xcode Command Line Tools.

## GitHub and local data

An existing GitHub CLI login is reused. Otherwise **Sign in to GitHub** opens
GitHub's browser/device authorization. Enter the code shown in the app. GitHub
CLI stores credentials in macOS Keychain and shares its account with a separately
installed GitHub CLI. The bundled build disables plaintext credential fallback.
Sign-in can update the standard GitHub CLI account configuration. Account
switching/logout is intentionally not exposed. For organization repositories,
authorize the GitHub CLI OAuth application for organization SSO when required.
The OAuth consent page identifies GitHub CLI, which is the bundled login client.

Leave the checkout field blank to fetch pinned snapshots into the app's own
cache, or select an existing matching Git repository under Advanced options.
Analysis does not switch branches or edit repository files. Reviews are posted
only by the existing explicit submission action and require repository permission.

App-managed snapshots fetch commit/tree metadata first, then download selected
source blobs in batches after checking their sizes through GitHub. Indexing keeps
the existing limits of 2,000 file paths, 1 MiB per file and 32 MiB per snapshot.
Modified-rename detection has a separate bounded content pass (up to 2,000
candidates and 32 MiB per side); larger modified renames appear as added/removed.
Exact renames need no file downloads. The managed cache uses HTTPS and the bundled
GitHub CLI credentials independently of user Git URL rewrites. Explicit local
checkouts retain their normal Git configuration.

- Durable data: `~/Library/Application Support/PR Flow Review/`
- Regenerable cache: `~/Library/Caches/PR Flow Review/`
- Bounded diagnostic logs: `~/Library/Logs/PR Flow Review/`

Replacing the app preserves drafts, progress and receipts. Existing browser
drafts are separate; migration from the browser is not included. No cloud
analysis or telemetry is added. GitHub access requires a network connection.

If the engine stops, choose **PR Flow Review → Restart Review Engine**, or use
the restart button. **Show Diagnostic Log** locates a log of lifecycle events;
it contains no source text, review bodies or credentials. Never resubmit an
ambiguous review before using the existing receipt confirmation flow.

## Build from source

Build on a Mac matching the target hardware. Apple Silicon builders may have an
Intel Node installation under Rosetta; the build detects native hardware and
checks every bundled Mach-O binary. Intel artifacts need an Intel build runner.

Build dependencies: Node 22.12+ (24 recommended), npm, uv, Python 3.12, Go (its
automatic toolchain download must support the version in the pinned CLI go.mod),
Xcode Command Line Tools including Swift/make, curl and tar. These are required
only on the build machine.

```sh
npm ci
npm run desktop:prepare
npm run desktop:dev
# Unsigned development DMG, explicitly not a normal teammate distribution:
npm run desktop:build
```

Outputs are under `release/`. Runtime preparation verifies pinned source archive
checksums in `scripts/desktop/sources.json`, builds Git against macOS system
libraries, applies the checked GitHub CLI credential-storage patch, runs its
regression tests, freezes the Python backend, and audits runtime architectures
and dynamic libraries. Build logs and staging are under `.cache/desktop-build/`
and `.cache/desktop-runtime/`. Build steps can download pinned source, Python and
Go dependencies; the installed app never installs runtime dependencies.

The Git source is built without modifications. Its complete corresponding source
and the CLI source/patch are included in the application at
`Contents/Resources/runtime/sources/`. Rebuild using the pinned sources and
`scripts/desktop/prepare.cjs` from the project. Third-party notices accompany the
app; Electron includes its Chromium notices. Do not delete corresponding source
archives when redistributing the application.

To regenerate the icon, run `swift scripts/desktop/icon.swift output.png`, create
a standard macOS `.iconset` with scaled sizes, then use `iconutil -c icns`.

## Signed distribution release

An unsigned developer build is useful locally. A release for teammates requires
Apple Developer Program membership and a Developer ID Application certificate.
Configure these environment variables in a secure local shell or CI secret store:

- `CSC_LINK`: certificate export path (or electron-builder-supported certificate value).
- `CSC_KEY_PASSWORD`: certificate password.
- `APPLE_API_KEY`: absolute path to the App Store Connect `.p8` key.
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`: API key ID and issuer UUID.

```sh
npm run desktop:release
```

Release mode refuses to proceed without credentials. It signs with the hardened
runtime, notarizes/staples the app, submits the DMG for notarization, staples and
validates its ticket, assesses the app with Gatekeeper, and creates SHA-256 files.
No artifacts are uploaded to a release host by this command. Share only after
testing the signed artifact as a quarantined download on a clean machine/account.
Test both architectures on matching hardware/runners and verify macOS 13 support.
Replacing the application is the initial update mechanism; auto-updates are deferred.

## Verification

```sh
UV_CACHE_DIR=.cache/uv uv run python -m unittest discover -s tests
node --test tests/*.cjs tests/desktop/*.test.cjs
npm run build
npm run desktop:smoke
# Browser regressions use Playwright's Chromium; install a matching browser if needed:
PLAYWRIGHT_BROWSERS_PATH=.cache/browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=.cache/browsers node tests/browser/review-workspace.cjs
```

The desktop smoke test uses a temporary app profile and an installed local build.
It must not log in, change existing credentials or post comments to a real PR.
Hardware-specific, live login, signed Gatekeeper and clean-machine results must
be recorded separately from automated fixture tests.
