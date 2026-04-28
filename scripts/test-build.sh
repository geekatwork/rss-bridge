#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[test-build] Building scraper..."
npm run -w packages/scraper build

echo "[test-build] Building feed-generator..."
npm run -w packages/feed-generator build

echo "[test-build] Build checks passed"
