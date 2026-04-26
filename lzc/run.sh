#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
CONTENT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
APP_DIR="$CONTENT_DIR/notus"
CACHE_DIR="${CACHE_DIR:-/lzcapp/cache/notus}"
NOTES_DIR="${NOTES_DIR:-/lzcapp/var/notes}"
ASSETS_DIR="${ASSETS_DIR:-/lzcapp/var/assets}"
DB_PATH="${DB_PATH:-/lzcapp/var/data/index.db}"
PORT="${PORT:-3000}"
NODE_ENV="${NODE_ENV:-production}"

[ -f "$APP_DIR/server.js" ] || {
  echo "Missing Next.js standalone server at $APP_DIR/server.js" >&2
  exit 1
}

mkdir -p "$CACHE_DIR"
mkdir -p "$NOTES_DIR"
mkdir -p "$ASSETS_DIR"
mkdir -p "$(dirname "$DB_PATH")"

# Next.js standalone will bind to process.env.HOSTNAME when present.
# Lazycat injects HOSTNAME as the container hostname, which breaks 127.0.0.1 health checks.
export HOSTNAME=0.0.0.0
export HOST=0.0.0.0

cd "$APP_DIR"
exec node server.js
