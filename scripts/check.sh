#!/bin/sh
# Quick checks that run in CI and before a release.
set -eu
cd "$(dirname "$0")/.."
for f in extension/*.js; do
  node --check "$f"
done
python3 -m json.tool extension/manifest.json > /dev/null
# Every icon and page named in the manifest must exist.
python3 - <<'PY'
import json, os
m = json.load(open("extension/manifest.json"))
paths = set(m.get("icons", {}).values()) | set(m.get("action", {}).get("default_icon", {}).values())
paths.add(m["action"]["default_popup"])
paths.add(m["background"]["service_worker"])
missing = [p for p in sorted(paths) if not os.path.exists(os.path.join("extension", p))]
if missing:
    raise SystemExit("Missing files named in manifest.json: " + ", ".join(missing))
print("manifest ok, version", m["version"])
PY
