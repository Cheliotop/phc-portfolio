#!/usr/bin/env bash
set -euo pipefail

# Build the signed Supabase-only Android release. This wrapper deliberately has
# no debug-key fallback and no reference to the retired Express backend. Set
# PHC_ANDROID_ARTIFACT=aab to produce the Play Store bundle instead of an APK.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/PHC_Mobile/phc-native"
LOG_DIR="$ROOT_DIR/.local/logs"
SIGNING_ENV="$MOBILE_DIR/secrets/android-signing.env"
EXPECTED_SIGNING_CERT_SHA256="99510cbd5939df667db3ff69500d31fa526425e714a4fdc53957947bbceaebd0"

if [ -z "${PHC_UPLOAD_STORE_FILE:-}" ] ||
   [ -z "${PHC_UPLOAD_STORE_PASSWORD:-}" ] ||
   [ -z "${PHC_UPLOAD_KEY_ALIAS:-}" ] ||
   [ -z "${PHC_UPLOAD_KEY_PASSWORD:-}" ]; then
  if [ ! -f "$SIGNING_ENV" ]; then
    echo "ERROR: Android signing variables are missing and $SIGNING_ENV was not found."
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$SIGNING_ENV"
fi

# Refuse to produce an artifact with a historical or newly generated key. Android
# updates require the exact certificate already used by every PHC release.
actual_signing_cert_sha256="$({
  keytool -list -v \
    -keystore "$PHC_UPLOAD_STORE_FILE" \
    -storepass "$PHC_UPLOAD_STORE_PASSWORD" \
    -alias "$PHC_UPLOAD_KEY_ALIAS" 2>/dev/null || true
} | awk '/SHA256:/ { print $2; exit }' | tr -d ':' | tr '[:upper:]' '[:lower:]')"
if [ "$actual_signing_cert_sha256" != "$EXPECTED_SIGNING_CERT_SHA256" ]; then
  echo "ERROR: Refusing to build with a signing certificate that does not match PHC production."
  exit 1
fi

if [ -z "${PHC_VERSION_CODE:-}" ] || [ -z "${PHC_VERSION_NAME:-}" ]; then
  echo "ERROR: Set a new PHC_VERSION_CODE and PHC_VERSION_NAME for this release."
  echo "Example: PHC_VERSION_CODE=19 PHC_VERSION_NAME=2.0.17 scripts/build-production-apk.sh"
  exit 1
fi

unset EXPO_PUBLIC_API_URL PHC_ALLOW_INSECURE_API_URL PHC_USES_CLEARTEXT_TRAFFIC
export PHC_RELEASE_LABEL="${PHC_RELEASE_LABEL:-v${PHC_VERSION_NAME}-vc${PHC_VERSION_CODE}}"

# Crash reports read the app version from the embedded Expo config and the build
# number from Android's native manifest. Keep those two sources aligned. The old
# shell-injected EXPO_PUBLIC values compiled to `undefined` in v2.0.40 even
# though Gradle received the same environment, silently labelling every report
# as `dev`.
configured_version="$(node -p "require('${MOBILE_DIR}/app.json').expo.version")"
if [ "$configured_version" != "$PHC_VERSION_NAME" ]; then
  echo "ERROR: app.json version ($configured_version) must match PHC_VERSION_NAME ($PHC_VERSION_NAME)."
  exit 1
fi

export NODE_ENV=production

case "${PHC_ANDROID_ARTIFACT:-apk}" in
  apk)
    BUILD_COMMAND="build:android:release"
    ;;
  aab)
    BUILD_COMMAND="build:android:bundle"
    ;;
  *)
    echo "ERROR: PHC_ANDROID_ARTIFACT must be 'apk' or 'aab'."
    exit 1
    ;;
esac

mkdir -p "$LOG_DIR"
cd "$MOBILE_DIR"

{
  echo "Building signed PHC Android release ${PHC_VERSION_NAME} (${PHC_VERSION_CODE})"
  echo "Output: $ROOT_DIR/releases"
  npm run "$BUILD_COMMAND"
} 2>&1 | tee "$LOG_DIR/build-production-android.log"
