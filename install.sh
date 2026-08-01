#!/bin/sh
set -eu

SCHEMA='clawdi.nativeRelease.v1'
MANIFEST_NAME='clawdi-cli-manifest.txt'
MAX_MANIFEST_BYTES=65536
MAX_ARCHIVE_BYTES=268435456
# POSIX ulimit -f values are counts of 512-byte blocks.
MAX_LISTING_BLOCKS=32768
MAX_ENTRY_BLOCKS=409600
CHANNEL=${CLAWDI_CHANNEL:-latest}
umask 077

if [ -n "${CLAWDI_INSTALL_PREFIX:-}" ]; then
  PREFIX=$CLAWDI_INSTALL_PREFIX
else
  [ -n "${HOME:-}" ] || { printf 'clawdi install: HOME is required unless CLAWDI_INSTALL_PREFIX is set\n' >&2; exit 1; }
  PREFIX=$HOME/.local
fi

fail() {
  printf 'clawdi install: %s\n' "$*" >&2
  exit 1
}

case "$PREFIX" in
  /*) ;;
  *) fail 'CLAWDI_INSTALL_PREFIX must be an absolute path' ;;
esac
case "$CHANNEL" in
  latest|beta) ;;
  *) fail 'CLAWDI_CHANNEL must be latest or beta' ;;
esac
if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
  fail 'do not run the installer through sudo; run it as the target user'
fi

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
command -v gzip >/dev/null 2>&1 || fail 'gzip is required'
command -v awk >/dev/null 2>&1 || fail 'awk is required'

os=$(uname -s 2>/dev/null || true)
arch=$(uname -m 2>/dev/null || true)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    fail 'Windows native installation is not supported; install an exact version with npm: npm i -g clawdi@<version> (Node >=22.5)'
    ;;
  *) fail "unsupported operating system: $os" ;;
esac

if [ "$os" = darwin ] && command -v sysctl >/dev/null 2>&1; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
fi

case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported architecture: $arch" ;;
esac

target="$os-$arch"
if [ "$os" = linux ]; then
  if (ldd --version 2>&1 || true) | grep -qi musl || ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
    target="$target-musl"
  fi
fi

bootstrap_tmp=$(mktemp -d "${TMPDIR:-/tmp}/clawdi-bootstrap.XXXXXXXX") || fail 'could not create private temporary directory'
stage_dir=''
cleanup() {
  rm -rf "$bootstrap_tmp"
  if [ -n "$stage_dir" ] && [ -d "$stage_dir" ]; then
    rm -rf "$stage_dir"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

download() {
  url=$1
  output=$2
  maximum=$3
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 180 -fsSL --max-filesize "$maximum" "$url" -o "$output"
  size=$(wc -c < "$output" | tr -d ' ')
  [ "$size" -le "$maximum" ] || fail "download exceeds size limit: $url"
}

valid_version() {
  printf '%s\n' "$1" | awk '
    function identifiers(value, prerelease, parts, count, i) {
      if (value == "") return 0
      count=split(value, parts, ".")
      for (i=1; i<=count; i++) {
        if (parts[i] == "" || parts[i] ~ /[^0-9A-Za-z-]/) return 0
        if (prerelease && parts[i] ~ /^[0-9]+$/ && length(parts[i]) > 1 && substr(parts[i],1,1) == "0") return 0
      }
      return 1
    }
    {
      value=$0
      if (value == "" || value ~ /[^0-9A-Za-z.+-]/) exit 1
      plus=index(value,"+")
      if (plus) {
        if (index(substr(value,plus+1),"+") || !identifiers(substr(value,plus+1),0)) exit 1
        value=substr(value,1,plus-1)
      }
      dash=index(value,"-")
      if (dash) {
        if (!identifiers(substr(value,dash+1),1)) exit 1
        value=substr(value,1,dash-1)
      }
      count=split(value,core,"."); if (count != 3) exit 1
      for (i=1; i<=3; i++) if (core[i] !~ /^(0|[1-9][0-9]*)$/) exit 1
      exit 0
    }
  '
}

version=${CLAWDI_VERSION:-}
if [ -z "$version" ]; then
  registry_json="$bootstrap_tmp/registry.json"
  download 'https://registry.npmjs.org/-/package/clawdi/dist-tags' "$registry_json" "$MAX_MANIFEST_BYTES"
  version=$(sed -n "s/.*\"$CHANNEL\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$registry_json")
fi
valid_version "$version" || fail "invalid exact version: $version"

printf 'Installing clawdi v%s for %s...\n' "$version" "$target"

release_base="https://github.com/Clawdi-AI/clawdi/releases/download/clawdi-cli-v$version"
manifest="$bootstrap_tmp/$MANIFEST_NAME"
download "$release_base/$MANIFEST_NAME" "$manifest" "$MAX_MANIFEST_BYTES"

artifact_record=$(awk -F '\t' -v schema="$SCHEMA" -v version="$version" -v selected="$target" '
  function supported(t) {
    return t=="linux-x64" || t=="linux-arm64" || t=="linux-x64-musl" ||
      t=="linux-arm64-musl" || t=="darwin-x64" || t=="darwin-arm64"
  }
  NR==1 { if (NF!=1 || $1!=schema) exit 1; next }
  NR==2 { if (NF!=2 || $1!="version" || $2!=version) exit 1; next }
  {
    if (NF!=4 || $1!="artifact" || !supported($2) || seen[$2]++) exit 1
    count++
    if ($3 != "clawdi-cli-" $2 ".tar.gz") exit 1
    if (length($4)!=64 || $4 ~ /[^0-9a-f]/) exit 1
    if ($2==selected) found=$3 "\t" $4
  }
  END { if (NR!=8 || count!=6 || found=="") exit 1; print found }
' "$manifest") || fail 'invalid or incomplete exact native release manifest'

artifact=$(printf '%s\n' "$artifact_record" | awk -F '\t' '{print $1}')
expected_sha=$(printf '%s\n' "$artifact_record" | awk -F '\t' '{print $2}')
archive="$bootstrap_tmp/$artifact"
download "$release_base/$artifact" "$archive" "$MAX_ARCHIVE_BYTES"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
else
  fail 'sha256sum or shasum is required'
fi
[ "$actual_sha" = "$expected_sha" ] || fail 'native artifact checksum mismatch'

entries="$bootstrap_tmp/archive.entries"
types="$bootstrap_tmp/archive.types"
bounded_tar="$bootstrap_tmp/native.tar"
(ulimit -f 1048576; gzip -dc "$archive" > "$bounded_tar") || fail 'native artifact exceeds the unpacked size limit'
unpacked_size=$(wc -c < "$bounded_tar" | tr -d ' ')
[ "$unpacked_size" -le 536870912 ] || fail 'native artifact exceeds the unpacked size limit'
(ulimit -f "$MAX_LISTING_BLOCKS"; tar -tf "$bounded_tar" > "$entries") ||
  fail 'native artifact path listing exceeds the size limit'
(ulimit -f "$MAX_LISTING_BLOCKS"; tar -tvf "$bounded_tar" > "$types") ||
  fail 'native artifact type listing exceeds the size limit'
awk '
  {
    count++; if (count > 20000) exit 1
    p=$0; sub(/^\.\//,"",p); sub(/\/$/,"",p)
    if (p=="" || p ~ /^\// || p ~ /(^|\/)\.\.($|\/)/ || seen[p]++) exit 1
    split(p, part, "/")
    if (part[1]!="clawdi" && part[1]!="egress-addon" && part[1]!="skills" &&
        part[1]!="runtime-adapters") exit 1
    if (part[1]=="clawdi" && p!="clawdi") exit 1
    if (p=="clawdi" || p=="egress-addon/clawdi_egress_addon.py" ||
        p=="skills/clawdi/SKILL.md" || p=="skills/hosted-versions/1/clawdi/SKILL.md" ||
        p=="runtime-adapters/whatsapp/openclaw/openclaw.plugin.json" ||
        p=="runtime-adapters/whatsapp/hermes/plugin.yaml") required[p]=1
  }
  END {
    if (!required["clawdi"] || !required["egress-addon/clawdi_egress_addon.py"] ||
        !required["skills/clawdi/SKILL.md"] || !required["skills/hosted-versions/1/clawdi/SKILL.md"] ||
        !required["runtime-adapters/whatsapp/openclaw/openclaw.plugin.json"] ||
        !required["runtime-adapters/whatsapp/hermes/plugin.yaml"]) exit 1
  }
' "$entries" || fail 'native artifact contains unsafe, duplicate, excessive, or unexpected paths'
awk '{ t=substr($1,1,1); if (t!="-" && t!="d") exit 1 }' "$types" || fail 'native artifact contains links or unsupported entry types'

native_root="$PREFIX/share/clawdi"
(umask 022; mkdir -p "$native_root") || fail "cannot create native install root: $native_root"
stage_dir=$(mktemp -d "$native_root/.stage-XXXXXXXX") || fail 'cannot create same-filesystem native stage'
(ulimit -f "$MAX_ENTRY_BLOCKS"; tar -xf "$bounded_tar" -C "$stage_dir" --no-same-owner --no-same-permissions) ||
  fail 'native artifact extraction failed'
cp "$manifest" "$stage_dir/$MANIFEST_NAME"
chmod 755 "$stage_dir/clawdi"

[ "$("$stage_dir/clawdi" --version)" = "$version" ] || fail 'staged native executable failed version smoke'
[ "$("$stage_dir/clawdi" update --native-identity)" = "$(printf '%s\t%s' "$version" "$target")" ] ||
  fail 'staged native executable identity does not match the selected target'

umask 022
launcher=$("$stage_dir/clawdi" update --native-activate \
  --native-stage "$stage_dir" \
  --native-prefix "$PREFIX" \
  --native-version "$version" \
  --native-target "$target") || fail 'native activation did not complete; inspect the stable launcher and retry'
stage_dir=''

printf 'clawdi %s installed at %s\n' "$version" "$launcher"
case ":${PATH:-}:" in
  *":$PREFIX/bin:"*)
    resolved=$(command -v clawdi 2>/dev/null || true)
    [ "$resolved" = "$launcher" ] ||
      printf 'Put %s/bin before other PATH entries to run this native installation.\n' "$PREFIX"
    ;;
  *) printf 'Add %s/bin to PATH to run clawdi.\n' "$PREFIX" ;;
esac
