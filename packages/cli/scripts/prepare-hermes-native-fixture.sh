#!/usr/bin/env bash
# Sourced by the isolated test runner; all dependencies live in its disposable root.
hermes_fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/clawdi-hermes-native.XXXXXX")"
trap 'rm -rf "$hermes_fixture_root"' EXIT
hermes_fixture_commit=736fc4d86a1acd8c96473aeb55f9c783e2170dca
hermes_fixture_source="${CLAWDI_TEST_HERMES_SOURCE:-}"
if [[ -z "$hermes_fixture_source" ]]; then
	hermes_fixture_source="$hermes_fixture_root/source"
	mkdir -p "$hermes_fixture_source"
	curl --fail --silent --show-error --location --max-time 120 --max-filesize 104857600 \
		"https://codeload.github.com/Clawdi-AI/hermes-agent/tar.gz/$hermes_fixture_commit" \
		-o "$hermes_fixture_root/source.tar.gz"
	tar -xzf "$hermes_fixture_root/source.tar.gz" --strip-components=1 -C "$hermes_fixture_source"
fi
export CLAWDI_TEST_HERMES_VENV="$hermes_fixture_root/venv"
uv venv "$CLAWDI_TEST_HERMES_VENV"
uv pip install --python "$CLAWDI_TEST_HERMES_VENV/bin/python" \
	'httpx==0.28.1' 'PyYAML==6.0.3' 'rich==15.0.0' 'python-dotenv==1.2.3' 'prompt-toolkit==3.0.53'
"$CLAWDI_TEST_HERMES_VENV/bin/python" - "$hermes_fixture_source" <<'PY'
import pathlib, sys, sysconfig
pathlib.Path(sysconfig.get_path("purelib"), "hermes-fixture.pth").write_text(sys.argv[1] + "\n")
PY
# Runtime privilege-drop tests need read/execute access to this immutable fixture.
chmod -R a+rX "$hermes_fixture_root"
