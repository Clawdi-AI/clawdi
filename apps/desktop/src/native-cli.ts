import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
	DesktopAgentConnection,
	DesktopAgentType,
	DesktopBootstrapState,
	DesktopConnectResult,
	DesktopDetectedAgent,
	DesktopReconnectCandidate,
} from "@clawdi/shared/desktop";
import { isDesktopAgentType } from "@clawdi/shared/desktop";
import type { App } from "electron";
import { activateAppImageRuntime, pruneAppImageRuntimes } from "./appimage-runtime";
import { managedAppImageCliCommandTarget } from "./cli-command";
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

interface NativeIdentity {
	version: string;
	target: string;
}

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
	private runtimeRoot: string | null = null;
	private runtimeReconciled = false;
	private runtimeVersion: string | null = null;
	private runtimeReconciliation: Promise<void> | null = null;
	private nativeIdentity: Promise<NativeIdentity> | null = null;

	async bootstrapState(): Promise<DesktopBootstrapState> {
		const cli = this.cli();
		const identity = await this.identity(cli);
		const auth = await this.authState(cli);
		const doctor = await this.doctorState(cli, identity.version);
		return {
			platform: requireDesktopPlatform(),
			cli: { status: "ready", version: identity.version },
			auth,
			daemon: { installed: doctor.installed, running: doctor.running },
		};
	}

	/** Called only after startup orchestration verifies this account's registrations. */
	async reconcileDaemonRuntime(verifiedAccountId: string): Promise<boolean> {
		const cli = this.cli();
		const identity = await this.identity(cli);
		if (this.runtimeVersion !== null && this.runtimeVersion !== identity.version) {
			this.runtimeReconciled = false;
		}
		this.runtimeVersion = identity.version;
		const auth = await this.authState(cli);
		if (!auth.authenticated || auth.user?.id !== verifiedAccountId) {
			throw new Error("Sign-in changed during runtime recovery.");
		}
		const doctor = await this.doctorState(cli, identity.version);
		if (
			desktopDaemonReconciliationAction({
				installed: doctor.installed,
				supervisorRunning: doctor.supervisorRunning,
				authenticated: auth.authenticated,
				alreadyReconciled: this.runtimeReconciled,
				isAppImage: this.isAppImage(),
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

	async getAuthState(): Promise<DesktopBootstrapState["auth"]> {
		return this.authState(this.cli());
	}

	async authenticate(force = false): Promise<AuthenticationResult> {
		if (this.authentication) return this.authentication.completion;

		const controller = new AbortController();
		const operation: AuthenticationOperation = {
			controller,
			completion: this.performAuthentication(controller.signal, force),
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

	async createDashboardSession(): Promise<string> {
		const cli = this.cli();
		const result = await this.runJson(cli, ["auth", "desktop-session", "--json"]);
		const ticket = readString(result.ticket);
		const expiresIn = typeof result.expiresIn === "number" ? result.expiresIn : 0;
		if (!ticket || ticket.length > 8192 || expiresIn <= 0 || expiresIn > 120) {
			throw new Error("Clawdi returned an invalid desktop sign-in session.");
		}
		return ticket;
	}

	async logout(): Promise<void> {
		const cli = this.cli();
		await this.run(cli, ["daemon", "uninstall"], { timeoutMs: 60_000 });
		await this.run(cli, ["auth", "logout"], { timeoutMs: 30_000 });
	}

	async detectAgents(): Promise<DesktopDetectedAgent[]> {
		const cli = this.cli();
		const result = await this.runJson(cli, ["agent", "detect", "--json"]);
		if (!Array.isArray(result.agents))
			throw new Error("Clawdi returned invalid agent detection data.");
		return result.agents.map(parseDetectedAgent);
	}

	async listReconnectableAgents(): Promise<DesktopReconnectCandidate[]> {
		const result = await this.runJson(this.cli(), ["agent", "reconnect", "--desktop-list"]);
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
			throw new Error("Choose at least one supported Agent.");
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
		await this.run(this.cli(), ["daemon", "restart"], { timeoutMs: 60_000 });
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
				await pruneAppImageRuntimes(userData, this.application.getVersion(), protectedVersions);
			} catch (error) {
				console.warn("Could not remove an old Desktop runtime", error);
			}
		}
	}

	async stopDaemon(): Promise<void> {
		await this.run(this.cli(), ["daemon", "stop"], { timeoutMs: 60_000 });
	}

	async uninstallDaemon(): Promise<void> {
		await this.run(this.cli(), ["daemon", "uninstall"], { timeoutMs: 60_000 });
	}

	async shellCommandTarget(): Promise<string> {
		return realpathSync(this.isAppImage() ? await this.prepareDaemonCli() : this.cli());
	}

	async pruneUnusedAppImageRuntimes(): Promise<void> {
		if (!this.isAppImage()) return;
		await pruneAppImageRuntimes(
			this.application.getPath("userData"),
			this.application.getVersion(),
		);
	}

	private async performAuthentication(
		signal: AbortSignal,
		force: boolean,
	): Promise<AuthenticationResult> {
		try {
			const args = ["auth", "login", "--desktop"];
			if (force) args.push("--force");
			const result = await this.runJson(this.cli(), args, {
				signal,
				timeoutMs: OAUTH_TIMEOUT_MS,
			});
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

	private cli(): string {
		this.cliPath ??= this.resolveBundledCli();
		return this.runtimeRoot ? join(this.runtimeRoot, "clawdi") : this.cliPath;
	}

	private isAppImage(): boolean {
		return (
			this.application.isPackaged && process.platform === "linux" && Boolean(process.env.APPIMAGE)
		);
	}

	private async prepareDaemonCli(): Promise<string> {
		if (this.isAppImage()) {
			this.cliPath ??= this.resolveBundledCli();
			this.runtimeRoot = await activateAppImageRuntime(
				dirname(this.cliPath),
				this.application.getPath("userData"),
				this.application.getVersion(),
			);
		}
		return this.cli();
	}

	private expectedDaemonCli(): string {
		const path = this.isAppImage()
			? join(
					this.application.getPath("userData"),
					"runtimes",
					this.application.getVersion(),
					"clawdi",
				)
			: this.cli();
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
			throw new DesktopCliError("Could not read the local sign-in state.", { cause });
		}
		const authenticated =
			result.authenticated === true && readString(result.credentialType) === "clerk-oauth";
		const email = isRecord(result.user) ? readString(result.user.email) : null;
		const user = isRecord(result.user)
			? { id: readString(result.user.id) ?? "", ...(email ? { email } : {}) }
			: null;
		return { authenticated, user: user?.id ? user : null };
	}

	private async doctorState(
		cli: string,
		version: string,
	): Promise<
		DesktopBootstrapState["daemon"] & { needsRuntimeRefresh: boolean; supervisorRunning: boolean }
	> {
		const result = await this.runJson(cli, ["daemon", "doctor", "--json"]);
		if (result.cli_version !== version)
			throw new Error("Clawdi doctor returned an unexpected CLI version.");
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
			needsRuntimeRefresh: needsDaemonRuntimeRefresh(version, this.expectedDaemonCli(), daemons),
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
		return value;
	}

	private run(cli: string, args: string[], opts: CommandOptions = {}): Promise<CommandResult> {
		return this.execute(cli, args, {
			...opts,
			env: {
				...process.env,
				CLAWDI_NO_AUTO_UPDATE: "1",
				...(this.runtimeRoot ? { CLAWDI_DESKTOP_RUNTIME: this.runtimeRoot } : {}),
				CLAWDI_NO_UPDATE_CHECK: "1",
				...(this.application.isPackaged
					? {
							CLAWDI_API_URL: PRODUCTION_CLOUD_API_URL,
							CLAWDI_DEPLOY_API_URL: PRODUCTION_DEPLOY_API_URL,
						}
					: {}),
			},
		});
	}
}

export class DesktopCliError extends Error {}

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
	return new DesktopCliError("The bundled Clawdi runtime could not start. Reinstall Clawdi.", {
		cause,
	});
}

function parseDetectedAgent(value: unknown): DesktopDetectedAgent {
	if (!isRecord(value) || !isDesktopAgentType(value.type)) {
		throw new Error("Clawdi returned an unsupported Agent type.");
	}
	const displayName = readString(value.displayName);
	const inspection =
		value.inspection === "complete" || value.inspection === "failed" ? value.inspection : null;
	if (!displayName || !inspection) throw new Error("Clawdi returned invalid Agent details.");
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
		} satisfies Record<DesktopAgentType, string>
	)[type];
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
