import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { runCommand } from "./command-runner";
import { DesktopCliService } from "./native-cli";

const roots: string[] = [];
const originalAppImage = process.env.APPIMAGE;
afterEach(() => {
	if (originalAppImage === undefined) delete process.env.APPIMAGE;
	else process.env.APPIMAGE = originalAppImage;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function serviceFixture(failFirstInstall = false) {
	const root = mkdtempSync(join(tmpdir(), "desktop-cli-runtime-"));
	roots.push(root);
	process.env.APPIMAGE = join(root, "Clawdi.AppImage");
	for (const file of [
		"clawdi",
		"skills/clawdi/SKILL.md",
		"skills/hosted-versions/1/clawdi/SKILL.md",
		"egress-addon/clawdi_egress_addon.py",
	]) {
		const path = join(root, "resources/native", file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "fixture", { mode: 0o755 });
	}
	const calls: string[] = [];
	const state = {
		cliVersion: "1.2.0",
		daemonVersion: "1.2.0",
		live: false,
		executable: join(root, "resources/native/clawdi"),
	};
	const execute: typeof runCommand = async (_command, args) => {
		const command = args.join(" ");
		calls.push(command);
		let result: unknown;
		switch (command) {
			case "update --native-identity":
				return { stdout: `${state.cliVersion}\t${process.platform}-${process.arch}\n`, stderr: "" };
			case "auth status --json":
				result = { authenticated: true, credentialType: "clerk-oauth", user: { id: "fixture" } };
				break;
			case "daemon doctor --json":
				// A stopped installed unit has no live health to identify its old path.
				result = {
					cli_version: state.cliVersion,
					singleton_unit_installed: true,
					singleton_unit_running: state.live,
					agents: state.live
						? [
								{
									daemon_version: state.daemonVersion,
									daemon_executable: state.executable,
									heartbeat: { status: "live" },
								},
							]
						: [],
				};
				break;
			case "daemon install":
				if (failFirstInstall) {
					failFirstInstall = false;
					throw new Error("Fixture activation failed");
				}
				state.daemonVersion = state.cliVersion;
				state.executable = _command;
				break;
			case "daemon restart":
				break;
			default:
				throw new Error(`Unexpected command: ${command}`);
		}
		return { stdout: JSON.stringify(result ?? {}), stderr: "" };
	};
	const service = new DesktopCliService(
		{
			isPackaged: true,
			getAppPath: () => root,
			getPath: () => join(root, "data"),
			getVersion: () => "2.0.0",
		},
		execute,
		join(root, "resources"),
	);
	return { service, calls, state, runtimeDirectory: join(root, "data/runtimes") };
}

test.skipIf(process.platform !== "linux")(
	"bootstrap is read-only; verified stopped AppImage reconciliation installs once",
	async () => {
		const { service, calls, runtimeDirectory } = serviceFixture();
		await Promise.all([service.bootstrapState(), service.bootstrapState()]);
		await service.bootstrapState();
		expect(calls).not.toContain("daemon install");
		expect(existsSync(runtimeDirectory)).toBe(false);
		await expect(service.reconcileDaemonRuntime("different-account")).rejects.toThrow(
			"Sign-in changed",
		);
		await Promise.all([
			service.reconcileDaemonRuntime("fixture"),
			service.reconcileDaemonRuntime("fixture"),
		]);
		await service.reconcileDaemonRuntime("fixture");
		expect(calls.filter((command) => command === "daemon install")).toHaveLength(1);
		expect(calls).not.toContain("daemon restart");
		await service.restartDaemon();
		expect(calls.filter((command) => command === "daemon install")).toHaveLength(1);
		expect(calls.filter((command) => command === "daemon restart")).toHaveLength(1);
	},
);

test.skipIf(process.platform !== "linux")(
	"failed AppImage install does not mark runtime reconciliation complete",
	async () => {
		const { service, calls } = serviceFixture(true);
		await service.bootstrapState();
		await expect(service.reconcileDaemonRuntime("fixture")).rejects.toThrow(
			"Fixture activation failed",
		);
		await service.bootstrapState();
		await service.reconcileDaemonRuntime("fixture");
		await service.bootstrapState();
		await service.reconcileDaemonRuntime("fixture");
		expect(calls.filter((command) => command === "daemon install")).toHaveLength(2);
	},
);

test.skipIf(process.platform !== "linux")(
	"manual package upgrades refresh live daemons once per new CLI version",
	async () => {
		const { service, calls, state } = serviceFixture();
		delete process.env.APPIMAGE;
		state.live = true;
		await service.bootstrapState();
		expect(calls).not.toContain("daemon install");
		state.cliVersion = "1.3.0";
		await service.bootstrapState();
		expect(calls).not.toContain("daemon install");
		await service.reconcileDaemonRuntime("fixture");
		await service.bootstrapState();
		await service.reconcileDaemonRuntime("fixture");
		expect(calls.filter((command) => command === "daemon install")).toHaveLength(1);
		state.cliVersion = "1.4.0";
		await service.bootstrapState();
		await service.reconcileDaemonRuntime("fixture");
		await service.bootstrapState();
		await service.reconcileDaemonRuntime("fixture");
		expect(calls.filter((command) => command === "daemon install")).toHaveLength(2);
	},
);
