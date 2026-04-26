#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
APP_DIR="$ROOT_DIR/notus"
DIST_DIR="$ROOT_DIR/lzc-dist"
BUILD_IMAGE="${LZC_BUILD_IMAGE:-docker.m.daocloud.io/library/node:20-bookworm}"

run_local_build() {
  echo "Preparing Next.js standalone output in Linux amd64 environment..."
  export HOME="${HOME:-$APP_DIR/.tmp-home}"
  export npm_config_cache="${npm_config_cache:-$APP_DIR/.npm-cache}"
  mkdir -p "$HOME" "$npm_config_cache"
  cd "$APP_DIR"
  npm ci
  npm run build

  rm -rf "$DIST_DIR"
  mkdir -p "$DIST_DIR/notus/.next" "$DIST_DIR/lzc"

  cp -R "$APP_DIR/.next/standalone/." "$DIST_DIR/notus/"
  cp -R "$APP_DIR/.next/static" "$DIST_DIR/notus/.next/static"

  if [ -d "$APP_DIR/public" ]; then
    cp -R "$APP_DIR/public" "$DIST_DIR/notus/public"
  fi

  # sqlite-vec resolves its platform binary dynamically, so Next standalone tracing
  # does not always include the optional platform package automatically.
  for sqlite_vec_pkg in \
    "$APP_DIR/node_modules/sqlite-vec-linux-x64" \
    "$APP_DIR/node_modules/sqlite-vec-linux-arm64"
  do
    if [ -d "$sqlite_vec_pkg" ]; then
      cp -R "$sqlite_vec_pkg" "$DIST_DIR/notus/node_modules/"
    fi
  done

  cp "$ROOT_DIR/lzc/run.sh" "$DIST_DIR/lzc/run.sh"
  chmod +x "$DIST_DIR/lzc/run.sh"
  echo "lzc-dist is ready at $DIST_DIR"
}

if [ "${LZC_BUILD_IN_CONTAINER:-0}" != "1" ]; then
  UNAME_S=$(uname -s)
  UNAME_M=$(uname -m)
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "")

  if [ "$UNAME_S" != "Linux" ] || [ "$UNAME_M" != "x86_64" ] || [ "$NODE_MAJOR" != "20" ]; then
    if ! command -v docker >/dev/null 2>&1; then
      echo "This build must run in Linux amd64 with Node.js 20. Install Docker or run inside a matching environment." >&2
      exit 1
    fi

    echo "Host environment is not Linux amd64 + Node.js 20, switching to Docker build: $BUILD_IMAGE"
    exec docker run --rm \
      --platform linux/amd64 \
      --user "$(id -u):$(id -g)" \
      -v "$ROOT_DIR:/workspace" \
      -w /workspace \
      "$BUILD_IMAGE" \
      sh -lc '
        set -eu
        TMP_ROOT=$(mktemp -d)
        trap "rm -rf \"$TMP_ROOT\"" EXIT
        export HOME="$TMP_ROOT/home"
        export npm_config_cache="$TMP_ROOT/.npm-cache"
        mkdir -p "$HOME" "$npm_config_cache"
        mkdir -p "$TMP_ROOT/src"
        tar -C /workspace \
          --exclude=.git \
          --exclude=lzc-dist \
          --exclude=notus/node_modules \
          --exclude=notus/.next \
          --exclude=notus-local-test.lpk \
          -cf - . | tar -C "$TMP_ROOT/src" -xf -
        cd "$TMP_ROOT/src"
        LZC_BUILD_IN_CONTAINER=1 sh lzc/build-package.sh
        rm -rf /workspace/lzc-dist
        mkdir -p /workspace/lzc-dist
        cp -R "$TMP_ROOT/src/lzc-dist/." /workspace/lzc-dist/
      '
  fi
fi

run_local_build
