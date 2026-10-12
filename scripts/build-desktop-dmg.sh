#!/usr/bin/env bash
# Retry only the known hdiutil detach flake, once, using the already packaged app.
# https://github.com/ddnet/ddnet/issues/7545
# hdiutil info -plist / detach -force: https://keith.github.io/xcode-man-pages/hdiutil.1.html
set -euo pipefail

desktop_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../apps/desktop" && pwd)"
cd "$desktop_root"
case "${1:-}" in
	x64) bundle=mac ;;
	arm64) bundle=mac-arm64 ;;
	*) echo 'Usage: build-desktop-dmg.sh x64|arm64' >&2; exit 2 ;;
esac
arch="$1"
retry_root="$(mktemp -d "${TMPDIR:-/tmp}/clawdi-dmg.XXXXXX")"
trap 'rm -rf "$retry_root"' EXIT
hdiutil info -plist > "$retry_root/before.plist"

build_dmg() {
	node "$desktop_root/node_modules/electron-builder/cli.js" \
		--prepackaged "$desktop_root/release/$bundle/Clawdi.app" \
		--mac dmg "--$arch" --publish never
}

status=0
build_dmg 2>&1 | tee "$retry_root/build.log" || status=$?
if (( status == 0 )); then exit 0; fi
if ! grep -Eq 'hdiutil:.*Resource busy' "$retry_root/build.log"; then exit "$status"; fi

echo '::notice::hdiutil reported Resource busy; detach this build’s stale images and retry the DMG once.'
hdiutil info -plist > "$retry_root/after.plist"
# Limit cleanup to newly attached temporary DMGs; leave all pre-existing images alone.
python3 - "$retry_root/before.plist" "$retry_root/after.plist" "${TMPDIR:-/tmp}" <<'PY'
import pathlib
import plistlib
import subprocess
import sys


def images(path):
    with open(path, "rb") as source:
        return plistlib.load(source).get("images", [])


before = {image.get("image-path") for image in images(sys.argv[1])}
temporary = pathlib.Path(sys.argv[3]).resolve()
for image in images(sys.argv[2]):
    path = image.get("image-path", "")
    if not path or path in before:
        continue
    resolved = pathlib.Path(path).resolve()
    if resolved.suffix != ".dmg" or not resolved.is_relative_to(temporary):
        continue
    device = next((entry.get("dev-entry") for entry in image.get("system-entities", [])
                   if entry.get("dev-entry")), None)
    if not device:
        raise SystemExit(f"hdiutil did not report a device for {path}")
    subprocess.run(["hdiutil", "detach", "-force", device], check=True, timeout=30)
PY
build_dmg
