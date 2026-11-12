#!/usr/bin/env bash
set -euo pipefail

# Build the emulator/local-Supabase flavor. The validator requires an explicit
# .env.local with EXPO_PUBLIC_PHC_LOCAL_QA=true and a loopback emulator URL.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/PHC_Mobile/phc-native"
LOG_DIR="$ROOT_DIR/.local/logs"

unset EXPO_PUBLIC_API_URL PHC_UPLOAD_STORE_FILE PHC_UPLOAD_STORE_PASSWORD
unset PHC_UPLOAD_KEY_ALIAS PHC_UPLOAD_KEY_PASSWORD
mkdir -p "$LOG_DIR"
cd "$MOBILE_DIR"

if [[ ! -f .env.local ]]; then
  echo "[local-qa-build] Missing $MOBILE_DIR/.env.local" >&2
  exit 1
fi

# The validator runs as plain Node before Expo has a chance to load dotenv.
# Export the ignored local-QA file into this process without logging its key.
set -a
# shellcheck disable=SC1091
source .env.local
set +a
export NODE_ENV=production

{
  echo "Building PHC Android local-QA APK against explicit local Supabase config"
  echo "Output: $ROOT_DIR/releases"
  npm run build:android:local-qa
} 2>&1 | tee "$LOG_DIR/build-local-qa-apk.log"
