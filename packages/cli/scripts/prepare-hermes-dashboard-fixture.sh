#!/usr/bin/env bash
# Native auth modules use the exact source pinned by the official installer fixture.
hermes_dashboard_fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/clawdi-hermes-dashboard.XXXXXX")"
trap 'rm -rf "$hermes_dashboard_fixture_root"; if [[ -n "${hermes_fixture_root:-}" ]]; then rm -rf "$hermes_fixture_root"; fi' EXIT
hermes_dashboard_dockerfile="$package_root/tests/fixtures/runtime-official-installer-systemd/Dockerfile"
hermes_dashboard_commit=$(sed -n 's/^ARG HERMES_COMMIT=//p' "$hermes_dashboard_dockerfile")
hermes_dashboard_digest=$(sed -n 's/^ADD --checksum=sha256:\([0-9a-f]*\).*/\1/p' "$hermes_dashboard_dockerfile" | tail -1)
mkdir -p "$hermes_dashboard_fixture_root/source"
curl --fail --silent --show-error --location --max-time 120 --max-filesize 104857600 \
 "https://github.com/NousResearch/hermes-agent/archive/$hermes_dashboard_commit.tar.gz" -o "$hermes_dashboard_fixture_root/source.tar.gz"
printf '%s  %s\n' "$hermes_dashboard_digest" "$hermes_dashboard_fixture_root/source.tar.gz" | sha256sum --check
tar -xzf "$hermes_dashboard_fixture_root/source.tar.gz" --strip-components=1 -C "$hermes_dashboard_fixture_root/source"
export CLAWDI_TEST_HERMES_DASHBOARD_VENV="$hermes_dashboard_fixture_root/venv"
export CLAWDI_TEST_HERMES_DASHBOARD_SOURCE="$hermes_dashboard_fixture_root/source"
uv venv "$CLAWDI_TEST_HERMES_DASHBOARD_VENV"
uv pip install --python "$CLAWDI_TEST_HERMES_DASHBOARD_VENV/bin/python" \
 'fastapi==0.141.1' 'uvicorn==0.52.4' 'PyYAML==6.0.3' 'rich==15.0.0' 'python-dotenv==1.2.3'
