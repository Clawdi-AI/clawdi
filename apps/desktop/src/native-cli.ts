import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	DesktopAgentType,
	DesktopBootstrapState,
	DesktopConnectResult,
	DesktopDetectedAgent,
} from "@clawdi/shared/desktop";
import { isDesktopAgentType } from "@clawdi/shared/desktop";
import { app } from "electron";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface CommandResult {
	stdout: string;
	stderr: string;
}

interface NativeIdentity {
	version: string;
	target: string;
}

export class DesktopCliService {
	private cliPromise: Promise<string> | null = null;

	async bootstrapState(): Promise<DesktopBootstrapState> {
		const cli = await this.cli();
		const [identity, auth, doctor] = await Promise.all([
			this.identity(cli),
			this.authState(cli),
			this.doctorState(cli),
		]);
		return {
			platform: desktopPlatform(),
			cli: { status: "ready", version: identity.version },
			auth,
			daemon: doctor,
		};
	}

	async startAuthentication(): Promise<{
		authorizationUrl: string;
		redirectUri: string;
		expiresAt: string;
	} | null> {
		const cli = await this.cli();
		const result = await this.runJson(cli, ["auth", "start", "--json"]);
		if (readString(result.status) === "already_authenticated") return null;
		const authorizationUrl = readUrl(result.authorizationUrl, "authorization URL", ["https:"]);
		const redirectUri = readUrl(result.redirectUri, "redirect URI", ["http:"]);
		const expiresAt = readString(result.expiresAt);
		if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
			throw new Error("Clawdi returned an invalid authorization expiry.");
		}
		return { authorizationUrl, redirectUri, expiresAt };
	}

	async finishAuthentication(callbackUrl: string): Promise<void> {
		const cli = await this.cli();
		await this.run(cli, ["auth", "finish", "--json"], {
			stdin: callbackUrl,
			timeoutMs: DEFAULT_TIMEOUT_MS,
		});
	}

	async detectAgents(): Promise<DesktopDetectedAgent[]> {
		const cli = await this.cli();
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

		const cli = await this.cli();
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

	private cli(): Promise<string> {
		this.cliPromise ??= this.activateManagedCli();
		return this.cliPromise;
	}

	private async activateManagedCli(): Promise<string> {
		const override = process.env.CLAWDI_DESKTOP_CLI?.trim();
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
		const bundledIdentity = await this.identity(bundledCli);
		const prefix = join(homedir(), ".local");
		const launcher = join(prefix, "bin", "clawdi");
		if (existsSync(launcher)) {
			try {
				const installedIdentity = await this.identity(launcher);
				if (
					installedIdentity.version === bundledIdentity.version &&
					installedIdentity.target === bundledIdentity.target
				) {
					return launcher;
				}
			} catch {
				// Native activation below owns the collision decision and error message.
			}
		}

		const nativeRoot = join(prefix, "share", "clawdi");
		mkdirSync(nativeRoot, { recursive: true, mode: 0o755 });
		const stage = join(nativeRoot, `.stage-${randomUUID()}`);
		mkdirSync(stage, { mode: 0o755 });
		try {
			cpSync(resourceRoot, stage, { recursive: true, errorOnExist: true, force: false });
			const stagedCli = join(stage, "clawdi");
			chmodSync(stagedCli, 0o755);
			const result = await this.run(stagedCli, [
				"update",
				"--native-activate",
				"--native-stage",
				stage,
				"--native-prefix",
				prefix,
				"--native-version",
				bundledIdentity.version,
				"--native-target",
				bundledIdentity.target,
			]);
			const activated = result.stdout.trim();
			if (activated !== launcher) throw new Error("Clawdi activated an unexpected launcher path.");
			return launcher;
		} finally {
			if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
		}
	}

	private async identity(cli: string): Promise<NativeIdentity> {
		const result = await this.run(cli, ["update", "--native-identity"], { timeoutMs: 20_000 });
		const [version, target, extra] = result.stdout.trim().split("\t");
		if (!version || !target || extra || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
			throw new Error("The bundled Clawdi runtime has an invalid identity.");
		}
		return { version, target };
	}

	private async authState(cli: string): Promise<DesktopBootstrapState["auth"]> {
		const result = await this.runJson(cli, ["auth", "status", "--json"]);
		const authenticated = result.authenticated === true;
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

	private async runJson(cli: string, args: string[]): Promise<Record<string, unknown>> {
		const result = await this.run(cli, args);
		let value: unknown;
		try {
			value = JSON.parse(result.stdout);
		} catch {
			throw new Error("Clawdi returned invalid structured output.");
		}
		if (!isRecord(value)) throw new Error("Clawdi returned invalid structured output.");
		return value;
	}

	private run(
		cli: string,
		args: string[],
		opts: { stdin?: string; timeoutMs?: number } = {},
	): Promise<CommandResult> {
		return runCommand(cli, args, opts);
	}
}

function runCommand(
	command: string,
	args: readonly string[],
	opts: { stdin?: string; timeoutMs?: number },
): Promise<CommandResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			env: { ...process.env, CLAWDI_NO_UPDATE_CHECK: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) reject(error);
			else resolvePromise({ stdout, stderr });
		};
		const append = (current: string, chunk: Buffer) => {
			const next = current + chunk.toString("utf8");
			if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
				child.kill("SIGKILL");
				finish(new Error("Clawdi produced too much output."));
			}
			return next;
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.on("error", (error) => finish(error));
		child.on("exit", (code, signal) => {
			if (code === 0) finish();
			else {
				const detail = stderr.trim().split("\n").at(-1) || `exit ${code ?? signal ?? "unknown"}`;
				finish(new Error(`Clawdi command failed: ${detail}`));
			}
		});
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error("Clawdi took too long to respond."));
		}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		child.stdin.end(opts.stdin ?? "");
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

function readUrl(value: unknown, label: string, protocols: readonly string[]): string {
	const raw = readString(value);
	if (!raw) throw new Error(`Clawdi returned an invalid ${label}.`);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Clawdi returned an invalid ${label}.`);
	}
	if (!protocols.includes(url.protocol) || url.username || url.password) {
		throw new Error(`Clawdi returned an unsafe ${label}.`);
	}
	return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
