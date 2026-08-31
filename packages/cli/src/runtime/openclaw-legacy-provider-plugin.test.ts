import { expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID,
	removeLegacyManagedOpenClawProviderPlugin,
} from "./openclaw-legacy-provider-plugin";

test("uninstalls the owned legacy provider plugin once", () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-legacy-openclaw-plugin-"));
	try {
		const home = join(root, "home");
		const stateRoot = join(home, ".openclaw");
		const sourceDir = join(stateRoot, "managed-sources", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID);
		const installDir = join(stateRoot, "extensions", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID);
		const commandPath = join(home, ".local", "bin", "openclaw");
		const commandLog = join(root, "commands.log");
		mkdirSync(sourceDir, { recursive: true });
		mkdirSync(installDir, { recursive: true });
		mkdirSync(dirname(commandPath), { recursive: true });
		writeFileSync(join(sourceDir, "openclaw.plugin.json"), "{}\n");
		writeFileSync(join(installDir, "index.js"), "export default {};\n");
		const observation = JSON.stringify({
			plugin: {
				id: LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID,
				source: join(installDir, "index.js"),
				origin: "global",
				status: "loaded",
				enabled: true,
			},
			install: { source: "path", sourcePath: sourceDir, installPath: installDir },
		});
		writeFileSync(
			commandPath,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${commandLog}'
if [ "$*" = "plugins inspect ${LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID} --json" ]; then
  test -d '${installDir}' || exit 1
  printf '%s\\n' '${observation}'
  exit 0
fi
if [ "$*" = "plugins uninstall ${LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID} --force" ]; then
  rm -rf '${installDir}'
  exit 0
fi
exit 64
`,
		);
		chmodSync(commandPath, 0o700);

		const remove = () =>
			removeLegacyManagedOpenClawProviderPlugin({ home, stateRoot, commandPath });
		remove();
		expect(existsSync(sourceDir)).toBe(false);
		expect(existsSync(installDir)).toBe(false);
		expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
			`plugins inspect ${LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID} --json`,
			`plugins uninstall ${LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID} --force`,
		]);

		remove();
		expect(readFileSync(commandLog, "utf8").trim().split("\n")).toHaveLength(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("refuses to uninstall an unowned plugin with the legacy id", () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-unowned-openclaw-plugin-"));
	try {
		const home = join(root, "home");
		const stateRoot = join(home, ".openclaw");
		const sourceDir = join(stateRoot, "managed-sources", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID);
		const installDir = join(stateRoot, "extensions", LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID);
		const commandPath = join(home, ".local", "bin", "openclaw");
		const commandLog = join(root, "commands.log");
		mkdirSync(sourceDir, { recursive: true });
		mkdirSync(installDir, { recursive: true });
		mkdirSync(dirname(commandPath), { recursive: true });
		writeFileSync(join(installDir, "index.js"), "export default {};\n");
		const observation = JSON.stringify({
			plugin: {
				id: LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID,
				source: join(installDir, "index.js"),
				origin: "global",
				status: "loaded",
				enabled: true,
			},
			install: {
				source: "path",
				sourcePath: join(root, "foreign-source"),
				installPath: installDir,
			},
		});
		writeFileSync(
			commandPath,
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${commandLog}'
printf '%s\\n' '${observation}'
`,
		);
		chmodSync(commandPath, 0o700);

		expect(() =>
			removeLegacyManagedOpenClawProviderPlugin({ home, stateRoot, commandPath }),
		).toThrow("refusing to remove an unmanaged OpenClaw provider plugin");
		expect(existsSync(sourceDir)).toBe(true);
		expect(existsSync(installDir)).toBe(true);
		expect(readFileSync(commandLog, "utf8").trim()).toBe(
			`plugins inspect ${LEGACY_CLAWDI_MANAGED_PROVIDER_PLUGIN_ID} --json`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
