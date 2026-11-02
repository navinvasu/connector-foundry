#!/bin/bash
# Local dev boot for the Connector Foundry API server.
# Prerequisites: PostgreSQL up — `docker compose up -d` in projects/connector-foundry/backend
# (or any Postgres reachable at DATABASE_URL). The schema applies automatically on boot.
set -e
cd "$(dirname "$0")"
# Install dependencies if node_modules is missing or stale (first run, or a
# pull that changed package.json / package-lock.json). Fixes the classic
# "Cannot find package 'dotenv'" boot failure after git pull.
if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "Dependencies are missing or out of date — running npm install…"
  npm install
fi
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/connector_foundry}"
# Dev auth is explicit since SE-07 (default OFF everywhere; production
# refuses to boot with it). Personas (x-dev-as) only work because of this.
export CF_DEV_AUTH=true
exec npx tsx watch src/index.ts
