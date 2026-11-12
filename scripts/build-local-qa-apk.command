#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$DIR/build-local-qa-apk.sh"
echo
echo "Press any key to close..."
read -r -n 1
