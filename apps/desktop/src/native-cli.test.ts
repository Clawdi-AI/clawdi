import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DesktopAuthenticationProgress } from "@clawdi/shared/desktop";
import { emit } from "../../../packages/cli/src/lib/command-output";
import type { runCommand } from "./command-runner";
import { DesktopCliService } from "./native-cli";

const roots: string[] = [];
const originalAppImage = process.env.APPIMAGE;
afterEach(() => {
	if (originalAppImage === undefined) delete process.env.APPIMAGE;
	else process.env.APPIMAGE = originalAppImage;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function serviceFixture(
	failFirstInstall = false,
	loginProgress?: { schemaVersion: string; [key: string]: unknown },
	mounted = false,
) {
	const root = mkdtempSync(join(tmpdir(), "desktop-cli-runtime-"));
	roots.push(root);
	const appImagePath = join(root, "Clawdi.AppImage");
	process.env.APPIMAGE = appImagePath;
	const resourcesPath = join(root, mounted ? ".mount_Clawdi/resources" : "resources");
	const cliName = process.platform === "win32" ? "clawdi.exe" : "clawdi";
	for (const file of [
		cliName,
		"skills/clawdi/SKILL.md",
		"skills/hosted-versions/1/clawdi/SKILL.md",
		"egress-addon/clawdi_egress_addon.py",
	]) {
		const path = join(resourcesPath, "native", file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "fixture", { mode: 0o755 });
	}
	const calls: string[] = [];
	const state = {
		detectionSchema: "clawdi.agentDetection.v1" as string | undefined,
		authStatusSchema: "clawdi.authStatus.v1" as string | undefined,
		cliVersion: "1.2.0",
		daemonVersion: "1.2.0",
		live: false,
		executable: join(resourcesPath, "native", cliName),
		excludedProjects: [] as string[],
		ticketSchema: "clawdi.desktopSession.v1",
		revokeFailed: false,
		ticketTtl: 60,
		failUninstall: false,
	};
	const execute: typeof runCommand = async (_command, args, options) => {
		const command = args.join(" ");
		calls.push(command);
		let result: unknown;
		switch (command) {
			case "auth login --desktop":
				if (loginProgress)
					emit(loginProgress, (output) => {
						for (const line of output.split("\n")) options?.onStderrLine?.(line);
					});
				result = {
					schemaVersion: "clawdi.desktopLogin.v1",
					status: loginProgress ? "authenticated" : "cancelled",
					user: { id: "fixture" },
				};
				break;
			case "agent detect --json":
				result = {
					schemaVersion: state.detectionSchema,
					agents: [
						{
							type: "dsh",
							displayName: "DeepSeek Harness",
							detected: true,
							registered: false,
							version: "0.2.0-rc.2",
							inspection: "complete",
						},
					],
				};
				break;
			case "agent reconnect --json":
				result = {
					schemaVersion: "clawdi.agentReconnectCandidates.v1",
					agents: [
						{
							id: "dsh-agent",
							type: "dsh",
							displayName: "DeepSeek Harness",
							name: "Research",
							machineName: "Laptop",
							isThisMachine: false,
							lastSyncAt: null,
						},
					],
				};
				break;
			case "update --native-identity":
				return { stdout: `${state.cliVersion}\t${process.platform}-${process.arch}\n`, stderr: "" };
			case "auth desktop-session --json":
				result = {
					schemaVersion: state.ticketSchema,
					status: "ticket",
					ticket: "fixture-ticket",
					expiresIn: state.ticketTtl,
					accountId: "user_fixture",
				};
				break;
			case "auth desktop-session --json --session-user user_fixture --session-id sess_fixture":
				result = {
					schemaVersion: state.ticketSchema,
					status: "signed-in",
					expiresIn: 0,
					accountId: "user_fixture",
				};
				break;
			case "auth desktop-sign-out --session-id sess_fixture --json":
				if (state.revokeFailed) throw new Error("private fixture error");
				result = { schemaVersion: "clawdi.desktopSignOut.v1", status: "revoked" };
				break;
			case "auth status --json":
				result = {
					schemaVersion: state.authStatusSchema,
					authenticated: true,
					credentialType: "clerk-oauth",
					user: { id: "fixture" },
				};
				break;
			case "daemon doctor --json":
				// A stopped installed unit has no live health to identify its old path.
				result = {
					schemaVersion: "clawdi.daemonDoctor.v2",
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
			case "daemon uninstall":
				if (state.failUninstall) throw new Error("fixture service failure");
				break;
			case "auth logout":
				break;
			case "daemon restart":
				break;
			case "config list --json":
				result = {
					schemaVersion: "clawdi.config.v1",
					values: { excludeProjects: { value: state.excludedProjects, source: "config.json" } },
				};
				break;
			case "config unset excludeProjects":
				state.excludedProjects = [];
				break;
			default:
				if (args.length === 4 && args.slice(0, 3).join(" ") === "config set excludeProjects") {
					state.excludedProjects = args[3]?.split(",") ?? [];
					break;
				}
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
		resourcesPath,
	);
	return {
		service,
		calls,
		state,
		resourcesPath,
		appImagePath,
		runtimeDirectory: join(root, "data/runtimes"),
	};
}

test.skipIf(process.platform !== "linux")(
	"AppImage launch refreshes an old live daemon using a path that survives mount and image replacement",
	async () => {
		const { service, calls, state, resourcesPath, appImagePath, runtimeDirectory } = serviceFixture(
			false,
			undefined,
			true,
		);
		writeFileSync(appImagePath, "N");
		state.live = true;
		state.daemonVersion = "1.1.0";
		await service.bootstrapState();
		expect(calls).not.toContain("daemon install");
		expect(await service.reconcileDaemonRuntime("fixture")).toBe(true);
		const durableCli = join(runtimeDirectory, "2.0.0/clawdi");
		expect(state.executable).toBe(durableCli);
		expect(state.executable).not.toContain(".mount_");
		expect(state.daemonVersion).toBe(state.cliVersion);
		await service.reconcileDaemonRuntime("fixture");
		expect(calls.filter((command) => command === "daemon install")).toHaveLength(1);
		rmSync(resourcesPath, { recursive: true });
		writeFileSync(appImagePath, "N+1");
		expect(await service.shellCommandTarget()).toBe(durableCli);
		expect(existsSync(durableCli)).toBe(true);
	},
);

test("accepts dsh detection and reconnect candidates from the CLI", async () => {
	const { service } = serviceFixture();
	expect(await service.detectAgents()).toEqual([
		{
			type: "dsh",
			displayName: "DeepSeek Harness",
			detected: true,
			registered: false,
			version: "0.2.0-rc.2",
			inspection: "complete",
		},
	]);
	expect(await service.listReconnectableAgents()).toEqual([
		{
			id: "dsh-agent",
			type: "dsh",
			displayName: "DeepSeek Harness",
			name: "Research",
			machineName: "Laptop",
			isThisMachine: false,
			lastSyncAt: null,
		},
	]);
});

test.each([undefined, "clawdi.agentDetection.v2"])(
	"rejects agent detection with unsupported schema %s",
	async (schemaVersion) => {
		const { service, state } = serviceFixture();
		state.detectionSchema = schemaVersion;
		await expect(service.detectAgents()).rejects.toThrow("invalid agent detection data");
	},
);

test.each([undefined, "clawdi.authStatus.v2"])(
	"rejects authentication with unsupported schema %s",
	async (schemaVersion) => {
		const { service, state } = serviceFixture();
		state.authStatusSchema = schemaVersion;
		await expect(service.bootstrapState()).rejects.toThrow("invalid authentication data");
	},
);

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

test("Desktop treats OAuth access denial as cancellation", async () => {
	const { service, calls } = serviceFixture();
	expect(await service.authenticate()).toEqual({ status: "cancelled" });
	expect(calls).toContain("auth login --desktop");
});

const deviceProgress = {
	schemaVersion: "clawdi.desktopLogin.progress.v1",
	verificationUri: "https://accounts.example.test/device?user_code=ABCD-EFGH",
	userCode: "ABCD-EFGH",
	expiresAt: "2026-10-07T22:00:00.000Z",
};

test("Desktop forwards device code progress to the UI while the CLI owns sign-in", async () => {
	const { service, calls } = serviceFixture(false, {
		...deviceProgress,
		access_token: "must-not-reach-renderer",
	});
	const progress: DesktopAuthenticationProgress[] = [];
	expect(await service.authenticate((event) => progress.push(event))).toEqual({
		status: "authenticated",
		user: { id: "fixture" },
	});
	expect(calls).toEqual(["auth login --desktop"]);
	expect(progress).toEqual([
		{
			verificationUri: deviceProgress.verificationUri,
			userCode: deviceProgress.userCode,
			expiresAt: deviceProgress.expiresAt,
		},
	]);
});

test.each([
	{ userCode: "" },
	{ userCode: "a".repeat(513) },
	{ expiresAt: "invalid" },
	{ verificationUri: "http://accounts.example.test/device" },
	{ verificationUri: "https://user:password@accounts.example.test/device" },
])("Desktop rejects invalid device progress %j", async (overrides) => {
	const { service } = serviceFixture(false, { ...deviceProgress, ...overrides });
	const progress: DesktopAuthenticationProgress[] = [];
	await expect(service.authenticate((event) => progress.push(event))).rejects.toThrow();
	expect(progress).toEqual([]);
});

test("Desktop reads and writes excluded projects through the CLI config", async () => {
	const { service, calls } = serviceFixture();
	expect(await service.listExcludedProjects()).toEqual([]);
	const root = process.platform === "win32" ? "C:\\work" : "/work";
	const paths = [join(root, "client"), join(root, "scratch")];
	expect(await service.setExcludedProjects(paths)).toEqual(paths);
	expect(calls).toContain(`config set excludeProjects ${paths.join(",")}`);
	expect(await service.setExcludedProjects([])).toEqual([]);
	expect(calls).toContain("config unset excludeProjects");
});

test.each([
	"relative/project",
	"--api-url=https://attacker.test",
	join(process.platform === "win32" ? "C:\\work" : "/work", "a,b"),
])("Desktop rejects an excluded project the CLI can't store: %s", async (path) => {
	const { service, calls } = serviceFixture();
	await expect(service.setExcludedProjects([path])).rejects.toThrow();
	expect(calls.some((command) => command.startsWith("config set"))).toBe(false);
});

test("Desktop requests its ticket through the hidden machine command", async () => {
	const fixture = serviceFixture();
	expect(await fixture.service.createDashboardSession()).toEqual({
		status: "ticket",
		ticket: "fixture-ticket",
		accountId: "user_fixture",
	});
	expect(fixture.calls).toContain("auth desktop-session --json");
});

test("Desktop rejects unsupported ticket contracts and TTLs", async () => {
	const { service, state } = serviceFixture();
	state.ticketSchema = "unsupported";
	await expect(service.createDashboardSession()).rejects.toThrow(
		"Couldn't create a Desktop session",
	);
	state.ticketSchema = "clawdi.desktopSession.v1";
	for (const ttl of [0, -1, 61, Number.NaN]) {
		state.ticketTtl = ttl;
		await expect(service.createDashboardSession()).rejects.toThrow(
			"Couldn't create a Desktop session",
		);
	}
});

test("Desktop still removes the CLI credential when daemon removal fails", async () => {
	const { service, state, calls } = serviceFixture();
	state.failUninstall = true;
	await expect(service.logout()).rejects.toThrow("fixture service failure");
	expect(calls.slice(-2)).toEqual(["daemon uninstall", "auth logout"]);
});

test("Desktop compares an existing session and revokes it without exposing native errors", async () => {
	const { service, state } = serviceFixture();
	expect(
		await service.createDashboardSession({ userId: "user_fixture", sessionId: "sess_fixture" }),
	).toEqual({ status: "signed-in", accountId: "user_fixture" });
	await service.revokeDashboardSession("sess_fixture");
	state.revokeFailed = true;
	await expect(service.revokeDashboardSession("sess_fixture")).rejects.toThrow(
		"Couldn't revoke the Desktop session",
	);
});
