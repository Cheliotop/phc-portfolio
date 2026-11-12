#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PHC_ANDROID_ARTIFACT=aab
exec "$ROOT_DIR/scripts/build-production-apk.sh"
