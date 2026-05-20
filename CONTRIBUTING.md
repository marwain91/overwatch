# Contributing to Overwatch

Thanks for your interest! This guide covers how to get a working dev environment, the test/build workflow, and conventions for PRs.

## Quick start

```bash
git clone https://github.com/marwain91/overwatch.git
cd overwatch
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/workspace -w /workspace node:26-alpine npm ci
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/workspace -w /workspace node:26-alpine npm test
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/workspace -w /workspace node:26-alpine npm run build
```

All project commands should run in Docker. The examples use `node:26-alpine`, matching the production Dockerfile. No host Node.js installation is required.

## Project layout

- `src/cli.ts` — CLI entry point
- `src/cli/` — CLI command implementations
- `src/config/` — Zod schemas and config loading
- `src/services/` — domain logic
- `src/__tests__/` — Vitest test suite
- `ui/` — React admin UI (separate `package.json`)
- `data/apps.d/` — declarative app definitions

## Development workflow

1. Create a branch off `main` (`fix/...`, `feat/...`, `docs/...`).
2. Make changes and add tests. Run `npm test` in the Docker command above until green.
3. Run `npm run build` in Docker to verify the TypeScript build still passes.
4. Open a pull request against `main` with a clear description.

For UI work:

```bash
cd ui
docker run --rm -u "$(id -u):$(id -g)" -p 5173:5173 \
  -v "$PWD":/workspace -w /workspace node:26-alpine npm ci
docker run --rm -u "$(id -u):$(id -g)" -p 5173:5173 \
  -v "$PWD":/workspace -w /workspace node:26-alpine npm run dev -- --host 0.0.0.0
```

## Commit and PR conventions

Commit messages follow Conventional Commits where it's natural:

- `feat(scope): ...` — new functionality
- `fix(scope): ...` — bug fixes
- `chore(scope): ...` — tooling, deps, hygiene
- `docs: ...` — documentation only

Keep PRs focused. One concern per PR makes review easier and bisects cleaner.

## Releases

Releases are tagged from `main` (`vX.Y.Z`). The `Release` GitHub Actions workflow builds the Docker image and CLI binaries and publishes them. Bump `package.json` `version` to match the tag before tagging.

## Reporting bugs

Please use the [issue templates](https://github.com/marwain91/overwatch/issues/new/choose). For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.
