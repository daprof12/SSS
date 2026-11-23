#!/bin/sh
# Container start on hosts without a pre-deploy step (Render free plan): migrate, then run the API.
set -e
node scripts/migrate.mjs
exec node apps/api/dist/main.js
