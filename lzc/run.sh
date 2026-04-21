#!/bin/sh
set -e

# Ensure data directories exist
mkdir -p "${NOTES_DIR:-/data/notes}"
mkdir -p "${ASSETS_DIR:-/data/notes/.assets}"
mkdir -p "$(dirname "${DB_PATH:-/data/db/notus.db}")"

cd /lzcapp/pkg/content/notus

# Start Next.js standalone server
exec node server.js
