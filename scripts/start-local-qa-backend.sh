#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/PHC_Backend/backend"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/.local/qa-backend-current}"

PORT="${PORT:-5053}"
HOST="${HOST:-0.0.0.0}"

mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/backups"

cd "$BACKEND_DIR"

export NODE_ENV=development
export HOST
export PORT
export JWT_SECRET="${JWT_SECRET:-local-qa-secret-change-me-32-characters}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-http://localhost:8081,http://localhost:3000,http://127.0.0.1:8081}"
export DATABASE_PATH="$DATA_DIR/database.sqlite"
export DRILLING_DATABASE_PATH="$DATA_DIR/drilling_management.sqlite"
export BACKUP_PATH="$DATA_DIR/backups"
export UPLOADS_PATH="$DATA_DIR/uploads"
export DEFAULT_ADMIN_USERNAME="${DEFAULT_ADMIN_USERNAME:-admin}"
export DEFAULT_ADMIN_EMAIL="${DEFAULT_ADMIN_EMAIL:-admin@phc.local}"
export DEFAULT_ADMIN_PASSWORD="${DEFAULT_ADMIN_PASSWORD:-admin123}"

echo "PHC local QA backend"
echo "URL: http://localhost:$PORT"
echo "LAN: http://<this-computer-ip>:$PORT"
echo "Data: $DATA_DIR"
echo "Admin: $DEFAULT_ADMIN_USERNAME / $DEFAULT_ADMIN_PASSWORD"
echo

npm start
