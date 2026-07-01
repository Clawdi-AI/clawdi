import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { stripMitmSidecarControlEnv } from "./mitm-env";

export interface RuntimeMitmSidecarInput {
	runtime: string;
	env: NodeJS.ProcessEnv;
	profileBundlePath: string;
}

export interface RuntimeMitmSidecar {
	proxyUrl: string;
	caFile: string;
	closed?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	stop: () => Promise<void>;
}

export type RuntimeMitmSidecarFactory = (
	input: RuntimeMitmSidecarInput,
) => Promise<RuntimeMitmSidecar>;

export function shouldStartRuntimeMitmSidecar(env: NodeJS.ProcessEnv): boolean {
	return env.CLAWDI_MITM_ENABLED === "1" && Boolean(env.CLAWDI_MITM_PROFILE_BUNDLE?.trim());
}

export async function startRuntimeMitmSidecar(
	input: RuntimeMitmSidecarInput,
): Promise<RuntimeMitmSidecar> {
	const invocation = resolveSidecarInvocation(input.env);
	if (!invocation) {
		throw new Error(
			"Native MITM sidecar bundle not found. Expected clawdi-mitm-sidecar/bin/clawdi-mitm-sidecar beside the clawdi package entrypoint, or set CLAWDI_MITM_SIDECAR_BUNDLE or CLAWDI_MITM_SIDECAR_PATH.",
		);
	}
	const caFile = input.env.CLAWDI_MITM_CA_FILE?.trim();
	if (!caFile) {
		throw new Error("CLAWDI_MITM_CA_FILE is required when starting the native MITM sidecar.");
	}

	const args = [
		"--profile-bundle",
		input.profileBundlePath,
		"--proxy-url",
		input.env.CLAWDI_MITM_PROXY_URL ?? "http://127.0.0.1:0",
		"--ca-file",
		caFile,
	];
	if (input.env.CLAWDI_MITM_SECRET_FILE) {
		args.push("--secret-file", input.env.CLAWDI_MITM_SECRET_FILE);
	}
	if (input.env.CLAWDI_MITM_ALLOW_REMOTE_PROXY === "1") {
		args.push("--allow-remote-proxy");
	}

	const child = spawn(invocation.command, args, {
		env: sidecarProcessEnv(input.env),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const closed = waitForSidecarClose(child);
	child.stderr.on("data", (chunk) => {
		if (input.env.CLAWDI_DEBUG === "1") process.stderr.write(chunk);
	});

	const ready = await waitForSidecarReady(child);
	return {
		proxyUrl: ready.proxyUrl,
		caFile: ready.caFile,
		closed,
		stop: async () => {
			await stopChild(child);
		},
	};
}

function sidecarProcessEnv(inputEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...process.env, ...inputEnv };
	delete env.CLAWDI_AUTH_TOKEN;
	stripMitmSidecarControlEnv(env);
	return env;
}

function resolveSidecarInvocation(env: NodeJS.ProcessEnv): { command: string } | null {
	const explicit = env.CLAWDI_MITM_SIDECAR_PATH?.trim();
	if (explicit) return { command: explicit };

	const explicitBundle = env.CLAWDI_MITM_SIDECAR_BUNDLE?.trim();
	if (explicitBundle) {
		const executable = join(explicitBundle, "bin", "clawdi-mitm-sidecar");
		if (existsSync(executable)) return { command: executable };
	}

	const here = dirname(fileURLToPath(import.meta.url));
	const baseDirs = unique([
		dirname(process.execPath),
		process.argv[1] ? dirname(process.argv[1]) : "",
		here,
		join(here, ".."),
		join(here, "..", ".."),
	]);
	for (const baseDir of baseDirs) {
		const executable = join(baseDir, "clawdi-mitm-sidecar", "bin", "clawdi-mitm-sidecar");
		if (existsSync(executable)) return { command: executable };
	}

	return null;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function waitForSidecarReady(
	child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<{ proxyUrl: string; caFile: string }> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			settle(() => reject(new Error(`MITM sidecar did not become ready\n${stderr.trim()}`)));
		}, 15_000);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			const line = stdout.split(/\r?\n/).find((item) => item.trim().startsWith("{"));
			if (!line) return;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isRecord(parsed) && parsed.ready === false) {
					const reason = typeof parsed.reason === "string" ? `: ${parsed.reason}` : "";
					settle(() => reject(new Error(`MITM sidecar did not become ready${reason}`)));
					return;
				}
				if (
					isRecord(parsed) &&
					parsed.ready === true &&
					typeof parsed.proxyUrl === "string" &&
					typeof parsed.caFile === "string"
				) {
					const proxyUrl = parsed.proxyUrl;
					const caFile = parsed.caFile;
					settle(() => resolve({ proxyUrl, caFile }));
					return;
				}
				settle(() => reject(new Error(`MITM sidecar emitted invalid ready payload: ${line}`)));
			} catch (error) {
				settle(() => reject(error));
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			settle(() => reject(error));
		});
		child.once("close", (code, signal) => {
			const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			settle(() =>
				reject(
					new Error(`MITM sidecar exited before ready: code=${code} signal=${signal}\n${detail}`),
				),
			);
		});
	});
}

function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill("SIGTERM");
	});
}

function waitForSidecarClose(
	child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		child.once("close", (code, signal) => {
			resolve({ code, signal });
		});
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
