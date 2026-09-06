import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import { chmodSync, chownSync, existsSync, readFileSync } from "node:fs";
import { writePrivateFileAtomic } from "../lib/private-file";
import { toErrorMessage } from "../serve/log";
import { buildEgressEngineEnv, SYSTEM_CA_BUNDLE } from "./egress-env";
import { detectRuntimeMode } from "./paths";
import { buildNumericUserCommand, runningAsRoot } from "./runtime-user-command";
import {
	applyTransparentEgressNftRulesFromEnv,
	cleanupTransparentEgressNftRulesFromEnv,
	loadTransparentEgressEnvConfig,
	type TransparentEgressEnvConfig,
} from "./transparent-egress";

const EGRESS_LISTEN_TIMEOUT_MS = 15_000;
const EGRESS_CA_TIMEOUT_MS = 10_000;
const EGRESS_READY_POLL_MS = 100;

export async function runtimeSidecar(): Promise<void> {
	if (detectRuntimeMode() !== "hosted") {
		throw new Error("runtime sidecar is only available in hosted runtime mode");
	}
	const shouldStartEgress = Boolean(process.env.CLAWDI_EGRESS_ENV_FILE?.trim());
	if (!shouldStartEgress) {
		throw new Error("runtime sidecar requires egress configuration.");
	}

	let egress: RuntimeEgressModule | null = null;
	try {
		if (shouldStartEgress) {
			egress = await startRuntimeEgress();
			console.error(`runtime sidecar egress module listening on 127.0.0.1:${egress.port}`);
		}
		notifySystemdReady("runtime sidecar ready");
	} catch (error) {
		egress?.close();
		throw error;
	}

	const shutdown = waitForShutdownSignal().then(() => ({ kind: "shutdown" as const }));
	const egressExit = egress?.wait().then(() => ({ kind: "egress-exit" as const }));
	try {
		await (egressExit ? Promise.race([shutdown, egressExit]) : shutdown);
	} finally {
		egress?.close();
		await egressExit?.catch(() => undefined);
	}
}

interface RuntimeEgressModule {
	port: number;
	close: () => void;
	wait: () => Promise<void>;
}

async function startRuntimeEgress(): Promise<RuntimeEgressModule> {
	const config = loadTransparentEgressEnvConfig(process.env);
	const mitmdump = startMitmdump(config);
	const mitmdumpExit = waitForChildExit(mitmdump);
	let redirectApplied = false;
	let closeRequested = false;
	const cleanup = () => {
		if (!redirectApplied) return;
		try {
			cleanupTransparentEgressNftRulesFromEnv(process.env);
		} catch (error) {
			console.error(`transparent egress nft cleanup failed: ${toErrorMessage(error)}`);
		}
		redirectApplied = false;
	};
	const close = () => {
		closeRequested = true;
		cleanup();
		if (!mitmdump.killed) mitmdump.kill("SIGTERM");
	};
	try {
		await waitForTcpPort("127.0.0.1", config.transparentPort, EGRESS_LISTEN_TIMEOUT_MS, () =>
			childHasExited(mitmdump),
		);
		await waitForFile(config.caCertPath, EGRESS_CA_TIMEOUT_MS, () => childHasExited(mitmdump));
		publishEgressSystemCaBundle(config);
		applyTransparentEgressNftRulesFromEnv(process.env);
		redirectApplied = true;
		return {
			port: config.transparentPort,
			close,
			wait: async () => {
				const exit = await mitmdumpExit;
				cleanup();
				if (!closeRequested) {
					const reason = exit.signal === null ? `status ${exit.code}` : `signal ${exit.signal}`;
					throw new Error(`egress engine exited unexpectedly with ${reason}`);
				}
			},
		};
	} catch (error) {
		close();
		throw error;
	}
}

function startMitmdump(config: TransparentEgressEnvConfig): ChildProcess {
	if (!existsSync(config.engineBinaryPath)) {
		throw new Error(`egress engine binary is missing: ${config.engineBinaryPath}`);
	}
	if (!existsSync(config.addonPath)) {
		throw new Error(`egress addon is missing: ${config.addonPath}`);
	}
	const childEnv = buildEgressEngineEnv(process.env, {
		envFile: config.envFile,
		home: config.caDir,
	});
	const command = config.engineBinaryPath;
	const args = buildMitmdumpArgs(config);
	const child = runningAsRoot()
		? spawnWithNumericIdentity(config.egressUid, config.egressGid, command, args, childEnv)
		: spawnWithCurrentEgressIdentity(config.egressUid, config.egressGid, command, args, childEnv);
	child.stdout?.pipe(process.stdout);
	child.stderr?.pipe(process.stderr);
	return child;
}

export function buildMitmdumpArgs(
	config: Pick<TransparentEgressEnvConfig, "transparentPort" | "caDir" | "addonPath">,
): string[] {
	return [
		"--mode",
		"transparent",
		"--listen-host",
		"127.0.0.1",
		"--listen-port",
		String(config.transparentPort),
		"--set",
		`confdir=${config.caDir}`,
		"--set",
		"stream_large_bodies=1",
		"--set",
		// The default flow dumper bypasses the addon's URL redaction.
		"flow_detail=0",
		"--set",
		// INFO also includes raw WebSocket ping/pong payloads outside the dumper.
		"termlog_verbosity=warn",
		"-s",
		config.addonPath,
	];
}

export function assertCurrentEgressIdentity(
	currentUid: number | undefined,
	currentGid: number | undefined,
	configuredUid: number,
	configuredGid: number,
): void {
	if (currentUid === undefined || currentGid === undefined) {
		throw new Error("cannot verify non-root egress engine UID/GID on this platform");
	}
	if (currentUid === 0 || currentGid === 0) {
		throw new Error("egress engine identity must be non-root");
	}
	if (currentUid !== configuredUid || currentGid !== configuredGid) {
		throw new Error(
			`current egress engine identity ${currentUid}:${currentGid} does not match configured ${configuredUid}:${configuredGid}`,
		);
	}
}

function spawnWithCurrentEgressIdentity(
	uid: number,
	gid: number,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): ChildProcess {
	assertCurrentEgressIdentity(process.getuid?.(), process.getgid?.(), uid, gid);
	return spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
}

function spawnWithNumericIdentity(
	uid: number,
	gid: number,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): ChildProcess {
	const child = buildNumericUserCommand(uid, gid, command, args);
	return spawn(child.command, child.args, {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function waitForChildExit(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function childHasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitForTcpPort(
	host: string,
	port: number,
	timeoutMs: number,
	hasExited: () => boolean,
): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const attempt = () => {
			if (hasExited()) {
				reject(new Error(`egress engine exited before listening on ${host}:${port}`));
				return;
			}
			if (tcpPortIsListening(host, port)) {
				resolve();
				return;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				reject(new Error(`timed out waiting for egress engine on ${host}:${port}`));
				return;
			}
			setTimeout(attempt, EGRESS_READY_POLL_MS);
		};
		attempt();
	});
}

function tcpPortIsListening(host: string, port: number): boolean {
	const portHex = port.toString(16).toUpperCase().padStart(4, "0");
	const allowedHosts =
		host === "127.0.0.1" ? new Set(["0100007F"]) : new Set(["00000000", "0100007F"]);
	try {
		for (const raw of readFileSync("/proc/net/tcp", "utf-8").split(/\r?\n/).slice(1)) {
			const fields = raw.trim().split(/\s+/);
			const localAddress = fields[1] ?? "";
			const state = fields[3] ?? "";
			const [address, localPort] = localAddress.split(":");
			if (state === "0A" && localPort === portHex && address && allowedHosts.has(address)) {
				return true;
			}
		}
	} catch {
		return false;
	}
	return false;
}

function waitForFile(path: string, timeoutMs: number, hasExited: () => boolean): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const attempt = () => {
			if (hasExited()) {
				reject(new Error(`egress engine exited before writing ${path}`));
				return;
			}
			if (existsSync(path)) {
				resolve();
				return;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				reject(new Error(`timed out waiting for ${path}`));
				return;
			}
			setTimeout(attempt, EGRESS_READY_POLL_MS);
		};
		attempt();
	});
}

export function publishEgressSystemCaBundle(config: TransparentEgressEnvConfig): void {
	if (config.systemCaBundle === SYSTEM_CA_BUNDLE) {
		throw new Error("CLAWDI_EGRESS_SYSTEM_CA_BUNDLE must be a runtime-managed CA projection path");
	}
	const systemCa = readFileSync(SYSTEM_CA_BUNDLE, "utf-8");
	const egressCa = readFileSync(config.caCertPath, "utf-8");
	writePrivateFileAtomic(config.systemCaBundle, `${systemCa.trimEnd()}\n${egressCa.trimEnd()}\n`, {
		mode: 0o640,
		dirMode: 0o711,
	});
	if (runningAsRoot()) chownSync(config.systemCaBundle, 0, config.runtimeGid);
	chmodSync(config.systemCaBundle, 0o640);
}

function waitForShutdownSignal(): Promise<void> {
	const processEvents: EventEmitter = process;
	return new Promise((resolve) => {
		const done = () => {
			processEvents.removeListener("SIGTERM", done);
			processEvents.removeListener("SIGINT", done);
			resolve();
		};
		processEvents.once("SIGTERM", done);
		processEvents.once("SIGINT", done);
	});
}

function notifySystemdReady(status: string): void {
	if (!process.env.NOTIFY_SOCKET) return;
	spawnSync("systemd-notify", ["--ready", `--status=${status}`], {
		stdio: "ignore",
		env: process.env,
	});
}
