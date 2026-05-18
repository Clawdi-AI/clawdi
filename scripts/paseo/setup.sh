#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/paseo/common.sh
. "$SCRIPT_DIR/common.sh"

WORKSPACE="${PASEO_BRANCH_NAME:-$(basename "$REPO_ROOT")}"

find_source_root() {
  python3 - "$REPO_ROOT" <<'PY'
import os
import subprocess
import sys
from pathlib import Path

repo_root = Path(sys.argv[1]).resolve()
override = (
    os.environ.get("PASEO_SOURCE_CHECKOUT_PATH")
    or os.environ.get("PASEO_ROOT_PATH")
)


def has_source_env(path: Path) -> bool:
    return (
        (path / "backend/.env").is_file()
        or (path / "apps/web/.env.local").is_file()
        or (path / "apps/web/.env").is_file()
    )


if override:
    print(Path(override).expanduser().resolve())
    raise SystemExit(0)

if has_source_env(repo_root):
    print(repo_root)
    raise SystemExit(0)

try:
    output = subprocess.check_output(
        ["git", "-C", str(repo_root), "worktree", "list", "--porcelain"],
        text=True,
        stderr=subprocess.DEVNULL,
    )
except Exception:
    print(repo_root)
    raise SystemExit(0)

for line in output.splitlines():
    if not line.startswith("worktree "):
        continue
    path = Path(line.removeprefix("worktree ")).resolve()
    if path != repo_root and has_source_env(path):
        print(path)
        raise SystemExit(0)

print(repo_root)
PY
}

require_command() {
  local name="$1"
  local message="$2"

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$message" >&2
    exit 1
  fi
}

require_command bun "bun is required. Install Bun >= 1.3 before creating a Paseo worktree."
require_command node "Node.js is required to run the web app in Paseo."
require_command uv "uv is required for backend dependencies."
require_command docker "Docker is required for local PostgreSQL."

if ! node --version >/dev/null 2>&1; then
  echo "Node.js is required but 'node --version' failed." >&2
  echo "Fix the local Node/Volta environment before creating a Paseo worktree." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is required for local PostgreSQL." >&2
  exit 1
fi

BASE="${PASEO_WORKTREE_PORT:-}"
if [ -z "$BASE" ]; then
  echo "PASEO_WORKTREE_PORT is required. Create this workspace with Paseo so it can assign the port." >&2
  exit 1
fi

if ! [[ "$BASE" =~ ^[0-9]+$ ]]; then
  echo "Invalid base port: ${BASE}" >&2
  exit 1
fi

WEB_PORT=$((BASE))
BACKEND_PORT=$((BASE + 1))
PG_PORT=$((BASE + 2))
COMPOSE_PROJECT="clawdi-cloud-${BASE}"
WEB_PUBLIC_URL="${WEB_PUBLIC_URL:-http://localhost:${WEB_PORT}}"
API_PUBLIC_URL="${API_PUBLIC_URL:-http://localhost:${BACKEND_PORT}}"
CORS_ORIGINS_VALUE="$(
  json_string_array \
    "$WEB_PUBLIC_URL" \
    "http://localhost:${WEB_PORT}" \
    "http://127.0.0.1:${WEB_PORT}"
)"

ROOT="$(find_source_root)"

mkdir -p .paseo
{
  printf 'DEV_PORT=%s\n' "$BASE"
  printf 'WEB_PORT=%s\n' "$WEB_PORT"
  printf 'BACKEND_PORT=%s\n' "$BACKEND_PORT"
  printf 'PG_PORT=%s\n' "$PG_PORT"
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$COMPOSE_PROJECT"
  printf 'PASEO_WORKTREE_PORT=%s\n' "$BASE"
  printf 'PASEO_WORKTREE_PATH=%q\n' "$REPO_ROOT"
  printf 'PASEO_SOURCE_CHECKOUT_PATH=%q\n' "$ROOT"
  printf 'PASEO_ROOT_PATH=%q\n' "$ROOT"
  printf 'PASEO_BRANCH_NAME=%q\n' "${PASEO_BRANCH_NAME:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || basename "$REPO_ROOT")}"
  printf 'WEB_PUBLIC_URL=%q\n' "$WEB_PUBLIC_URL"
  printf 'API_PUBLIC_URL=%q\n' "$API_PUBLIC_URL"
} > .paseo/ports.env

cat > .paseo/ports.json <<EOF
{
  "ports": [
    { "port": ${WEB_PORT}, "label": "Frontend Dev Server" },
    { "port": ${BACKEND_PORT}, "label": "Backend API" },
    { "port": ${PG_PORT}, "label": "PostgreSQL" }
  ]
}
EOF

first_existing() {
  local path
  for path in "$@"; do
    if [ -f "$path" ]; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  return 1
}

write_env_file() {
  local source_env="$1"
  local example_env="$2"
  local target_env="$3"
  local overrides="$4"

  SOURCE_ENV="$source_env" \
  EXAMPLE_ENV="$example_env" \
  TARGET_ENV="$target_env" \
  OVERRIDES="$overrides" \
  python3 <<'PY'
import os
import re
from pathlib import Path

source_path = Path(os.environ["SOURCE_ENV"]) if os.environ["SOURCE_ENV"] else None
example_path = Path(os.environ["EXAMPLE_ENV"])
target_path = Path(os.environ["TARGET_ENV"])
overrides_raw = os.environ.get("OVERRIDES", "")
key_re = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=")


def parse_env(path):
    if path is None or not path.exists():
        return {}

    lines = path.read_text().splitlines()
    values = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue

        match = key_re.match(line)
        if not match:
            i += 1
            continue

        key = match.group(1)
        value = line.split("=", 1)[1]
        if value.startswith('"') and not value.endswith('"'):
            i += 1
            while i < len(lines):
                value += "\n" + lines[i]
                if lines[i].endswith('"'):
                    break
                i += 1

        values[key] = value
        i += 1

    return values


values = parse_env(source_path)
for line in overrides_raw.splitlines():
    if not line or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key] = value

if not example_path.exists():
    raise SystemExit(f"Missing env example: {example_path}")

example_lines = example_path.read_text().splitlines()
output = []
seen = set()
i = 0
while i < len(example_lines):
    line = example_lines[i]
    match = key_re.match(line)
    if match and match.group(1) in values:
        key = match.group(1)
        output.append(f"{key}={values[key]}")
        seen.add(key)

        old_value = line.split("=", 1)[1]
        if old_value.startswith('"') and not old_value.endswith('"'):
            i += 1
            while i < len(example_lines):
                if example_lines[i].endswith('"'):
                    break
                i += 1
        i += 1
        continue

    output.append(line)
    i += 1

for key, value in values.items():
    if key not in seen:
        output.append(f"{key}={value}")

target_path.parent.mkdir(parents=True, exist_ok=True)
target_path.write_text("\n".join(output).rstrip() + "\n")
PY
}

backend_source_env="$(first_existing "$ROOT/backend/.env" || true)"
backend_overrides="$(cat <<EOF
DATABASE_URL=postgresql+asyncpg://clawdi:clawdi_dev@127.0.0.1:${PG_PORT}/clawdi
CORS_ORIGINS=${CORS_ORIGINS_VALUE}
PUBLIC_API_URL=${API_PUBLIC_URL}
WEB_ORIGIN=${WEB_PUBLIC_URL}
EOF
)"
write_env_file "$backend_source_env" backend/.env.example backend/.env "$backend_overrides"

python3 <<'PY'
from pathlib import Path
import os

path = Path("backend/.env")
lines = path.read_text().splitlines()
changed = False
for key in ("VAULT_ENCRYPTION_KEY", "ENCRYPTION_KEY"):
    if any(line.startswith(f"{key}=") and line.split("=", 1)[1].strip() for line in lines):
        continue
    token = os.urandom(32).hex()
    for index, line in enumerate(lines):
        if line.startswith(f"{key}="):
            lines[index] = f"{key}={token}"
            changed = True
            break
    else:
        lines.append(f"{key}={token}")
        changed = True

if changed:
    path.write_text("\n".join(lines) + "\n")
PY

web_source_env="$(first_existing "$ROOT/apps/web/.env.local" "$ROOT/apps/web/.env" || true)"
web_overrides="$(cat <<EOF
NEXT_PUBLIC_API_URL=${API_PUBLIC_URL}
EOF
)"
write_env_file "$web_source_env" apps/web/.env.example apps/web/.env.local "$web_overrides"

echo "Clawdi ports for Paseo workspace '${WORKSPACE}' (base=${BASE}):"
echo "  Web:        ${WEB_PORT}"
echo "  Backend:    ${BACKEND_PORT}"
echo "  PostgreSQL: ${PG_PORT}"

bun install --frozen-lockfile
(cd backend && uv sync --all-groups)

echo "Setup complete. Run 'bash scripts/paseo/dev.sh' to start infra and app services."
