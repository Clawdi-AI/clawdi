import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeCommandVersion, runtimeFileCurrentRevision } from "./manifest-install";
import {
	preinstalledHermesConfigPath,
	preinstalledRuntimeVersion,
	resetPreinstalledProbesForTest,
} from "./preinstalled-probes";

const roots: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	process.env = { ...savedEnv };
	resetPreinstalledProbesForTest();
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "preinstalled-probes-"));
	roots.push(root);
	const home = join(root, "home");
	const state = join(root, "state");
	const commit = "c".repeat(40);
	mkdirSync(join(home, ".hermes/hermes-agent/.git"), { recursive: true });
	mkdirSync(join(home, ".local/bin"), { recursive: true });
	writeFileSync(join(home, ".hermes/hermes-agent/.git/HEAD"), `${commit}\n`);
	const command = join(home, ".local/bin/hermes");
	// A live probe would print "live"; reuse must return the sealed answer instead.
	writeFileSync(command, "#!/bin/sh\necho live\n", { mode: 0o755 });
	const executableRevision = runtimeFileCurrentRevision(command);
	if (!executableRevision) throw new Error("fixture revision missing");
	mkdirSync(join(state, "preinstallation"), { recursive: true });
	const receipt = join(state, "preinstallation/receipt.json");
	writeFileSync(
		receipt,
		JSON.stringify({
			runtime: "hermes",
			probes: {
				runtime: "hermes",
				command,
				home,
				executableRevision,
				sourceIdentity: `git:${commit}`,
				version: "sealed version",
				configPath: join(home, ".hermes/config.yaml"),
			},
		}),
	);
	chmodSync(receipt, 0o400);
	Object.assign(process.env, { CLAWDI_RUNTIME_MODE: "hosted", CLAWDI_SERVICE_STATE_DIR: state });
	delete process.env.HERMES_HOME;
	resetPreinstalledProbesForTest(process.getuid?.() ?? 0);
	return { home, command, executableRevision };
}

test("sealed probes are reused only for the exact launcher and source identity", () => {
	const f = fixture();
	expect(runtimeCommandVersion(f.command, f.home, f.home)).toBe("sealed version");
	expect(preinstalledHermesConfigPath(f.command, f.home, f.executableRevision, undefined)).toBe(
		join(f.home, ".hermes/config.yaml"),
	);
	expect(preinstalledHermesConfigPath(f.command, f.home, f.executableRevision, {})).toBeNull();
	writeFileSync(join(f.home, ".hermes/hermes-agent/.git/HEAD"), `${"d".repeat(40)}\n`);
	expect(preinstalledRuntimeVersion(f.command, f.home, f.executableRevision)).toBeNull();
});

test("a changed launcher falls back to the live probe", () => {
	const f = fixture();
	writeFileSync(f.command, "#!/bin/sh\necho live\n# updated\n", { mode: 0o755 });
	const revision = runtimeFileCurrentRevision(f.command);
	if (!revision) throw new Error("fixture revision missing");
	expect(preinstalledRuntimeVersion(f.command, f.home, revision)).toBeNull();
	expect(runtimeCommandVersion(f.command, f.home, f.home)).toBe("live");
});
