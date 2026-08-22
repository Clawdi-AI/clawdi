import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { EgressEnginePin } from "./egress-engine";
import type { RuntimePaths } from "./paths";

export interface RuntimeMitmproxyReady {
	status: "ready";
	version: string;
	url: string;
	sha256: string;
	cacheDir: string;
	binaryPath: string;
}

export interface RuntimeMitmproxyDegraded {
	status: "degraded";
	version: string | null;
	url: string | null;
	sha256: string | null;
	error: string;
}

export type RuntimeMitmproxyEnsureResult = RuntimeMitmproxyReady | RuntimeMitmproxyDegraded;

export interface EnsureRuntimeMitmproxyOptions {
	allowFileUrls?: boolean;
	downloadCommand?: string;
}

const SAFE_MITMPROXY_ERRORS = new Set([
	"egress engine must use mitmproxy",
	"mitmproxy version contains unsafe characters",
	"mitmproxy sha256 must be 64 hex characters",
	"mitmproxy URL must use https",
	"mitmproxy URL must use official mitmproxy downloads",
	"mitmproxy URL must use the pinned linux x86_64 release archive",
	"mitmproxy archive did not contain mitmdump",
]);

export function ensureRuntimeMitmproxy(
	pin: EgressEnginePin | null | undefined,
	paths: RuntimePaths,
	options: EnsureRuntimeMitmproxyOptions = {},
): RuntimeMitmproxyEnsureResult {
	if (!pin) {
		return degraded(null, "mitmproxy artifact pin is missing");
	}
	const normalizedSha = pin.sha256.toLowerCase();
	try {
		validateMitmproxyPin(pin, options);
		const cacheDir = join(paths.egressEngineMaintainedRoot, pin.version, normalizedSha);
		const binaryPath = join(cacheDir, "mitmdump");
		if (isExecutableFile(binaryPath)) return ready(pin, cacheDir, binaryPath);

		const tempRoot = mkdtempSync(join(tmpdir(), "clawdi-egress-engine-"));
		try {
			const archivePath = join(tempRoot, basename(new URL(pin.url).pathname) || "mitmproxy.tar.gz");
			fetchArtifact(pin.url, archivePath, options);
			const actualSha = sha256File(archivePath);
			if (actualSha !== normalizedSha) {
				throw new Error(`mitmproxy checksum mismatch: expected ${normalizedSha}, got ${actualSha}`);
			}
			const extractRoot = join(tempRoot, "extract");
			mkdirSync(extractRoot, { recursive: true, mode: 0o755 });
			extractTarGz(archivePath, extractRoot);
			const extractedMitmdump = findMitmdump(extractRoot);
			if (!extractedMitmdump) {
				throw new Error("mitmproxy archive did not contain mitmdump");
			}
			mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
			copyFileSync(extractedMitmdump, binaryPath);
			chmodSync(binaryPath, 0o755);
			return ready(pin, cacheDir, binaryPath);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	} catch (error) {
		return degraded(pin, safeMitmproxyError(error));
	}
}

function safeMitmproxyError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (SAFE_MITMPROXY_ERRORS.has(message)) return message;
	if (/^failed to download mitmproxy \(exit (?:[0-9]+|unknown)\)$/.test(message)) return message;
	if (/^tar failed to extract mitmproxy \(exit (?:[0-9]+|unknown)\)$/.test(message)) return message;
	if (/^mitmproxy checksum mismatch: expected [a-f0-9]{64}, got [a-f0-9]{64}$/.test(message)) {
		return message;
	}
	return "mitmproxy preparation failed";
}

function validateMitmproxyPin(pin: EgressEnginePin, options: EnsureRuntimeMitmproxyOptions): void {
	if (pin.type !== "mitmproxy") {
		throw new Error("egress engine must use mitmproxy");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(pin.version)) {
		throw new Error("mitmproxy version contains unsafe characters");
	}
	if (!/^[a-fA-F0-9]{64}$/.test(pin.sha256)) {
		throw new Error("mitmproxy sha256 must be 64 hex characters");
	}
	const url = new URL(pin.url);
	if (url.protocol === "file:" && options.allowFileUrls) return;
	if (url.protocol !== "https:") {
		throw new Error("mitmproxy URL must use https");
	}
	if (url.hostname !== "downloads.mitmproxy.org") {
		throw new Error("mitmproxy URL must use official mitmproxy downloads");
	}
	const expectedPath = `/${pin.version}/mitmproxy-${pin.version}-linux-x86_64.tar.gz`;
	if (url.pathname !== expectedPath) {
		throw new Error("mitmproxy URL must use the pinned linux x86_64 release archive");
	}
}

function fetchArtifact(
	url: string,
	destination: string,
	options: EnsureRuntimeMitmproxyOptions,
): void {
	const parsed = new URL(url);
	if (parsed.protocol === "file:") {
		copyFileSync(parsed, destination);
		return;
	}
	const command = options.downloadCommand ?? "curl";
	const result = spawnSync(command, ["-fL", "--proto", "=https", "-o", destination, url], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(`failed to download mitmproxy (exit ${result.status ?? "unknown"})`);
	}
}

function extractTarGz(archivePath: string, destination: string): void {
	const result = spawnSync("tar", ["-xzf", archivePath, "-C", destination], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(`tar failed to extract mitmproxy (exit ${result.status ?? "unknown"})`);
	}
}

function findMitmdump(root: string): string | null {
	for (const path of walk(root)) {
		if (basename(path) !== "mitmdump") continue;
		if (statSync(path).isFile()) return path;
	}
	return null;
}

function* walk(root: string): Generator<string> {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			yield* walk(path);
		} else {
			yield path;
		}
	}
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isExecutableFile(path: string): boolean {
	try {
		const stat = statSync(path);
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function ready(pin: EgressEnginePin, cacheDir: string, binaryPath: string): RuntimeMitmproxyReady {
	return {
		status: "ready",
		version: pin.version,
		url: pin.url,
		sha256: pin.sha256.toLowerCase(),
		cacheDir,
		binaryPath,
	};
}

function degraded(
	pin: Pick<EgressEnginePin, "version" | "url" | "sha256"> | null,
	error: string,
): RuntimeMitmproxyDegraded {
	return {
		status: "degraded",
		version: pin?.version ?? null,
		url: pin?.url ?? null,
		sha256: pin?.sha256?.toLowerCase() ?? null,
		error,
	};
}
