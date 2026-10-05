import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readRuntimeAppliedState } from "./applied-state";
import { runtimeFileCurrentRevision } from "./manifest-install";
import { readComponentServiceState } from "./observed";
import {
	OPENCLAW_MUTATION_FUNCTION,
	OPENCLAW_MUTATION_IMPORTS,
} from "./openclaw-config-mutation-script";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { profileRuntimeStep } from "./profile";
import { writeAnonymousOpenClawWriterUnits } from "./runtime-systemd-reconciliation";
import { runningAsRoot } from "./runtime-user-command";
import { ensureRuntimePlatformDirectory, writeRuntimePlatformFileAtomic } from "./state";

const SERVICE = "openclaw-first-writer.service";
const SOCKET = "openclaw-first-writer.socket";
const HEADER = "# ClawdiAnonymousOpenClawWriter=v1";
const MAX_REQUEST_BYTES = 1024 * 1024;
const receiptSchema = z
	.object({
		schemaVersion: z.literal("clawdi.openclawFirstWriter.v1"),
		nonce: z.uuid(),
		identity: z.string().regex(/^[a-f0-9]{64}$/),
		checks: z.record(z.string(), z.string()).optional(),
	})
	.strict();

export function firstWriterPaths(paths: RuntimePaths) {
	const root = join(paths.runRoot, "openclaw-first-writer");
	return {
		root,
		script: join(root, "writer.mjs"),
		socket: join(root, "writer.sock"),
		receipt: join(paths.statusRoot, "openclaw-first-writer.json"),
		used: join(paths.statusRoot, "openclaw-first-writer-used"),
	};
}

/** The root-owned socket is inherited from systemd; the SDK always runs as the runtime UID. */
export const FIRST_WRITER_SCRIPT = `${OPENCLAW_MUTATION_IMPORTS}
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const importStartedAt = Date.now(), importStarted = performance.now();
const sdk = await import(pathToFileURL(process.argv[2]).href);
const importDuration = performance.now() - importStarted;
if (typeof sdk.readConfigFileSnapshotForWrite !== "function" || typeof sdk.mutateConfigFile !== "function")
  throw new Error("required public config-mutation export is missing");
// Warm the official snapshot reader and complete plugin validation without a
// tenant. Each submitted mutation still reads fresh native state under its lock.
const anonymousStartedAt = Date.now(), anonymousStarted = performance.now();
const anonymous = await sdk.readConfigFileSnapshotForWrite();
const anonymousDuration = performance.now() - anonymousStarted;
if (anonymous?.snapshot?.valid !== true) throw new Error("anonymous config validation failed");
// Load the complete official write/validation pipeline before claim. This is a
// locked, fully validated identity mutation of anonymous config only; no tenant
// request or credential is present, and the native follow-up mode is explicit.
const anonymousWriteStartedAt = Date.now(), anonymousWriteStarted = performance.now();
await sdk.mutateConfigFile({
  base: "source", afterWrite: {mode: "none", reason: "Clawdi anonymous runtime warm-up"},
  mutate: () => {},
});
const anonymousWriteDuration = performance.now() - anonymousWriteStarted;
${OPENCLAW_MUTATION_FUNCTION}
let receivedRequest = false;
const server = createServer((connection) => {
  if (receivedRequest) { connection.destroy(); return; }
  receivedRequest = true;
  let content = "", bytes = 0, handled = false;
  connection.setEncoding("utf8");
  connection.setTimeout(30000, () => connection.destroy());
  connection.on("error", () => {});
  connection.on("data", async (chunk) => {
    if (handled) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > ${MAX_REQUEST_BYTES}) { connection.destroy(); return; }
    content += chunk;
    const newline = content.indexOf("\\n");
    if (newline === -1) return;
    handled = true;
    const raw = content.slice(0, newline);
    let frame;
    try {
      frame = JSON.parse(raw);
      if (frame.schemaVersion !== "clawdi.openclawFirstWrite.v1" ||
          frame.nonce !== process.env.CLAWDI_FIRST_WRITER_NONCE ||
          typeof frame.requestId !== "string" || !Array.isArray(frame.operations) ||
          frame.operations.some((op) => !["provider", "channels"].includes(op.kind)))
        throw new Error("invalid first-write request");
      mutationProfileEnabled = frame.profile === true;
      if (mutationProfileEnabled) console.error("CLAWDI_RUNTIME_SPAN " + JSON.stringify({
        label: "writer.import-sdk", pid: process.pid, startedAt: importStartedAt,
        durationMs: Math.round(importDuration * 100) / 100,
      }));
      if (mutationProfileEnabled) console.error("CLAWDI_RUNTIME_SPAN " + JSON.stringify({
        label: "writer.anonymous-validation", pid: process.pid, startedAt: anonymousStartedAt,
        durationMs: Math.round(anonymousDuration * 100) / 100,
      }));
      if (mutationProfileEnabled) console.error("CLAWDI_RUNTIME_SPAN " + JSON.stringify({
        label: "writer.anonymous-write", pid: process.pid, startedAt: anonymousWriteStartedAt,
        durationMs: Math.round(anonymousWriteDuration * 100) / 100,
      }));
      await profileMutation("writer.total", () => mutateOpenClawConfig(sdk, frame, "batch", true));
      connection.end(JSON.stringify({schemaVersion:"clawdi.openclawFirstWriteAck.v1",
        requestId:frame.requestId, requestHash:createHash("sha256").update(raw).digest("hex"), ok:true}) + "\\n");
    } catch {
      connection.end(JSON.stringify({schemaVersion:"clawdi.openclawFirstWriteAck.v1",
        requestId:frame?.requestId, requestHash:createHash("sha256").update(raw).digest("hex"), ok:false}) + "\\n");
    }
  });

});
server.on("error", () => { process.exitCode = 1; });
server.listen({fd:3}, () => {
  execFileSync("systemd-notify", ["--ready"], {stdio:"ignore"});
});
`;

const FIRST_WRITER_CLIENT = `
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
const raw = readFileSync(0, "utf8");
const socket = createConnection(process.argv[1]);
let response = "", acknowledged = false;
socket.setEncoding("utf8");
socket.setTimeout(30000, () => socket.destroy(new Error("first writer timed out")));
socket.on("error", () => { process.exitCode = 1; });
socket.on("close", () => { if (!acknowledged) process.exitCode = 1; });
socket.on("connect", () => socket.write(raw + "\\n"));
socket.on("data", (chunk) => {
  response += chunk;
  if (response.length > 4096) { socket.destroy(); process.exitCode = 1; return; }
  const newline = response.indexOf("\\n");
  if (newline !== -1 && !acknowledged) { acknowledged = true; process.stdout.write(response.slice(0,newline)); socket.end(); }
});
`;

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function privateRootFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && stat.uid === 0 && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

// A runtime user cannot restore inode ctime after editing sources. Bind the
// installed graph and symlink targets without reading every byte on claim.
export function openClawWriterSourceRevision(sdkPath: string): string {
	let root = dirname(realpathSync(sdkPath));
	while (!existsSync(join(root, "package.json"))) {
		const parent = dirname(root);
		if (parent === root) throw new Error("native SDK package identity is unavailable");
		root = parent;
	}
	const entries: Array<[string, string]> = [];
	// The first walk binds symlinks themselves; the second also binds external
	// dependency targets. Loops, oversized graphs and timeout fail admission.
	for (const follow of [false, true]) {
		const result = spawnSync(
			"find",
			[
				...(follow ? ["-L"] : []),
				root,
				"(",
				...(follow ? ["-type", "f", "-o", "-type", "l"] : ["-type", "l"]),
				")",
				"-printf",
				"%p\\0%D:%i:%s:%m:%U:%G:%T@:%C@:%l\\0",
			],
			{ encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
		);
		if (result.status !== 0) throw new Error("native SDK source identity is unavailable");
		const fields = result.stdout.split("\0");
		if (fields.length % 2 !== 1 || fields.at(-1) !== "")
			throw new Error("native SDK source identity is malformed");
		for (let index = 0; index + 1 < fields.length; index += 2)
			entries.push([`${follow}:${fields[index]}`, fields[index + 1]]);
	}
	return hash(
		JSON.stringify(entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
	);
}

function nodeRevision(): string {
	const path = realpathSync(nativeNodePath());
	const info = statSync(path, { bigint: true });
	return hash(
		JSON.stringify([
			path,
			...[
				info.dev,
				info.ino,
				info.size,
				info.mode,
				info.uid,
				info.gid,
				info.mtimeNs,
				info.ctimeNs,
			].map((value) => String(value)),
		]),
	);
}

function nativeNodePath(): string {
	const result = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8", timeout: 5000 });
	if (result.status !== 0 || !result.stdout.trim().startsWith("/"))
		throw new Error("native writer Node path is unavailable");
	return result.stdout.trim();
}

function ownedPublicFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0;
	} catch {
		return false;
	}
}

function effectiveUnitMatches(paths: RuntimePaths, unit: string): boolean {
	const path = join(paths.systemdSystemRoot, unit);
	if (!ownedPublicFile(path)) return false;
	const result = spawnSync("systemctl", ["cat", "--no-pager", unit], {
		encoding: "utf8",
		timeout: 5000,
		maxBuffer: 64 * 1024,
	});
	const normalize = (value: string, inherited = false) =>
		value
			.split("\n")
			.filter((line) => line.trim() && !line.startsWith("#") && line !== "[Service]")
			// Stock systemd/LXC drop-ins set these container-safe defaults. None
			// changes this service's SDK identity, numeric UID or entrypoint.
			// The complete effective configuration still binds the receipt.
			.filter(
				(line) =>
					!inherited ||
					!new Set([
						"TimeoutStopFailureMode=abort",
						"ProcSubset=all",
						"ProtectProc=default",
						"ProtectControlGroups=no",
						"ProtectKernelTunables=no",
						"NoNewPrivileges=no",
						"LoadCredential=",
						"PrivateNetwork=no",
						"ImportCredential=",
					]).has(line),
			)
			.join("\n");
	return (
		result.status === 0 && normalize(result.stdout, true) === normalize(readFileSync(path, "utf8"))
	);
}

function identity(
	paths: RuntimePaths,
	sdkPath: string,
): { revision: string; checks: Record<string, string> } | null {
	try {
		const state = readComponentServiceState(paths, "system", SERVICE);
		if (!state) return profileRuntimeStep("writer.admission.manager-unavailable", () => null);
		if (!effectiveUnitMatches(paths, SERVICE) || !effectiveUnitMatches(paths, SOCKET))
			return profileRuntimeStep("writer.admission.overridden-units", () => null);
		const files = firstWriterPaths(paths);
		const socket = lstatSync(files.socket);
		if (!socket.isSocket() || socket.uid !== 0 || (socket.mode & 0o077) !== 0) return null;

		const checks = {
			manager: hash(JSON.stringify(state)),
			sdk: hash(
				JSON.stringify([
					sdkPath,
					runtimeFileCurrentRevision(sdkPath),
					openClawWriterSourceRevision(sdkPath),
				]),
			),
			node: nodeRevision(),
			script: hash(readFileSync(files.script, "utf8")),
			socket: hash(JSON.stringify([socket.dev, socket.ino])),
			units: hash(
				JSON.stringify([
					readFileSync(join(paths.systemdSystemRoot, SERVICE), "utf8"),
					readFileSync(join(paths.systemdSystemRoot, SOCKET), "utf8"),
				]),
			),
		};
		return { revision: hash(JSON.stringify(checks)), checks };
	} catch {
		return null;
	}
}

function systemctl(args: string[]): void {
	const result = spawnSync("systemctl", args, { stdio: "ignore", timeout: 60_000 });
	if (result.status !== 0) throw new Error("anonymous OpenClaw writer manager action failed");
}

export function assertFirstWriterUnclaimed(paths: RuntimePaths): void {
	if (existsSync(firstWriterPaths(paths).used))
		throw new Error("runtime warm refuses a submitted tenant config write");
}

function readReceipt(paths: RuntimePaths) {
	const file = firstWriterPaths(paths).receipt;
	if (!privateRootFile(file)) return null;
	try {
		return receiptSchema.parse(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

function stopMatchingWriter(paths: RuntimePaths, sdkPath: string, expected: string): void {
	if (
		profileRuntimeStep("writer.cleanup-identity", () => identity(paths, sdkPath))?.revision !==
		expected
	)
		throw new Error("anonymous writer ownership changed before cleanup");
	systemctl(["stop", SOCKET, SERVICE]);
}

export function warmFirstOpenClawWriter(
	paths: RuntimePaths,
	sdkPath: string,
	uid: number,
	gid: number,
): void {
	assertFirstWriterUnclaimed(paths);
	const files = firstWriterPaths(paths);
	for (const unit of [SOCKET, SERVICE]) {
		const path = join(paths.systemdSystemRoot, unit);
		if (
			existsSync(path) &&
			(!ownedPublicFile(path) || !readFileSync(path, "utf8").startsWith(HEADER))
		)
			throw new Error("anonymous writer refuses an unowned unit");
	}
	const previous = readReceipt(paths);
	if (previous && readComponentServiceState(paths, "system", SERVICE))
		stopMatchingWriter(paths, sdkPath, previous.identity);
	else if (readComponentServiceState(paths, "system", SERVICE))
		throw new Error("anonymous writer has no current ownership receipt");
	ensureRuntimePlatformDirectory(paths, files.root, { mode: 0o711 });
	writeRuntimePlatformFileAtomic(paths, files.script, FIRST_WRITER_SCRIPT, { mode: 0o644 });
	const node = nativeNodePath();
	const nonce = randomUUID();
	writeAnonymousOpenClawWriterUnits({
		paths,
		node,
		sdkPath,
		nonce,
		uid,
		gid,
		script: files.script,
		socketPath: files.socket,
		service: SERVICE,
		socket: SOCKET,
		header: HEADER,
	});
	systemctl(["daemon-reload"]);
	if (!effectiveUnitMatches(paths, SERVICE) || !effectiveUnitMatches(paths, SOCKET))
		throw new Error("anonymous writer refuses overridden units");
	systemctl(["start", SOCKET, SERVICE]);
	const fingerprint = identity(paths, sdkPath);
	if (!fingerprint) throw new Error("anonymous OpenClaw writer invocation is unavailable");
	writeRuntimePlatformFileAtomic(
		paths,
		files.receipt,
		`${JSON.stringify({ schemaVersion: "clawdi.openclawFirstWriter.v1", nonce, identity: fingerprint.revision, checks: fingerprint.checks })}\n`,
		{ mode: 0o600 },
	);
}

/** Single-use optimization only. A mismatch leaves normal official mutation in charge. */
export function tryFirstOpenClawWrite(
	sdkPath: string,
	home: string,
	operations: unknown[],
): boolean {
	const paths = getRuntimePaths();
	const files = firstWriterPaths(paths);
	if (
		paths.mode !== "hosted" ||
		paths.userHome !== home ||
		!runningAsRoot() ||
		readRuntimeAppliedState(paths) ||
		existsSync(files.used) ||
		!privateRootFile(files.receipt)
	)
		return profileRuntimeStep("writer.admission.ineligible", () => false);
	const receipt = readReceipt(paths);
	if (!receipt) return profileRuntimeStep("writer.admission.invalid-receipt", () => false);
	const candidate = profileRuntimeStep("writer.admission-identity", () => identity(paths, sdkPath));
	if (receipt.identity !== candidate?.revision) {
		for (const name of ["manager", "sdk", "node", "script", "socket", "units"]) {
			if (receipt.checks?.[name] !== candidate?.checks[name])
				profileRuntimeStep(`writer.admission.changed-${name}`, () => false);
		}
		return false;
	}
	const requestId = randomUUID();
	const raw = JSON.stringify({
		schemaVersion: "clawdi.openclawFirstWrite.v1",
		nonce: receipt.nonce,
		requestId,
		operations,
		profile: process.env.CLAWDI_RUNTIME_PROFILE === "1",
	});
	if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) return false;
	// Consume before submission: a crash/replay uses the normal fresh writer, never a second tenant request.
	writeRuntimePlatformFileAtomic(paths, files.used, "submitted\n", { mode: 0o600, durable: true });
	try {
		const output = profileRuntimeStep("writer.request", () =>
			execFileSync("node", ["--input-type=module", "--eval", FIRST_WRITER_CLIENT, files.socket], {
				input: raw,
				encoding: "utf8",
				timeout: 35_000,
				maxBuffer: 4096,
			}),
		);
		const ack = z
			.object({
				schemaVersion: z.literal("clawdi.openclawFirstWriteAck.v1"),
				requestId: z.literal(requestId),
				requestHash: z.literal(hash(raw)),
				ok: z.literal(true),
			})
			.strict()
			.parse(JSON.parse(output));
		if (!ack.ok) throw new Error("native writer rejected the first config mutation");
		return true;
	} catch {
		// Keep failure details and tenant values out of the public apply error.
		throw new Error("preloaded native OpenClaw config mutation failed");
	} finally {
		// Socket remains root-only. Drain this known service before releasing the convergence lock.
		stopMatchingWriter(paths, sdkPath, receipt.identity);
		// Never erase a replacement receipt.
		if (readReceipt(paths)?.identity === receipt.identity) rmSync(files.receipt, { force: true });
	}
}
