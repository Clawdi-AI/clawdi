#!/bin/bash
# GitHub's documented macOS certificate import flow, scoped to one build command.
set +x
set -euo pipefail
umask 077

test "$(uname -s)" = Darwin
: "${RUNNER_TEMP:?A disposable CI runner is required}"
: "${CSC_LINK:?Missing base64 P12 certificate}"
: "${CSC_KEY_PASSWORD:?Missing P12 password}"
test "$#" -gt 0

original_keychains=$(security list-keychains -d user)
keychains=()
while read -r keychain; do
  keychain=${keychain#\"}
  keychain=${keychain%\"}
  if [ -n "$keychain" ]; then keychains+=("$keychain"); fi
done <<< "$original_keychains"

signing_dir=$(mktemp -d "$RUNNER_TEMP/desktop-signing.XXXXXX")
certificate="$signing_dir/certificate.p12"
export CSC_KEYCHAIN="$signing_dir/signing.keychain-db"
created=false
cleanup() {
  result=$?
  trap - EXIT
  security list-keychains -d user -s "${keychains[@]}" || result=1
  if [ "$created" = true ]; then
    security delete-keychain "$CSC_KEYCHAIN" || result=1
  fi
  rm -f "$certificate"
  rmdir "$signing_dir" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

keychain_password=$(openssl rand -hex 32)
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  printf '::add-mask::%s\n' "$keychain_password"
fi
printf '%s' "$CSC_LINK" | base64 --decode > "$certificate"
security create-keychain -p "$keychain_password" "$CSC_KEYCHAIN"
created=true
security set-keychain-settings -lut 21600 "$CSC_KEYCHAIN"
security unlock-keychain -p "$keychain_password" "$CSC_KEYCHAIN"
security import "$certificate" -P "$CSC_KEY_PASSWORD" -t cert -f pkcs12 \
  -k "$CSC_KEYCHAIN" -T /usr/bin/codesign -T /usr/bin/productbuild
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$CSC_KEYCHAIN"
security list-keychains -d user -s "$CSC_KEYCHAIN" "${keychains[@]}"
rm -f "$certificate"
unset CSC_LINK CSC_KEY_PASSWORD keychain_password

"$@"
