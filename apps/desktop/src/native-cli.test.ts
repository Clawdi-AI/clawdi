import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DesktopAuthenticationProgress } from "@clawdi/shared/desktop";
import { emit } from "../../../packages/cli/src/lib/command-output";
import { writeFixtureNativeMetadata } from "../scripts/fixtures/native-layout";
import { nativeLauncherPath } from "./cli-compat";
import type { runCommand } from "./command-runner";
import { cliEnvironment, DesktopCliService } from "./native-cli";

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
	const home = join(root, "home");
	const launcher = nativeLauncherPath(process.platform, home);
	const calls: string[] = [];
	const invocations: Array<{ path: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
	const state = {
		detectionSchema: "clawdi.agentDetection.v1" as string | undefined,
		authStatusSchema: "clawdi.authStatus.v1" as string | undefined,
		cliVersion: "1.2.0",
		nativeVersion: null as string | null,
		bootstrapStatus: "failed",
		nativeUpdateMode: "local-self-update",
		nativeCommands: ["uninstall"],
		capabilitiesSchema: "clawdi.capabilities.v1",
		changeVersionDuringDoctor: false,
		daemonVersion: "1.2.0",
		live: false,
		executable: join(resourcesPath, "native", cliName),
		excludedProjects: [] as string[],
		ticketSchema: "clawdi.desktopSession.v1",
		revokeFailed: false,
		ticketTtl: 60,
		failUninstall: false,
	};
	const seedNative = (version: string) => {
		const directory = join(
			home,
			".local",
			"share",
			"clawdi",
			"versions",
			`${version}-${process.platform}-${process.arch}`,
		);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, cliName), "native fixture", { mode: 0o755 });
		writeFixtureNativeMetadata(directory, version);
		mkdirSync(dirname(launcher), { recursive: true });
		if (process.platform === "win32") {
			rmSync(dirname(launcher), { recursive: true, force: true });
			symlinkSync(directory, dirname(launcher), "junction");
		} else {
			rmSync(launcher, { force: true });
			symlinkSync(join(directory, cliName), launcher);
		}
		state.nativeVersion = version;
	};
	const execute: typeof runCommand = async (_command, args, options) => {
		invocations.push({ path: _command, args, env: options?.env });
		const version = _command === launcher ? state.nativeVersion : state.cliVersion;
		const command = args.join(" ");
		calls.push(command);
		let result: unknown;
		switch (command) {
			case "update --native-bootstrap --min-version 0.16.8 --json":
				if (state.bootstrapStatus === "offline") throw new Error("Fixture network unavailable");
				if (["installed", "upgraded", "already-current"].includes(state.bootstrapStatus))
					seedNative("0.16.8");
				result = {
					schemaVersion: "clawdi.nativeBootstrap.v1",
					status: state.bootstrapStatus,
					launcher,
				};
				break;
			case "capabilities --json":
				result = {
					schemaVersion: state.capabilitiesSchema,
					capabilities: { updateMode: state.nativeUpdateMode, commands: state.nativeCommands },
				};
				break;
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
				return { stdout: `${version}\t${process.platform}-${process.arch}\n`, stderr: "" };
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
				if (_command === launcher && state.changeVersionDuringDoctor) {
					state.changeVersionDuringDoctor = false;
					seedNative("0.16.9");
				}
				// A stopped installed unit has no live health to identify its old path.
				result = {
					schemaVersion: "clawdi.daemonDoctor.v2",
					cli_version: _command === launcher ? state.nativeVersion : state.cliVersion,
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
				state.daemonVersion = version ?? "invalid";
				state.executable = realpathSync(_command);
				break;
			case "uninstall --yes --remove-cli --json":
			case "uninstall --yes --json":
				if (state.failUninstall) throw new Error("fixture private cleanup error");
				result = { schemaVersion: "clawdi.uninstall.v1", status: "completed", steps: [] };
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
	const newService = () =>
		new DesktopCliService(
			{
				isPackaged: true,
				getAppPath: () => root,
				getPath: (name) => (name === "home" ? home : join(root, "data")),
				getVersion: () => "2.0.0",
			},
			execute,
			resourcesPath,
			home,
		);
	const service = newService();
	return {
		service,
		calls,
		invocations,
		seedNative,
		newService,
		launcher,
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
		await expect(service.detectAgents()).rejects.toThrow(
			schemaVersion ? "Update Clawdi Desktop" : "invalid agent detection data",
		);
	},
);

test.each([undefined, "clawdi.authStatus.v2"])(
	"rejects authentication with unsupported schema %s",
	async (schemaVersion) => {
		const { service, state } = serviceFixture();
		state.authStatusSchema = schemaVersion;
		await expect(service.bootstrapState()).rejects.toThrow(
			schemaVersion ? "Update Clawdi Desktop" : "invalid authentication data",
		);
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
	expect(calls.at(-1)).toBe("auth login --desktop");
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

test("uses a newer native CLI without bootstrapping or downgrading", async () => {
	const { service, seedNative, calls, invocations, launcher } = serviceFixture();
	seedNative("0.16.9");
	const state = await service.bootstrapState();
	expect(state.cli.version).toBe("0.16.9");
	expect(await service.shellCommandTarget()).toBe(launcher);
	expect(calls.some((command) => command.includes("--native-bootstrap"))).toBe(false);
	expect(invocations.every((call) => call.path === launcher)).toBe(true);
	expect(invocations.every((call) => call.env?.CLAWDI_NO_AUTO_UPDATE === undefined)).toBe(true);
	expect(invocations.every((call) => call.env?.CLAWDI_DESKTOP_RUNTIME === undefined)).toBe(true);
});

test.each(["installed", "upgraded", "already-current"])(
	"bootstrap %s rechecks the native CLI before using it",
	async (status) => {
		const { service, state, calls, launcher, seedNative, invocations } = serviceFixture();
		seedNative("0.16.7");
		state.bootstrapStatus = status;
		await Promise.all([service.bootstrapState(), service.bootstrapState()]);
		expect(calls.filter((command) => command.includes("--native-bootstrap"))).toHaveLength(1);
		expect(await service.shellCommandTarget()).toBe(launcher);
		const nativeAuth = invocations.find(
			(call) => call.path === launcher && call.args.join(" ") === "auth status --json",
		);
		expect(nativeAuth).toBeDefined();
		expect(nativeAuth?.env?.CLAWDI_NO_AUTO_UPDATE).toBeUndefined();
	},
);

test.each(["failed", "foreign-owner", "offline"])(
	"bootstrap %s uses bundled for the session and keeps a foreign command",
	async (status) => {
		const { service, state, seedNative, launcher, calls, invocations } = serviceFixture();
		delete process.env.APPIMAGE;
		seedNative("0.16.7");
		state.bootstrapStatus = status;
		expect((await service.bootstrapState()).cli.version).toBe(state.cliVersion);
		await service.bootstrapState();
		expect(calls.filter((command) => command.includes("--native-bootstrap"))).toHaveLength(1);
		expect(existsSync(launcher)).toBe(true);
		expect(invocations.find((call) => call.args[0] === "auth")?.env?.CLAWDI_NO_AUTO_UPDATE).toBe(
			"1",
		);
	},
);

test("a failed bootstrap is retried by the next Desktop launch", async () => {
	const { service, calls, state, newService } = serviceFixture();
	await service.bootstrapState();
	await service.bootstrapState();
	expect(calls.filter((command) => command.includes("--native-bootstrap"))).toHaveLength(1);
	state.bootstrapStatus = "installed";
	expect((await newService().bootstrapState()).cli.version).toBe("0.16.8");
	expect(calls.filter((command) => command.includes("--native-bootstrap"))).toHaveLength(2);
});

test("does not adopt a CLI whose capabilities report another update owner", async () => {
	const { service, state, seedNative } = serviceFixture();
	seedNative("1.0.0");
	state.nativeUpdateMode = "desktop-managed";
	expect(await service.usesNativeCli()).toBe(false);
});

test("native daemon reconciliation follows current after a CLI self-update", async () => {
	const { service, state, seedNative, launcher, calls } = serviceFixture();
	seedNative("0.16.8");
	state.live = true;
	state.daemonVersion = "0.16.8";
	state.executable = realpathSync(launcher);
	expect(await service.reconcileDaemonRuntime("fixture")).toBe(false);
	seedNative("0.16.9");
	state.daemonVersion = "0.16.9";
	state.executable = realpathSync(launcher);
	expect((await service.bootstrapState()).cli.version).toBe("0.16.9");
	expect(await service.reconcileDaemonRuntime("fixture")).toBe(false);
	expect(calls).not.toContain("daemon install");
});

test("native reconciliation rewrites a stopped old unit without update suppression", async () => {
	const { service, seedNative, calls, invocations, launcher } = serviceFixture();
	seedNative("0.16.8");
	expect(await service.reconcileDaemonRuntime("fixture")).toBe(true);
	expect(await service.reconcileDaemonRuntime("fixture")).toBe(false);
	expect(calls.filter((command) => command === "daemon install")).toHaveLength(1);
	const install = invocations.find((call) => call.args.join(" ") === "daemon install");
	expect(install?.path).toBe(launcher);
	expect(install?.env?.CLAWDI_NO_AUTO_UPDATE).toBeUndefined();
});

test("retries identity and doctor once when the native launcher advances", async () => {
	const { service, seedNative, state, calls } = serviceFixture();
	seedNative("0.16.8");
	state.changeVersionDuringDoctor = true;
	expect((await service.bootstrapState()).cli.version).toBe("0.16.9");
	expect(calls.filter((command) => command === "daemon doctor --json")).toHaveLength(2);
});

test("unknown native contract majors keep the Update Desktop error through sanitization", async () => {
	const { service, state, seedNative } = serviceFixture();
	seedNative("0.16.9");
	state.ticketSchema = "clawdi.desktopSession.v2";
	await expect(service.createDashboardSession()).rejects.toThrow("Update Clawdi Desktop");
	state.authStatusSchema = "clawdi.authStatus.v2";
	await expect(service.bootstrapState()).rejects.toThrow("Update Clawdi Desktop");
});

test("unknown capability major asks for Desktop update without attempting bootstrap", async () => {
	const { service, state, seedNative, calls } = serviceFixture();
	seedNative("0.16.9");
	state.capabilitiesSchema = "clawdi.capabilities.v2";
	await expect(service.bootstrapState()).rejects.toThrow("Update Clawdi Desktop");
	expect(calls.some((command) => command.includes("--native-bootstrap"))).toBe(false);
});

test("environment suppression is restricted to bundled fallback and leaves the parent intact", () => {
	const inherited = {
		PATH: "/bin",
		CLAWDI_NO_AUTO_UPDATE: "1",
		CLAWDI_NO_UPDATE_CHECK: "1",
		CLAWDI_DESKTOP_RUNTIME: "/old/runtime",
	};
	expect(cliEnvironment(inherited, true)).toEqual({ PATH: "/bin" });
	expect(cliEnvironment({ PATH: "/bin" }, false, "/fallback/runtime")).toEqual({
		PATH: "/bin",
		CLAWDI_NO_AUTO_UPDATE: "1",
		CLAWDI_NO_UPDATE_CHECK: "1",
		CLAWDI_DESKTOP_RUNTIME: "/fallback/runtime",
	});
	expect(inherited.CLAWDI_NO_AUTO_UPDATE).toBe("1");
});

test("a compiled foreign CLI with local-self-update capabilities is not adopted", async () => {
	const { service, state, seedNative, launcher } = serviceFixture();
	seedNative("0.16.9");
	rmSync(join(dirname(realpathSync(launcher)), "clawdi-native-install.txt"));
	state.bootstrapStatus = "foreign-owner";
	expect(await service.usesNativeCli()).toBe(false);
	expect(existsSync(launcher)).toBe(true);
});

test("NSIS cleanup uses the installed bundle without bootstrapping a missing CLI", async () => {
	const { service, calls, invocations, state } = serviceFixture();
	service.useBundledCliForCleanup();
	await service.revokeDashboardSession("sess_fixture");
	await service.uninstall(true);
	expect(calls).toEqual([
		"auth desktop-sign-out --session-id sess_fixture --json",
		"uninstall --yes --remove-cli --json",
	]);
	expect(invocations.every((call) => call.path === state.executable)).toBe(true);
});

test("Desktop delegates full uninstall to the resolved CLI and preserves an unchecked CLI choice", async () => {
	const { service, seedNative, invocations, launcher } = serviceFixture();
	seedNative("0.16.9");
	await service.uninstall(false);
	expect(invocations.at(-1)).toMatchObject({
		path: launcher,
		args: ["uninstall", "--yes", "--json"],
		env: { CLAWDI_UNINSTALL_KEEP_CLI: "1" },
	});
	await service.uninstall(true);
	expect(invocations.at(-1)).toMatchObject({
		path: launcher,
		args: ["uninstall", "--yes", "--remove-cli", "--json"],
		env: { CLAWDI_UNINSTALL_KEEP_CLI: "0" },
	});
});

test("Desktop uninstall reports failed CLI cleanup without exposing raw output", async () => {
	const { service, state } = serviceFixture();
	state.failUninstall = true;
	await expect(service.uninstall(false)).rejects.toThrow("Some local cleanup failed");
});

test("Desktop uses the bundled uninstall implementation when a released native CLI predates it", async () => {
	const { service, state, seedNative, invocations, launcher } = serviceFixture();
	seedNative("0.16.9");
	state.nativeCommands = [];
	await service.uninstall(false);
	expect(invocations.at(-1)?.path).not.toBe(launcher);
	expect(invocations.at(-1)?.args).toEqual(["uninstall", "--yes", "--json"]);
});

test("Desktop checkbox ownership reads the validated native install metadata", async () => {
	const { service, seedNative, launcher } = serviceFixture();
	expect(await service.installedByDesktop()).toBe(false);
	seedNative("0.16.9");
	expect(await service.installedByDesktop()).toBe(false);
	const marker = join(dirname(realpathSync(launcher)), "clawdi-native-install.txt");
	writeFileSync(marker, readFileSync(marker, "utf8").replace(/\n$/, "\ninstalledBy\tdesktop\n"));
	expect(await service.installedByDesktop()).toBe(true);
});
