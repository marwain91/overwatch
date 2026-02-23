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
| `DEPLOY_DIR` | Auto-detected from CLI location | Path to the deployment directory |
| `SERVICE_NAME` | `overwatch` | Docker Compose service name to restart |
| `IMAGE` | `ghcr.io/marwain91/overwatch:latest` | Image to pull and check |

Example with overrides:

```bash
DEPLOY_DIR=/opt/myapp/deploy/overwatch SERVICE_NAME=admin overwatch update
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
