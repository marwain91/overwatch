# Development

## Local Development with Docker

All development runs inside Docker containers. No local Node.js installation required.

### Backend

```bash
# Build and run the backend
docker build -t overwatch .

docker run -p 3010:3002 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/overwatch.yaml:/app/overwatch.yaml:ro \
  -v $(pwd)/data:/app/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e GOOGLE_CLIENT_ID=your-client-id \
  --name overwatch-dev \
  overwatch
```

### Frontend (with HMR)

The UI is a React app built with Vite. For development with hot module replacement:

```bash
cd ui

# Install dependencies in Docker
docker run --rm -u "$(id -u):$(id -g)" -v "$(pwd)":/app -w /app node:26-alpine npm ci

# Start Vite dev server with HMR
docker run --rm -u "$(id -u):$(id -g)" -p 5173:5173 \
  -v "$(pwd)":/app -w /app \
  -e API_HOST=host.docker.internal \
  -e API_PORT=3010 \
  node:26-alpine npm run dev -- --host 0.0.0.0
```

The Vite dev server proxies `/api` and `/ws` requests to the backend via `API_HOST`/`API_PORT` environment variables (defaults to `localhost:3010`).

Open `http://localhost:5173` for the UI with live reloading.

### Both Together

1. Start the backend on port 3010 (see above)
2. Start the Vite dev server on port 5173 (see above)
3. Open `http://localhost:5173` — UI changes hot-reload, API calls proxy to the backend

## Building the Docker Image

```bash
# Production build (multi-stage: compiles backend + builds UI)
docker build -t overwatch .

# Run production build
docker run -p 3002:3002 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/overwatch.yaml:/app/overwatch.yaml:ro \
  -v $(pwd)/data:/app/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e GOOGLE_CLIENT_ID=your-client-id \
  overwatch
```

## Building the CLI Binary

The CLI is built with `@yao-pkg/pkg` in SEA mode, embedding stock Node.js
26.13.1 for Linux x64 and arm64. The exact embedded version is independent
of the build container; CI verifies the runtime inside the executable.

```bash
docker run --rm --pull=always -u "$(id -u):$(id -g)" -v "$(pwd)":/app -w /app node:26-bookworm-slim sh -c "npm ci && npm run build:cli"
```

The binaries are written to `dist/bin/overwatch-linux-x64` and
`dist/bin/overwatch-linux-arm64`. Keep the explicit Node.js targets in
`build:cli` current when applying future runtime security updates.

### TypeScript compiler and API

Builds and type checks use TypeScript 7. The UI type generator and its tests
also need the stable TypeScript 6 compiler API, which TypeScript 7 no longer
exports from its package root. Following the upstream migration guidance,
the root package aliases `typescript` to `@typescript/typescript6` and
`@typescript/native` to TypeScript 7. The latter supplies `tsc`; the former
supplies the JavaScript API and `tsc6` without a binary-name conflict.

### Automated dependency updates

Dependabot groups CodeQL actions so `init` and `analyze` always move together.
Docker Node major upgrades are coordinated with the standalone CLI and CI;
digest updates remain automatic. `@types/node` stays on the deployed runtime
major, currently 26. Revisit both rules when moving to the next Node LTS.

## Project Layout

| Directory | Description |
|-----------|-------------|
| `src/` | Backend TypeScript source (Express API, services, CLI) |
| `ui/` | Frontend React app (Vite, Tailwind, React Query, Zustand) |
| `docs/` | Documentation |
| `data/` | Runtime data (gitignored except `.gitkeep`) |

See [Architecture](architecture.md) for the full project structure.

## Key Patterns

- **Config schema**: All Zod schemas in `src/config/schema.ts` use `.describe()` for the `overwatch config docs` command
- **ANSI colors**: Raw escape codes (no chalk dependency) — pattern from `src/cli/init.ts`
- **Async routes**: All Express routes wrapped with `asyncHandler` from `src/utils/asyncHandler.ts`
- **File-based storage**: Admin users, env vars, apps, audit logs stored as JSON/JSONL files in `data/`
- **App-scoped routes**: Tenant, backup, and env var routes are nested under `/api/apps/:appId/`
- **Registry adapters**: Factory pattern in `src/adapters/registry/index.ts` — each app can use a different registry
- **Theme**: CSS custom properties with semantic tokens, toggled via `.dark` class on `<html>`
