#!/bin/bash
set -e

PACKAGE_NAME="notus"
VERSION=$(node -p "require('./notus/package.json').version")
OUTPUT="notus.lpk"

echo "Building ${PACKAGE_NAME} v${VERSION}..."

# Create staging directory
STAGE=$(mktemp -d)
trap "rm -rf $STAGE" EXIT

# Copy Next.js standalone build
cp -r notus/.next/standalone "$STAGE/notus"
cp -r notus/.next/static "$STAGE/notus/.next/static"
cp -r notus/public "$STAGE/notus/public" 2>/dev/null || true

# Copy deployment scripts
mkdir -p "$STAGE/lzc"
cp lzc/run.sh "$STAGE/lzc/run.sh"
chmod +x "$STAGE/lzc/run.sh"

# Copy manifest
cp lzc-manifest.yml "$STAGE/manifest.yml"

# Create .lpk (tar.gz archive)
tar -czf "$OUTPUT" -C "$STAGE" .

echo "Package created: $OUTPUT ($(du -sh $OUTPUT | cut -f1))"
