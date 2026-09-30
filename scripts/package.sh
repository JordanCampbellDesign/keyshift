#!/bin/sh
# Builds dist/keyshift-<version>.zip from extension/. The version comes from manifest.json.
set -eu
cd "$(dirname "$0")/.."
version=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
mkdir -p dist
out="dist/keyshift-$version.zip"
rm -f "$out"
(cd extension && zip -q -r -X "../$out" . -x '.DS_Store' -x '*/.DS_Store')
echo "$out"
