#!/bin/sh
# Runtime entrypoint. Runs as root only long enough to:
#   1. Pick a runtime UID/GID (operator env > data-dir owner > node default 1000).
#   2. Remap the image's `node` user to that UID/GID so su-exec hits the right one.
#      If another user/group already holds that UID/GID, use the existing name.
#   3. Ensure the runtime user can reach /var/run/docker.sock by joining the
#      socket's group (GID varies across hosts).
#   4. chown /app/data so first-boot writes succeed.
#   5. su-exec CMD as the chosen user.
#
# Operator-facing contract:
#   OVERWATCH_UID / OVERWATCH_GID  — explicit pin. Use when you have a dedicated
#                                    service user on the host and want all tenant
#                                    files / data owned by it.
#   (unset)                        — entrypoint auto-detects from /app/data's
#                                    owner, so mounting a host dir with the
#                                    "right" ownership is enough; no env needed.
set -eu

target_uid=""
target_gid=""

if [ -n "${OVERWATCH_UID:-}" ]; then
  target_uid="$OVERWATCH_UID"
elif [ -d /app/data ]; then
  target_uid=$(stat -c '%u' /app/data)
fi
target_uid=${target_uid:-1000}

if [ -n "${OVERWATCH_GID:-}" ]; then
  target_gid="$OVERWATCH_GID"
elif [ -d /app/data ]; then
  target_gid=$(stat -c '%g' /app/data)
fi
target_gid=${target_gid:-1000}

# Remap the runtime group. If another group already holds $target_gid,
# reassign node's primary group to it; otherwise shift node's group GID.
current_gid=$(id -g node)
if [ "$current_gid" != "$target_gid" ]; then
  if getent group "$target_gid" >/dev/null 2>&1; then
    existing_group=$(getent group "$target_gid" | head -n 1 | cut -d: -f1)
    usermod -g "$existing_group" node >/dev/null 2>&1 || true
  else
    groupmod -g "$target_gid" node >/dev/null 2>&1 || true
  fi
fi

# Remap the runtime user. If another user already holds $target_uid,
# su-exec as that existing user instead of remapping.
current_uid=$(id -u node)
runtime_user="node"
if [ "$current_uid" != "$target_uid" ]; then
  if getent passwd "$target_uid" >/dev/null 2>&1; then
    runtime_user=$(getent passwd "$target_uid" | head -n 1 | cut -d: -f1)
  else
    usermod -u "$target_uid" node >/dev/null 2>&1 || true
  fi
fi

# Docker socket access: join the socket's group so the runtime user can hit
# dockerode without being root. GID is host-dependent.
SOCK=/var/run/docker.sock
if [ -S "$SOCK" ]; then
  sock_gid=$(stat -c '%g' "$SOCK")
  if [ -n "$sock_gid" ] && [ "$sock_gid" != "0" ]; then
    sock_group=$(getent group "$sock_gid" 2>/dev/null | head -n 1 | cut -d: -f1 || true)
    if [ -z "$sock_group" ]; then
      addgroup -g "$sock_gid" dockerhost >/dev/null 2>&1 \
        || groupadd -g "$sock_gid" dockerhost >/dev/null 2>&1 || true
      sock_group=$(getent group "$sock_gid" 2>/dev/null | head -n 1 | cut -d: -f1 || true)
    fi
    if [ -n "$sock_group" ] && [ "$sock_group" != "$(id -gn "$runtime_user")" ]; then
      addgroup "$runtime_user" "$sock_group" >/dev/null 2>&1 \
        || adduser "$runtime_user" "$sock_group" >/dev/null 2>&1 \
        || usermod -aG "$sock_group" "$runtime_user" >/dev/null 2>&1 \
        || true
    fi
  fi
fi

# chown data dir — a host mount from a freshly-created directory often arrives as
# root:root. Only touch /app/data because apps/ lives under a different (operator-
# managed) host path and will already be chowned by the operator.
chown -R "$target_uid:$target_gid" /app/data 2>/dev/null || true

echo "[entrypoint] runtime user=${runtime_user} uid=${target_uid} gid=${target_gid}"
exec su-exec "$runtime_user" "$@"
