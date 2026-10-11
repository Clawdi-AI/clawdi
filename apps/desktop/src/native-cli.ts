import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
	DesktopAgentConnection,
	DesktopAgentType,
	DesktopAuthenticationProgress,
	DesktopBootstrapState,
	DesktopConnectResult,
	DesktopDashboardSession,
	DesktopDetectedAgent,
	DesktopReconnectCandidate,
	DesktopWebSession,
} from "@clawdi/shared/desktop";
import { isDesktopAgentType } from "@clawdi/shared/desktop";
import type { App } from "electron";
import {
	detectNativeInstall,
	type NativeCompiledIdentity,
} from "../../../packages/cli/src/lib/native-distribution";
import { isNativeBuildTarget } from "../../../packages/cli/src/lib/native-release-manifest";
import { activateAppImageRuntime, pruneAppImageRuntimes } from "./appimage-runtime";
import { managedAppImageCliCommandTarget, removeDesktopCliSymlink } from "./cli-command";
import {
	assertCompatibleCliSchema,
	DESKTOP_MIN_CLI_VERSION,
	DesktopCliCompatibilityError,
	DesktopCliError,
	meetsDesktopCliMinimum,
	nativeLauncherPath,
} from "./cli-compat";

export { DesktopCliError } from "./cli-compat";

import {
	CommandCancelledError,
	type CommandOptions,
	type CommandResult,
	runCommand,
} from "./command-runner";
import { desktopDaemonReconciliationAction, needsDaemonRuntimeRefresh } from "./daemon-runtime";
import { requireDesktopPlatform } from "./platform";

const OAUTH_TIMEOUT_MS = 11 * 60_000;
const PRODUCTION_CLOUD_API_URL = "https://cloud-api.clawdi.ai";
const PRODUCTION_DEPLOY_API_URL = "https://api.clawdi.ai";

const LOGGED_CLI_COMMANDS = new Set([
	"auth login",
	"auth logout",
	"auth status",
	"daemon install",
	"daemon uninstall",
	"daemon restart",
	"daemon stop",
	"daemon doctor",
	"agent detect",
	"agent reconnect",
	"update --native-identity",
	"setup",
	"config get",
	"config set",
]);

type NativeIdentity = NativeCompiledIdentity;

type AuthenticationResult =
	| { status: "authenticated"; user: { id: string; email?: string } }
	| { status: "cancelled" };

interface AuthenticationOperation {
	controller: AbortController;
	completion: Promise<AuthenticationResult>;
}

export class DesktopCliService {
	constructor(
		private readonly application: Pick<App, "isPackaged" | "getAppPath" | "getPath" | "getVersion">,
		private readonly execute: typeof runCommand = runCommand,
		private readonly resourcesPath = process.resourcesPath,
	) {}

	private authentication: AuthenticationOperation | null = null;
	private cliPath: string | null = null;
	private cliSource: "native" | "bundled" | null = null;
	private cliResolution: Promise<string> | null = null;
	private runtimeRoot: string | null = null;
	private runtimeReconciled = false;
	private runtimeVersion: string | null = null;
	private runtimeReconciliation: Promise<void> | null = null;
	private nativeIdentity: Promise<NativeIdentity> | null = null;

	async bootstrapState(): Promise<DesktopBootstrapState> {
		const cli = await this.resolveCli();
		const { identity, doctor } = await this.runtimeState(cli);
		const auth = await this.authState(cli);
		return {
			platform: requireDesktopPlatform(),
			cli: { status: "ready", version: identity.version },
			auth,
			daemon: { installed: doctor.installed, running: doctor.running },
		};
	}

	/** Called only after startup orchestration verifies this account's registrations. */
	async reconcileDaemonRuntime(verifiedAccountId: string): Promise<boolean> {
		const cli = await this.resolveCli();
		const { identity, doctor } = await this.runtimeState(cli);
		if (this.runtimeVersion !== null && this.runtimeVersion !== identity.version) {
			this.runtimeReconciled = false;
		}
		this.runtimeVersion = identity.version;
		const auth = await this.authState(cli);
		if (!auth.authenticated || auth.user?.id !== verifiedAccountId) {
			throw new Error("Sign-in changed during runtime recovery.");
		}
		if (
			desktopDaemonReconciliationAction({
				installed: doctor.installed,
				supervisorRunning: doctor.supervisorRunning,
				authenticated: auth.authenticated,
				alreadyReconciled: this.runtimeReconciled,
				isAppImage: this.isAppImage(),
				isNativeCli: this.cliSource === "native",
				liveRuntimeMismatch: doctor.needsRuntimeRefresh,
			}) === "install"
		) {
			this.runtimeReconciliation ??= this.installDaemon();
			try {
				await this.runtimeReconciliation;
			} finally {
				this.runtimeReconciliation = null;
			}
			return true;
		}
		return false;
	}

	async authenticate(
		onProgress?: (progress: DesktopAuthenticationProgress) => void,
	): Promise<AuthenticationResult> {
		if (this.authentication) return this.authentication.completion;

		const controller = new AbortController();
		const operation: AuthenticationOperation = {
			controller,
			completion: this.performAuthentication(controller.signal, onProgress),
		};
		this.authentication = operation;
		try {
			return await operation.completion;
		} finally {
			if (this.authentication === operation) this.authentication = null;
		}
	}

	async cancelAuthentication(): Promise<"cancelled" | "not-active"> {
		const operation = this.authentication;
		if (!operation) return "not-active";
		operation.controller.abort();
		try {
			return (await operation.completion).status === "cancelled" ? "cancelled" : "not-active";
		} catch {
			return "not-active";
		}
	}

	async createDashboardSession(
		session: DesktopWebSession | null = null,
	): Promise<DesktopDashboardSession> {
		try {
			const result = await this.runJson(await this.resolveCli(), [
				"auth",
				"desktop-session",
				"--json",
				...(session ? ["--session-user", session.userId, "--session-id", session.sessionId] : []),
			]);
			if (
				result.schemaVersion !== "clawdi.desktopSession.v1" ||
				typeof result.accountId !== "string" ||
				!result.accountId ||
				result.accountId.length > 256
			)
				throw new Error("Invalid Desktop session.");
			if (result.status === "signed-in" || result.status === "sign-out") {
				if (result.ticket != null || result.expiresIn !== 0)
					throw new Error("Invalid Desktop session.");
				return { status: result.status, accountId: result.accountId };
			}
			if (
				result.status !== "ticket" ||
				typeof result.ticket !== "string" ||
				!result.ticket ||
				result.ticket.length > 8192 ||
				typeof result.expiresIn !== "number" ||
				!Number.isSafeInteger(result.expiresIn) ||
				result.expiresIn <= 0 ||
				result.expiresIn > 60
			)
				throw new Error("Invalid Desktop session.");
			return { status: "ticket", ticket: result.ticket, accountId: result.accountId };
		} catch (error) {
			if (error instanceof DesktopCliCompatibilityError) throw error;
			// Never propagate native stdout/stderr from credential-bearing commands.
			throw new Error("Couldn't create a Desktop session. Sign in again from Clawdi.");
		}
	}

	async revokeDashboardSession(sessionId: string): Promise<void> {
		try {
			const result = await this.runJson(await this.resolveCli(), [
				"auth",
				"desktop-sign-out",
				"--session-id",
				sessionId,
				"--json",
			]);
			if (result.schemaVersion !== "clawdi.desktopSignOut.v1" || result.status !== "revoked")
				throw new Error("Invalid Desktop sign-out response.");
		} catch (error) {
			if (error instanceof DesktopCliCompatibilityError) throw error;
			throw new Error("Couldn't revoke the Desktop session. Try signing out again.");
		}
	}

	async logout(): Promise<void> {
		const cli = await this.resolveCli();
		try {
			await this.run(cli, ["daemon", "uninstall"], { timeoutMs: 60_000 });
		} finally {
			await this.run(cli, ["auth", "logout"], { timeoutMs: 30_000 });
		}
	}

	async detectAgents(): Promise<DesktopDetectedAgent[]> {
		const cli = await this.resolveCli();
		const result = await this.runJson(cli, ["agent", "detect", "--json"]);
		if (result.schemaVersion !== "clawdi.agentDetection.v1" || !Array.isArray(result.agents))
			throw new Error("Clawdi returned invalid agent detection data.");
		return result.agents.map(parseDetectedAgent);
	}

	async listReconnectableAgents(): Promise<DesktopReconnectCandidate[]> {
		const result = await this.runJson(await this.resolveCli(), ["agent", "reconnect", "--json"]);
		if (
			result.schemaVersion !== "clawdi.agentReconnectCandidates.v1" ||
			!Array.isArray(result.agents)
		) {
			throw new Error("Clawdi returned invalid reconnect data.");
		}
		return result.agents.map(parseReconnectCandidate);
	}

	async connectAgents(
		connections: readonly DesktopAgentConnection[],
	): Promise<DesktopConnectResult> {
		const requested = [...connections];
		const requestedTypes = new Set(requested.map((connection) => connection.type));
		if (
			requested.length === 0 ||
			requestedTypes.size !== requested.length ||
			requested.some((connection) => !isDesktopAgentType(connection.type))
		) {
			throw new Error("Choose at least one supported agent.");
		}

		const detected = await this.detectAgents();
		const available = new Map(detected.map((agent) => [agent.type, agent]));
		for (const { type, reconnectAgentId } of requested) {
			const agent = available.get(type);
			if (!agent?.detected && !agent?.registered) {
				throw new Error(`${displayNameFor(type)} is no longer available on this computer.`);
			}
			if (reconnectAgentId && agent.registered) {
				throw new Error(`${displayNameFor(type)} is already connected on this computer.`);
			}
		}

		const cli = await this.prepareDaemonCli();
		const connected: DesktopAgentType[] = [];
		for (const { type, reconnectAgentId, confirmTakeover } of requested) {
			if (reconnectAgentId) {
				const args = [
					"agent",
					"reconnect",
					reconnectAgentId,
					"--agent",
					type,
					"--yes",
					"--no-daemon",
				];
				if (confirmTakeover) args.push("--confirm-takeover");
				await this.run(cli, args, { timeoutMs: 3 * 60_000 });
			} else if (!available.get(type)?.registered) {
				await this.run(cli, ["setup", "--agent", type, "--yes", "--no-daemon"], {
					timeoutMs: 3 * 60_000,
				});
			}
			connected.push(type);
		}
		await this.installDaemon();
		return { connected, daemonInstalled: true };
	}

	async restartDaemon(): Promise<void> {
		await this.run(await this.resolveCli(), ["daemon", "restart"], { timeoutMs: 60_000 });
	}

	async installDaemon(): Promise<void> {
		await this.run(await this.prepareDaemonCli(), ["daemon", "install"], { timeoutMs: 60_000 });
		this.runtimeReconciled = true;
		if (this.isAppImage()) {
			try {
				const userData = this.application.getPath("userData");
				const launcherTarget = managedAppImageCliCommandTarget({
					home: this.application.getPath("home"),
					userData,
				});
				const protectedVersions = launcherTarget
					? new Set([basename(dirname(launcherTarget))])
					: undefined;
				await pruneAppImageRuntimes(
					userData,
					this.cliSource === "native" ? null : this.application.getVersion(),
					protectedVersions,
				);
			} catch (error) {
				console.warn("Could not remove an old Desktop runtime", error);
			}
		}
	}

	async stopDaemon(): Promise<void> {
		await this.run(await this.resolveCli(), ["daemon", "stop"], { timeoutMs: 60_000 });
	}

	async uninstallDaemon(): Promise<void> {
		await this.run(await this.resolveCli(), ["daemon", "uninstall"], { timeoutMs: 60_000 });
	}

	/** Project folders excluded from sync (`clawdi config get excludeProjects`). */
	async listExcludedProjects(): Promise<string[]> {
		const result = await this.runJson(await this.resolveCli(), ["config", "list", "--json"]);
		const values = isRecord(result.values) ? result.values : null;
		const entry = values && isRecord(values.excludeProjects) ? values.excludeProjects : null;
		if (
			result.schemaVersion !== "clawdi.config.v1" ||
			!entry ||
			!Array.isArray(entry.value) ||
			!entry.value.every((path) => typeof path === "string")
		) {
			throw new Error("Clawdi returned invalid config data.");
		}
		return entry.value;
	}

	/** Writes the list through `clawdi config`, which owns path normalization. */
	async setExcludedProjects(paths: readonly string[]): Promise<string[]> {
		for (const path of paths) {
			if (!isAbsolute(path) || path.length > 4_096) {
				throw new DesktopCliError("Choose a project folder on this computer.");
			}
			// `config set excludeProjects` takes a comma-separated list.
			if (path.includes(",")) {
				throw new DesktopCliError("Folders with a comma in their path can't be excluded yet.");
			}
		}
		const args =
			paths.length > 0
				? ["config", "set", "excludeProjects", paths.join(",")]
				: ["config", "unset", "excludeProjects"];
		await this.run(await this.resolveCli(), args, { timeoutMs: 20_000 });
		return this.listExcludedProjects();
	}

	async shellCommandTarget(): Promise<string> {
		const cli = await this.prepareDaemonCli();
		return this.cliSource === "native" ? cli : realpathSync(cli);
	}

	async pruneUnusedAppImageRuntimes(): Promise<void> {
		if (!this.isAppImage()) return;
		await pruneAppImageRuntimes(
			this.application.getPath("userData"),
			this.cliSource === "native" ? null : this.application.getVersion(),
		);
	}

	async usesNativeCli(): Promise<boolean> {
		await this.resolveCli();
		return this.cliSource === "native";
	}

	private async performAuthentication(
		signal: AbortSignal,
		onProgress?: (progress: DesktopAuthenticationProgress) => void,
	): Promise<AuthenticationResult> {
		try {
			const args = ["auth", "login", "--desktop"];
			const result = await this.runJson(await this.resolveCli(), args, {
				signal,
				timeoutMs: OAUTH_TIMEOUT_MS,
				onStderrLine: (line) => {
					let value: unknown;
					try {
						value = JSON.parse(line);
					} catch {
						return;
					}
					if (!isRecord(value)) return;
					assertCompatibleCliSchema(value.schemaVersion, "clawdi.desktopLogin.progress.v1");
					if (value.schemaVersion !== "clawdi.desktopLogin.progress.v1") return;
					const verificationUri = readString(value.verificationUri);
					const userCode = readString(value.userCode);
					const expiresAt = readString(value.expiresAt);
					if (
						!verificationUri ||
						verificationUri.length > 2_048 ||
						!userCode ||
						userCode.length > 512 ||
						!expiresAt ||
						!Number.isFinite(Date.parse(expiresAt))
					)
						throw new Error("Clawdi returned invalid sign-in progress.");
					const uri = new URL(verificationUri);
					if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash)
						throw new Error("Clawdi returned an invalid verification page.");
					onProgress?.({ verificationUri, userCode, expiresAt });
				},
			});
			if (result.schemaVersion === "clawdi.desktopLogin.v1" && result.status === "cancelled") {
				return { status: "cancelled" };
			}
			const user = isRecord(result.user) ? result.user : null;
			const id = user ? readString(user.id) : null;
			const email = user ? readString(user.email) : null;
			if (
				result.schemaVersion !== "clawdi.desktopLogin.v1" ||
				readString(result.status) !== "authenticated" ||
				!id
			) {
				throw new Error("Clawdi returned an invalid sign-in result.");
			}
			return { status: "authenticated", user: { id, ...(email ? { email } : {}) } };
		} catch (error) {
			if (error instanceof CommandCancelledError) return { status: "cancelled" };
			throw error;
		}
	}

	private async resolveCli(): Promise<string> {
		this.cliResolution ??= this.selectCli();
		const cli = await this.cliResolution;
		return this.runtimeRoot ? join(this.runtimeRoot, "clawdi") : cli;
	}

	private async selectCli(): Promise<string> {
		const platform = requireDesktopPlatform();
		const home = this.application.getPath("home");
		const launcher = nativeLauncherPath(platform, home);
		if (await this.usableNativeCli(launcher)) {
			this.cliSource = "native";
			return launcher;
		}
		this.cliPath = this.resolveBundledCli();
		try {
			if (platform !== "win32") {
				removeDesktopCliSymlink({
					home,
					userData: this.application.getPath("userData"),
					bundledCli: this.cliPath,
				});
			}
			const result = await this.runJson(
				this.cliPath,
				["update", "--native-bootstrap", "--min-version", DESKTOP_MIN_CLI_VERSION, "--json"],
				{ timeoutMs: 3 * 60_000 },
			);
			if (
				result.schemaVersion === "clawdi.nativeBootstrap.v1" &&
				(result.status === "installed" ||
					result.status === "already-current" ||
					result.status === "upgraded") &&
				(await this.usableNativeCli(launcher))
			) {
				this.cliSource = "native";
				return launcher;
			}
		} catch (error) {
			if (error instanceof DesktopCliCompatibilityError) throw error;
			// Bootstrap returns nonzero for foreign-owner and failed. Neither
			// changes the selected launcher; retry only on the next app launch.
			console.warn("Native CLI bootstrap unavailable; using bundled runtime this session");
		}
		this.cliSource = "bundled";
		return this.cliPath;
	}

	private async usableNativeCli(launcher: string): Promise<boolean> {
		if (!existsSync(launcher)) return false;
		try {
			const identity = await this.readIdentity(launcher);
			if (!meetsDesktopCliMinimum(identity.version)) return false;
			if (!detectNativeInstall(launcher, identity)) return false;
			const result = await this.runJson(launcher, ["capabilities", "--json"]);
			return (
				result.schemaVersion === "clawdi.capabilities.v1" &&
				isRecord(result.capabilities) &&
				result.capabilities.updateMode === "local-self-update"
			);
		} catch (error) {
			if (error instanceof DesktopCliCompatibilityError) throw error;
			return false;
		}
	}

	private isAppImage(): boolean {
		return (
			this.application.isPackaged && process.platform === "linux" && Boolean(process.env.APPIMAGE)
		);
	}

	private async prepareDaemonCli(): Promise<string> {
		const cli = await this.resolveCli();
		if (this.cliSource === "native") return cli;
		if (this.isAppImage()) {
			this.cliPath ??= this.resolveBundledCli();
			this.runtimeRoot = await activateAppImageRuntime(
				dirname(this.cliPath),
				this.application.getPath("userData"),
				this.application.getVersion(),
			);
		}
		return this.resolveCli();
	}

	private expectedDaemonCli(cli: string): string {
		const path =
			this.isAppImage() && this.cliSource === "bundled"
				? join(
						this.application.getPath("userData"),
						"runtimes",
						this.application.getVersion(),
						"clawdi",
					)
				: cli;
		return existsSync(path) ? realpathSync(path) : resolve(path);
	}

	private resolveBundledCli(): string {
		const override = this.application.isPackaged ? null : process.env.CLAWDI_DESKTOP_CLI?.trim();
		if (override) {
			if (!existsSync(override)) throw new Error("CLAWDI_DESKTOP_CLI does not exist.");
			return resolve(override);
		}

		const resourceRoot = this.application.isPackaged
			? join(this.resourcesPath, "native")
			: join(this.application.getAppPath(), "resources", "native");
		const bundledCli = join(resourceRoot, process.platform === "win32" ? "clawdi.exe" : "clawdi");
		if (!existsSync(bundledCli)) {
			throw new Error("The bundled Clawdi runtime is missing. Reinstall the desktop app.");
		}
		return bundledCli;
	}

	private async identity(cli: string): Promise<NativeIdentity> {
		if (this.nativeIdentity) return this.nativeIdentity;
		const loading = this.readIdentity(cli);
		this.nativeIdentity = loading;
		try {
			return await loading;
		} finally {
			// A package manager may replace the bundled CLI while Desktop stays
			// open. Deduplicate in-flight reads, but do not cache a version forever.
			if (this.nativeIdentity === loading) this.nativeIdentity = null;
		}
	}

	private async readIdentity(cli: string): Promise<NativeIdentity> {
		let result: CommandResult;
		try {
			result = await this.run(cli, ["update", "--native-identity"], { timeoutMs: 20_000 });
		} catch (cause) {
			throw runtimeStartError(cause);
		}
		const [version, target, extra] = result.stdout.trim().split("\t");
		if (
			!version ||
			!target ||
			!isNativeBuildTarget(target) ||
			target !== `${process.platform}-${process.arch}` ||
			extra ||
			!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)
		) {
			throw new Error("The bundled Clawdi runtime has an invalid identity.");
		}
		return { version, target };
	}

	private async authState(cli: string): Promise<DesktopBootstrapState["auth"]> {
		let result: Record<string, unknown>;
		try {
			result = await this.runJson(cli, ["auth", "status", "--json"]);
		} catch (cause) {
			if (cause instanceof DesktopCliCompatibilityError) throw cause;
			throw new DesktopCliError("Couldn't read the local sign-in state.", { cause });
		}
		if (result.schemaVersion !== "clawdi.authStatus.v1")
			throw new Error("Clawdi returned invalid authentication data.");
		const authenticated =
			result.authenticated === true && readString(result.credentialType) === "clerk-oauth";
		const email = isRecord(result.user) ? readString(result.user.email) : null;
		const user = isRecord(result.user)
			? { id: readString(result.user.id) ?? "", ...(email ? { email } : {}) }
			: null;
		return { authenticated, user: user?.id ? user : null };
	}

	private async runtimeState(cli: string) {
		// The stable launcher may advance between identity and doctor. Retry
		// that pair once, without bootstrapping or pinning the old executable.
		for (let attempt = 0; attempt < 2; attempt++) {
			const identity = await this.identity(cli);
			try {
				return { identity, doctor: await this.doctorState(cli, identity.version) };
			} catch (error) {
				if (!(error instanceof CliVersionChangedError) || attempt === 1) throw error;
			}
		}
		throw new CliVersionChangedError("The Clawdi CLI changed during startup. Try again.");
	}

	private async doctorState(
		cli: string,
		version: string,
	): Promise<
		DesktopBootstrapState["daemon"] & { needsRuntimeRefresh: boolean; supervisorRunning: boolean }
	> {
		const result = await this.runJson(cli, ["daemon", "doctor", "--json"]);
		if (result.schemaVersion !== "clawdi.daemonDoctor.v2")
			throw new Error("Clawdi returned invalid daemon data.");
		if (result.cli_version !== version)
			throw new CliVersionChangedError("Clawdi doctor returned an unexpected CLI version.");
		const installed = result.singleton_unit_installed === true;
		const agents = Array.isArray(result.agents) ? result.agents : [];
		const running =
			result.singleton_unit_running === true &&
			agents.some(
				(agent) =>
					isRecord(agent) && isRecord(agent.heartbeat) && agent.heartbeat.status === "live",
			);
		const daemons = agents
			.filter(isRecord)
			.filter(
				(agent) =>
					result.singleton_unit_running === true &&
					isRecord(agent.heartbeat) &&
					agent.heartbeat.status === "live",
			)
			.map((agent) => ({
				version: readString(agent.daemon_version),
				executable: readString(agent.daemon_executable),
			}));
		return {
			installed,
			running,
			supervisorRunning: result.singleton_unit_running === true,
			needsRuntimeRefresh: needsDaemonRuntimeRefresh(version, this.expectedDaemonCli(cli), daemons),
		};
	}

	private async runJson(
		cli: string,
		args: string[],
		opts: CommandOptions = {},
	): Promise<Record<string, unknown>> {
		const result = await this.run(cli, args, opts);
		let value: unknown;
		try {
			value = JSON.parse(result.stdout);
		} catch {
			throw new Error("Clawdi returned invalid structured output.");
		}
		if (!isRecord(value)) throw new Error("Clawdi returned invalid structured output.");
		const schema = CLI_SCHEMAS[args.slice(0, 2).join(" ")];
		if (schema) assertCompatibleCliSchema(value.schemaVersion, schema);
		return value;
	}

	private async run(
		cli: string,
		args: string[],
		opts: CommandOptions = {},
	): Promise<CommandResult> {
		// Only fixed command names are diagnostic data; argv/stdin/output can contain secrets.
		const name = args[0] === "setup" ? "setup" : args.slice(0, 2).join(" ");
		const command = LOGGED_CLI_COMMANDS.has(name) ? name : "other";
		const started = Date.now();
		console.info("CLI invocation started", command);
		try {
			const result = await this.execute(cli, args, {
				...opts,
				env: {
					...cliEnvironment(
						process.env,
						cli === nativeLauncherPath(process.platform, this.application.getPath("home")),
						this.runtimeRoot,
					),
					...(this.application.isPackaged
						? {
								CLAWDI_API_URL: PRODUCTION_CLOUD_API_URL,
								CLAWDI_DEPLOY_API_URL: PRODUCTION_DEPLOY_API_URL,
							}
						: {}),
				},
			});
			console.info("CLI invocation completed", { command, elapsedMs: Date.now() - started });
			return result;
		} catch (error) {
			console.warn("CLI invocation failed", {
				command,
				elapsedMs: Date.now() - started,
				cancelled: error instanceof CommandCancelledError,
			});
			throw error;
		}
	}
}

class CliVersionChangedError extends DesktopCliError {}

const CLI_SCHEMAS: Record<string, string> = {
	"capabilities --json": "clawdi.capabilities.v1",
	"update --native-bootstrap": "clawdi.nativeBootstrap.v1",
	"auth status": "clawdi.authStatus.v1",
	"auth desktop-session": "clawdi.desktopSession.v1",
	"auth desktop-sign-out": "clawdi.desktopSignOut.v1",
	"auth login": "clawdi.desktopLogin.v1",
	"agent detect": "clawdi.agentDetection.v1",
	"agent reconnect": "clawdi.agentReconnectCandidates.v1",
	"config list": "clawdi.config.v1",
	"daemon doctor": "clawdi.daemonDoctor.v2",
};

export function cliEnvironment(
	inherited: NodeJS.ProcessEnv,
	native: boolean,
	runtimeRoot: string | null = null,
): NodeJS.ProcessEnv {
	const env = { ...inherited };
	if (native) {
		delete env.CLAWDI_NO_AUTO_UPDATE;
		delete env.CLAWDI_NO_UPDATE_CHECK;
		delete env.CLAWDI_DESKTOP_RUNTIME;
	} else {
		env.CLAWDI_NO_AUTO_UPDATE = "1";
		env.CLAWDI_NO_UPDATE_CHECK = "1";
		if (runtimeRoot) env.CLAWDI_DESKTOP_RUNTIME = runtimeRoot;
	}
	return env;
}

function runtimeStartError(cause: unknown): DesktopCliError {
	const code = isRecord(cause) ? readString(cause.code) : null;
	if (code === "EACCES" || code === "EPERM") {
		return new DesktopCliError("The operating system blocked the bundled Clawdi runtime.", {
			cause,
		});
	}
	if (code === "ENOENT") {
		return new DesktopCliError("The bundled Clawdi runtime is missing. Reinstall Clawdi.", {
			cause,
		});
	}
	return new DesktopCliError("The bundled Clawdi runtime couldn't start. Reinstall Clawdi.", {
		cause,
	});
}

function parseDetectedAgent(value: unknown): DesktopDetectedAgent {
	if (!isRecord(value) || !isDesktopAgentType(value.type)) {
		throw new Error("Clawdi returned an unsupported agent type.");
	}
	const displayName = readString(value.displayName);
	const inspection =
		value.inspection === "complete" || value.inspection === "failed" ? value.inspection : null;
	if (!displayName || !inspection) throw new Error("Clawdi returned invalid agent details.");
	return {
		type: value.type,
		displayName,
		detected: value.detected === true,
		registered: value.registered === true,
		version: readString(value.version),
		inspection,
	};
}

function parseReconnectCandidate(value: unknown): DesktopReconnectCandidate {
	if (!isRecord(value) || !isDesktopAgentType(value.type)) {
		throw new Error("Clawdi returned an unsupported reconnect candidate.");
	}
	const id = readString(value.id);
	const displayName = readString(value.displayName);
	const name = readString(value.name);
	const machineName = readString(value.machineName);
	const lastSyncAt = value.lastSyncAt === null ? null : readString(value.lastSyncAt);
	if (
		!id ||
		!displayName ||
		!name ||
		!machineName ||
		typeof value.isThisMachine !== "boolean" ||
		(value.lastSyncAt !== null && !lastSyncAt)
	) {
		throw new Error("Clawdi returned invalid reconnect data.");
	}
	return {
		id,
		type: value.type,
		displayName,
		name,
		machineName,
		isThisMachine: value.isThisMachine,
		lastSyncAt,
	};
}

function displayNameFor(type: DesktopAgentType): string {
	return (
		{
			claude_code: "Claude Code",
			codex: "Codex",
			openclaw: "OpenClaw",
			hermes: "Hermes",
			pi: "Pi",
			opencode: "OpenCode",
			dsh: "DeepSeek Harness",
		} satisfies Record<DesktopAgentType, string>
	)[type];
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
