#!/usr/bin/env sh
set -eu

echo "Stopping Portfel GPW..."
docker compose down
echo "Rebuilding Portfel GPW..."
docker compose build
echo "Starting Portfel GPW..."
docker compose up -d
docker compose ps
