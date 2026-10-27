# Contributing to OSINT Copilot

Thank you for helping improve OSINT Copilot. By contributing, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md) and that your contribution is licensed under Apache-2.0
as described by section 5 of that licence.

For security vulnerabilities, use the private process in [SECURITY.md](SECURITY.md), not an
issue or pull request.

## Prerequisites

- Git
- Node.js 22.x and npm 10 or later
- About 2 GB of free disk space
- Git Bash or WSL when developing on Windows; some npm scripts use POSIX shell syntax

Clone with the public submodules and install the locked dependency tree:

```bash
git clone --recurse-submodules https://github.com/OSINT-Copilot/osint-copilot.git
cd osint-copilot
npm ci
```

If you cloned without `--recurse-submodules`, run `git submodule update --init --recursive`.

## Build and run

```bash
npm run build:tangent-electron
cd apps/tangent-electron
npm run start
```

Use `npm run dev` (`npm run dev:win` from a Windows command shell) for rebuild-on-edit.

The production build bundles and type-checks the whole renderer in one process and needs roughly
6–8 GB of free memory. If it is killed for lack of memory, close other applications or use the
lighter development build (`npm run build:dev`). Raising `--max-old-space-size` does not help:
the limit that is hit is the process's resident memory, not the V8 heap.

Development and test launches use prefixed files in the normal OSINT Copilot profile. To keep
them out of it on Linux, run with `XDG_CONFIG_HOME` pointing at a scratch folder. Do not develop
against your only copy of a sensitive investigation.

## Test

From `apps/tangent-electron`:

```bash
npx vitest run
npm run typecheck:osint
npm run build:dev
npm run test:end-to-end
```

On headless Linux, run the end-to-end suite with:

```bash
xvfb-run -a -s '-screen 0 1920x1080x24' npm run test:end-to-end
```

Install the Playwright Chromium dependencies first when needed:

```bash
npx playwright install --with-deps chromium chromium-headless-shell
```

For the browser extension:

```bash
cd apps/osint-copilot-extension
npm run typecheck
npm test
npm run e2e
```

Rebuild the fictional demo with `npm run demo` in `apps/tangent-electron`. End-to-end tests may
leave `apps/IntegrationTestWorkspace/`; never include generated workspaces or real case data in
a commit.

## Package locally

Run `npm run package:linux`, `npm run package:win`, or `npm run package:mac` in
`apps/tangent-electron`. Output goes to `apps/tangent-electron/dist` and is not published.
Linux RPM packaging requires `rpmbuild`; Windows cross-packaging requires Wine or the project
builder container.

## Project conventions

- Investigation features belong under `src/osint/` or `src/main/osint/` when possible. Keep
  inherited Tangent edits focused and easy to rebase.
- Preserve the distinction between renderer and privileged main-process code. Treat captured
  pages, model output, enrichers, and investigation files as untrusted input.
- Add or update tests for behavior changes.
- Update `Documentation/` for shipped help and `docs/` for repository-facing guidance. Add a
  changelog entry for user-visible changes.
- Use a short, present-tense commit subject that states the behavior.
- Never commit credentials, tokens, private keys, real investigation data, or generated build
  output. Do not force-add an ignored file.

Before opening a pull request, run the relevant tests and complete the pull-request checklist.
Small, focused changes are easier to review and safer to merge from upstream.
