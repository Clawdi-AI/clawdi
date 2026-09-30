#!/usr/bin/env bash
# Sourced by the isolated test runner; all dependencies live in its disposable root.
hermes_fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/clawdi-hermes-native.XXXXXX")"
trap 'rm -rf "$hermes_fixture_root"' EXIT
hermes_fixture_commit=a0425672960e2f6dda132bf7323c31edca54585a
hermes_fixture_source="${CLAWDI_TEST_HERMES_SOURCE:-}"
if [[ -z "$hermes_fixture_source" ]]; then
	hermes_fixture_source="$hermes_fixture_root/source"
	mkdir -p "$hermes_fixture_source"
	# Both repositories contain the same immutable upstream commit.
	hermes_fixture_downloaded=false
	for hermes_fixture_repository in NousResearch/hermes-agent Clawdi-AI/hermes-agent; do
		if curl --fail --silent --show-error --location --max-time 120 --max-filesize 104857600 \
			--retry 1 --retry-max-time 150 \
			"https://codeload.github.com/$hermes_fixture_repository/tar.gz/$hermes_fixture_commit" \
			-o "$hermes_fixture_root/source.tar.gz"; then
			hermes_fixture_downloaded=true
			break
		fi
	done
	if [[ "$hermes_fixture_downloaded" != true ]]; then
		echo "Unable to download the pinned Hermes native fixture" >&2
		exit 1
	fi
	tar -xzf "$hermes_fixture_root/source.tar.gz" --strip-components=1 -C "$hermes_fixture_source"
fi
export CLAWDI_TEST_HERMES_VENV="$hermes_fixture_root/venv"
uv venv "$CLAWDI_TEST_HERMES_VENV"
uv pip install --python "$CLAWDI_TEST_HERMES_VENV/bin/python" \
	'httpx==0.28.1' 'PyYAML==6.0.3' 'ruamel.yaml==0.18.16' 'rich==15.0.0' 'python-dotenv==1.2.3' 'prompt-toolkit==3.0.53' 'uvicorn==0.52.4'
"$CLAWDI_TEST_HERMES_VENV/bin/python" - "$hermes_fixture_source" <<'PY'
import pathlib, sys, sysconfig
pathlib.Path(sysconfig.get_path("purelib"), "hermes-fixture.pth").write_text(sys.argv[1] + "\n")
PY
# Runtime privilege-drop tests need read/execute access to this immutable fixture.
chmod -R a+rX "$hermes_fixture_root"
