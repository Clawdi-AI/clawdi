import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	DesktopAgentType,
	DesktopBootstrapState,
	DesktopConnectResult,
	DesktopDashboardState,
	DesktopDetectedAgent,
	DesktopLocalSession,
	DesktopLocalSessionDetail,
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

	async authenticate(): Promise<AuthenticationStatus> {
		if (this.authentication) return this.authentication.completion;

		const controller = new AbortController();
		const operation: AuthenticationOperation = {
			controller,
			completion: this.performAuthentication(controller.signal),
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

	async dashboardState(): Promise<DesktopDashboardState> {
		const cli = this.cli();
		const [auth, daemon, result] = await Promise.all([
			this.authState(cli).catch(() => ({ authenticated: false as const, user: null })),
			this.doctorState(cli).catch(() => ({ installed: false, running: false })),
			this.runJsonValue(cli, ["session", "list", "--all-agents", "--limit", "200", "--json"]),
		]);
		if (!Array.isArray(result)) throw new Error("Clawdi returned invalid local session data.");
		return { auth, daemon, sessions: result.map(parseLocalSession) };
	}

	async readLocalSession(
		agent: DesktopAgentType,
		sessionId: string,
	): Promise<DesktopLocalSessionDetail> {
		const result = await this.runJson(this.cli(), [
			"session",
			"read-local",
			sessionId,
			"--agent",
			agent,
			"--json",
		]);
		if (result.schema_version !== "clawdi.desktopLocalSession.v1") {
			throw new Error("Clawdi returned incompatible local session data.");
		}
		const session = parseLocalSession(result.session);
		if (session.agent !== agent || session.id !== sessionId || !Array.isArray(result.messages)) {
			throw new Error("Clawdi returned invalid local session data.");
		}
		return { session, messages: result.messages.map(parseLocalSessionMessage) };
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

	private async performAuthentication(signal: AbortSignal): Promise<AuthenticationStatus> {
		try {
			const result = await this.runJson(this.cli(), ["auth", "login", "--desktop"], {
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
		const value = await this.runJsonValue(cli, args, opts);
		if (!isRecord(value)) throw new Error("Clawdi returned invalid structured output.");
		return value;
	}

	private async runJsonValue(
		cli: string,
		args: string[],
		opts: CommandOptions = {},
	): Promise<unknown> {
		const result = await this.run(cli, args, opts);
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new Error("Clawdi returned invalid structured output.");
		}
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

function parseLocalSession(value: unknown): DesktopLocalSession {
	if (!isRecord(value) || !isDesktopAgentType(value.agent)) {
		throw new Error("Clawdi returned invalid local session data.");
	}
	const id = readString(value.id);
	const agentName = readString(value.agent_name);
	const startedAt = readDateString(value.started_at);
	const endedAt = value.ended_at === null ? null : readDateString(value.ended_at);
	if (
		!id ||
		!agentName ||
		!startedAt ||
		(value.ended_at !== null && !endedAt) ||
		!Number.isSafeInteger(value.message_count) ||
		(value.message_count as number) < 0 ||
		(value.duration_seconds !== null &&
			(typeof value.duration_seconds !== "number" || value.duration_seconds < 0))
	) {
		throw new Error("Clawdi returned invalid local session data.");
	}
	return {
		id,
		agent: value.agent,
		agentName,
		project: nullableString(value.project),
		startedAt,
		endedAt,
		messageCount: value.message_count as number,
		durationSeconds: value.duration_seconds as number | null,
		model: nullableString(value.model),
		summary: nullableString(value.summary),
	};
}

function parseLocalSessionMessage(value: unknown): DesktopLocalSessionDetail["messages"][number] {
	if (
		!isRecord(value) ||
		(value.role !== "user" && value.role !== "assistant") ||
		typeof value.content !== "string"
	) {
		throw new Error("Clawdi returned invalid local session messages.");
	}
	const timestamp = value.timestamp === null ? null : readDateString(value.timestamp);
	if (value.timestamp !== null && !timestamp) {
		throw new Error("Clawdi returned invalid local session messages.");
	}
	return {
		role: value.role,
		content: value.content,
		model: nullableString(value.model),
		timestamp,
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

function nullableString(value: unknown): string | null {
	return value === null ? null : readString(value);
}

function readDateString(value: unknown): string | null {
	const raw = readString(value);
	return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
