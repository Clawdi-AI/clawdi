import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeManifest } from "../runtime/manifest-contract";
import type { RuntimePaths } from "../runtime/paths";

export function ensureTestOpenClawWorkspaceCli(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
): void {
	const runtime = manifest.runtimes.openclaw;
	if (!runtime) return;
	const installed = join(paths.userHome, ".local", "bin", "openclaw");
	if (existsSync(installed)) {
		const content = readFileSync(installed, "utf8");
		if (
			content.includes("CLAWDI_TEST_WORKSPACE_ROSTER") ||
			content.includes("agents list --json")
		) {
			return;
		}
		const delegate = `${installed}.without-workspace-roster`;
		renameSync(installed, delegate);
		writeFileSync(
			installed,
			`#!/bin/sh
# CLAWDI_TEST_WORKSPACE_ROSTER ${createHash("sha256").update(content).digest("hex")}
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"%s"}]\\n' "$HOME/.openclaw/workspace"
  exit 0
fi
exec '${delegate}' "$@"
`,
			{ mode: 0o700 },
		);
		return;
	}
	if (runtime.enabled !== true) return;
	const fallback = join(paths.userHome, ".openclaw", "bin", "openclaw");
	mkdirSync(dirname(fallback), { recursive: true });
	writeFileSync(
		fallback,
		`#!/bin/sh
# CLAWDI_TEST_WORKSPACE_ROSTER
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"%s"}]\\n' "$HOME/.openclaw/workspace"
  exit 0
fi
exit 64
`,
		{ mode: 0o700 },
	);
}
