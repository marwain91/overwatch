# Updating

## Updating the Docker Image

Use the CLI to pull the latest Overwatch image and restart:

```bash
overwatch update
```

This pulls the latest image, compares digests, and recreates the container if an update is available.

To check for updates without applying:

```bash
overwatch update --check
```

### Environment Overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPOSE_DIR` | Current working directory | Path to the directory containing `docker-compose.yml` |
| `SERVICE_NAME` | `overwatch` | Docker Compose service name to restart |
| `IMAGE` | `ghcr.io/marwain91/overwatch:latest` | Image to pull and check |

Example with overrides:

```bash
COMPOSE_DIR=/opt/myapp/deploy SERVICE_NAME=admin overwatch update
```

## Updating the CLI Binary

Update the `overwatch` CLI itself to the latest release:

```bash
overwatch self-update
```

To check for a new CLI version without applying:

```bash
overwatch self-update --check
```

The self-update downloads the latest release from GitHub and atomically replaces the current binary. Supports both x64 and arm64 architectures.

## Alternative: Shell Script

If you don't have the CLI installed, you can update the Docker image via the bundled shell script:

```bash
./scripts/update.sh
```

Check-only mode:

```bash
./scripts/update.sh --check
```

The script accepts the same environment overrides (`COMPOSE_DIR`, `SERVICE_NAME`, `IMAGE`) as the CLI.
