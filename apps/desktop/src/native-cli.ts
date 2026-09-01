import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	DesktopAgentType,
	DesktopBootstrapState,
	DesktopConnectResult,
	DesktopDetectedAgent,
} from "@clawdi/shared/desktop";
import { isDesktopAgentType } from "@clawdi/shared/desktop";
import { app } from "electron";

import {
	CommandCancelledError,
	type CommandOptions,
	type CommandResult,
	runCommand,
} from "./command-runner";

const OAUTH_TIMEOUT_MS = 11 * 60_000;
const PRODUCTION_CLOUD_API_URL = "https://cloud-api.clawdi.ai";
const PRODUCTION_DEPLOY_API_URL = "https://api.clawdi.ai";

interface NativeIdentity {
	version: string;
	target: string;
}

type AuthenticationStatus = "authenticated" | "cancelled";

interface AuthenticationOperation {
	controller: AbortController;
	completion: Promise<AuthenticationStatus>;
}

export class DesktopCliService {
	private authentication: AuthenticationOperation | null = null;
	private cliPath: string | null = null;
	private nativeIdentity: Promise<NativeIdentity> | null = null;

	async bootstrapState(): Promise<DesktopBootstrapState> {
		const cli = this.cli();
		const identity = await this.identity(cli);
		const auth = await this.authState(cli);
		const doctor = auth.authenticated
			? await this.doctorState(cli)
			: { installed: false, running: false };
		return {
			platform: desktopPlatform(),
			cli: { status: "ready", version: identity.version },
			auth,
			daemon: doctor,
		};
	}

	async authenticate(force = false): Promise<AuthenticationStatus> {
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
			return (await operation.completion) === "cancelled" ? "cancelled" : "not-active";
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
		try {
			await this.run(cli, ["daemon", "uninstall"], { timeoutMs: 60_000 });
		} catch (error) {
			console.error("Could not stop background sync during sign out", error);
		}
		await this.run(cli, ["auth", "logout"], { timeoutMs: 30_000 });
	}

	async resumeBackgroundSync(): Promise<void> {
		const registered = (await this.detectAgents()).filter((agent) => agent.registered);
		if (registered.length === 0) return;
		await this.run(this.cli(), ["daemon", "install"], { timeoutMs: 60_000 });
	}

	async detectAgents(): Promise<DesktopDetectedAgent[]> {
		const cli = this.cli();
		const result = await this.runJson(cli, ["agent", "detect", "--json"]);
		if (!Array.isArray(result.agents))
			throw new Error("Clawdi returned invalid agent detection data.");
		return result.agents.map(parseDetectedAgent);
	}

	async connectAgents(agentTypes: readonly DesktopAgentType[]): Promise<DesktopConnectResult> {
		const requested = [...new Set(agentTypes)];
		if (requested.length === 0 || requested.some((type) => !isDesktopAgentType(type))) {
			throw new Error("Choose at least one supported Agent.");
		}

		const cli = this.cli();
		const detected = await this.detectAgents();
		const available = new Map(detected.map((agent) => [agent.type, agent]));
		for (const type of requested) {
			const agent = available.get(type);
			if (!agent?.detected && !agent?.registered) {
				throw new Error(`${displayNameFor(type)} is no longer available on this Mac.`);
			}
		}

		const connected: DesktopAgentType[] = [];
		for (const type of requested) {
			if (!available.get(type)?.registered) {
				await this.run(cli, ["setup", "--agent", type, "--yes", "--no-daemon"], {
					timeoutMs: 3 * 60_000,
				});
			}
			connected.push(type);
		}
		await this.run(cli, ["daemon", "install"], { timeoutMs: 60_000 });
		return { connected, daemonInstalled: true };
	}

	async restartDaemon(): Promise<void> {
		await this.run(this.cli(), ["daemon", "restart"]);
	}

	private async performAuthentication(
		signal: AbortSignal,
		force: boolean,
	): Promise<AuthenticationStatus> {
		try {
			const args = ["auth", "login", "--desktop"];
			if (force) args.push("--force");
			const result = await this.runJson(this.cli(), args, {
				signal,
				timeoutMs: OAUTH_TIMEOUT_MS,
			});
			if (readString(result.status) !== "authenticated") {
				throw new Error("Clawdi returned an invalid sign-in result.");
			}
			return "authenticated";
		} catch (error) {
			if (error instanceof CommandCancelledError) return "cancelled";
			throw error;
		}
	}

	private cli(): string {
		this.cliPath ??= this.resolveBundledCli();
		return this.cliPath;
	}

	private resolveBundledCli(): string {
		const override = app.isPackaged ? null : process.env.CLAWDI_DESKTOP_CLI?.trim();
		if (override) {
			if (!existsSync(override)) throw new Error("CLAWDI_DESKTOP_CLI does not exist.");
			return resolve(override);
		}

		const resourceRoot = app.isPackaged
			? join(process.resourcesPath, "native")
			: join(app.getAppPath(), "resources", "native");
		const bundledCli = join(resourceRoot, "clawdi");
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
		} catch (error) {
			if (this.nativeIdentity === loading) this.nativeIdentity = null;
			throw error;
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
		if (!version || !target || extra || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
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

	private async doctorState(cli: string): Promise<DesktopBootstrapState["daemon"]> {
		const result = await this.runJson(cli, ["daemon", "doctor", "--json"]);
		const installed = result.singleton_unit_installed === true;
		const agents = Array.isArray(result.agents) ? result.agents : [];
		const running = agents.some(
			(agent) => isRecord(agent) && isRecord(agent.heartbeat) && agent.heartbeat.status === "live",
		);
		return { installed, running };
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
		return runCommand(cli, args, {
			...opts,
			env: {
				...process.env,
				CLAWDI_NO_AUTO_UPDATE: "1",
				CLAWDI_NO_UPDATE_CHECK: "1",
				...(app.isPackaged
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
		return new DesktopCliError("macOS blocked the bundled Clawdi runtime.", { cause });
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

function desktopPlatform(): DesktopBootstrapState["platform"] {
	if (
		process.platform === "darwin" ||
		process.platform === "linux" ||
		process.platform === "win32"
	) {
		return process.platform;
	}
	throw new Error(`Unsupported desktop platform: ${process.platform}`);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
