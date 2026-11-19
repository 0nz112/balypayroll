#!/usr/bin/env bash
# Offline demo build (no npm install needed when deps are available on NODE_PATH).
# Production builds use:  npm run build   (Vite)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-build-demo}
rm -rf "$OUT" && mkdir -p "$OUT/assets"
esbuild src/main.jsx --bundle --minify --splitting --format=esm --target=es2020 --outdir="$OUT/assets" --entry-names=app --chunk-names=chunk-[hash] \
  --jsx=automatic --loader:.js=jsx \
  '--define:import.meta.env={"VITE_DEMO_MODE":"true","DEV":false}' --define:process.env.NODE_ENV='"production"' --legal-comments=none
cp -r public/* "$OUT/"
sed -e 's#<script type="module" src="/src/main.jsx"></script>#<link rel="stylesheet" href="./assets/app.css" /><script type="module" src="./assets/app.js"></script>#' index.html > "$OUT/index.html"
echo "built $OUT"
