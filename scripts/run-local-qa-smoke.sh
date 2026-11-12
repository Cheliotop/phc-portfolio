#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PHC_QA_API_URL="${PHC_QA_API_URL:-http://127.0.0.1:5053}"

echo "Running PHC local QA smoke test against $PHC_QA_API_URL"
echo

node scripts/smoke-local-qa-backend.js
