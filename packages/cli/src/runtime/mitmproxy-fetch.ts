import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
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
import type { MitmproxyArtifactPin } from "./manifest-contract";
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

interface EnsureRuntimeMitmproxyOptions {
	allowFileUrls?: boolean;
	downloadCommand?: string;
}

export function ensureRuntimeMitmproxy(
	pin: MitmproxyArtifactPin | null | undefined,
	paths: RuntimePaths,
	options: EnsureRuntimeMitmproxyOptions = {},
): RuntimeMitmproxyEnsureResult {
	if (!pin) {
		return degraded(null, "mitmproxy artifact pin is missing");
	}
	const normalizedSha = pin.sha256.toLowerCase();
	try {
		validateMitmproxyPin(pin, options);
		const cacheDir = join(paths.mitmproxyMaintainedRoot, pin.version, normalizedSha);
		const binaryPath = join(cacheDir, "mitmdump");
		if (isExecutableFile(binaryPath)) {
			return ready(pin, cacheDir, binaryPath);
		}

		const tempRoot = mkdtempSync(join(tmpdir(), "clawdi-mitmproxy-"));
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
			rootOwnedBestEffort(paths.maintainedRoot);
			rootOwnedBestEffort(paths.mitmproxyMaintainedRoot);
			rootOwnedBestEffort(join(paths.mitmproxyMaintainedRoot, pin.version));
			rootOwnedBestEffort(cacheDir);
			rootOwnedBestEffort(binaryPath);
			return ready(pin, cacheDir, binaryPath);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	} catch (error) {
		return degraded(pin, error instanceof Error ? error.message : String(error));
	}
}

function validateMitmproxyPin(
	pin: MitmproxyArtifactPin,
	options: EnsureRuntimeMitmproxyOptions,
): void {
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
		const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`${command} failed to download mitmproxy${detail ? `\n${detail}` : ""}`);
	}
}

function extractTarGz(archivePath: string, destination: string): void {
	const result = spawnSync("tar", ["-xzf", archivePath, "-C", destination], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`tar failed to extract mitmproxy${detail ? `\n${detail}` : ""}`);
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

function rootOwnedBestEffort(path: string): void {
	try {
		chownSync(path, 0, 0);
	} catch {
		// Non-root local verification cannot chown; hosted converge runs as root.
	}
	try {
		chmodSync(path, statSync(path).isDirectory() ? 0o755 : 0o755);
	} catch {
		// Best effort on non-POSIX filesystems.
	}
}

function ready(
	pin: MitmproxyArtifactPin,
	cacheDir: string,
	binaryPath: string,
): RuntimeMitmproxyReady {
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
	pin: Pick<MitmproxyArtifactPin, "version" | "url" | "sha256"> | null,
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
