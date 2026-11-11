#!/bin/sh
# Foxdown container entrypoint: pre-flight directory checks, then exec the server.
set -eu

DL="${DOWNLOAD_DIR:-/downloads}"
DT="${DATA_DIR:-/data}"
UID_NOW="$(id -u)"

fail() {
  echo "[entrypoint] ERROR: $1" >&2
  echo "[entrypoint] Hint: on the host run  chown -R $UID_NOW:$UID_NOW <host-dir>  (container user 'foxdown' has uid $UID_NOW)," >&2
  echo "               or fix the volume mount so the directory is writable." >&2
  exit 1
}

for d in "$DL" "$DT"; do
  mkdir -p "$d" 2>/dev/null || fail "cannot create directory $d"
  # real writability test (-w alone can lie on some NAS bind mounts)
  if ! (touch "$d/.foxdown-write-test" 2>/dev/null && rm -f "$d/.foxdown-write-test"); then
    fail "directory $d is not writable by uid $UID_NOW (foxdown)"
  fi
done

echo "[entrypoint] ok: DATA_DIR=$DT DOWNLOAD_DIR=$DL FOXDOWN_HOST=${FOXDOWN_HOST:-0.0.0.0} FOXDOWN_PORT=${FOXDOWN_PORT:-16801}"

exec node /app/server/src/index.js
