#!/usr/bin/env bash
set -euo pipefail

runtime="${CLAWDI_TEST_STOCK_RUNTIME:?CLAWDI_TEST_STOCK_RUNTIME is required}"
case "$runtime" in
	hermes | openclaw) ;;
	*)
		echo "unsupported stock runtime: $runtime" >&2
		exit 64
		;;
esac

stock_home="/opt/stock/${runtime}-home"
test -d "$stock_home"
test -d "$HOME"
cp -a "$stock_home/." "$HOME/"
