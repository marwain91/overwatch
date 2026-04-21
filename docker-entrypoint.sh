#!/bin/sh
# Runtime entrypoint:
#   1. If /var/run/docker.sock is present, detect its GID on the host and ensure
#      the `node` user is a member of a group with that GID. This lets the app
#      read the socket without running as root. Operators can still override
#      with --group-add <gid> and skip this path.
#   2. Drop to the `node` user via su-exec and exec the CMD.
#
# Falls back gracefully: if the socket isn't mounted, just drops to `node`.
set -eu

SOCK=/var/run/docker.sock
if [ -S "$SOCK" ]; then
  SOCK_GID=$(stat -c '%g' "$SOCK")
  if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
    GROUP_NAME=$(getent group "$SOCK_GID" | cut -d: -f1 || true)
    if [ -z "$GROUP_NAME" ]; then
      # Create a host-matching group. `shadow` / `busybox adduser` handle this.
      addgroup -g "$SOCK_GID" dockerhost >/dev/null 2>&1 || groupadd -g "$SOCK_GID" dockerhost >/dev/null 2>&1 || true
      GROUP_NAME=$(getent group "$SOCK_GID" | cut -d: -f1 || true)
    fi
    if [ -n "$GROUP_NAME" ]; then
      addgroup node "$GROUP_NAME" >/dev/null 2>&1 \
        || adduser node "$GROUP_NAME" >/dev/null 2>&1 \
        || usermod -aG "$GROUP_NAME" node >/dev/null 2>&1 \
        || true
    fi
  fi
fi

# Make sure writable paths are owned by node (host mounts can come in as root).
chown -R node:node /app/data 2>/dev/null || true

exec su-exec node "$@"
