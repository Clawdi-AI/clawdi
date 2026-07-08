import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureRuntimeMitmproxy } from "../src/runtime/mitmproxy-fetch";
import { getRuntimePaths } from "../src/runtime/paths";

let tmpRoot = "";
const originalEnv = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnv)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
	tmpRoot = "";
});

describe("runtime mitmproxy maintained fetch", () => {
	it("verifies and caches a pinned mitmdump archive", () => {
		const { archive, sha256 } = makeMitmproxyArchive();
		const paths = runtimePaths();
		const pin = {
			version: "12.2.3-test",
			url: pathToFileURL(archive).toString(),
			sha256,
		};

		const first = ensureRuntimeMitmproxy(pin, paths, { allowFileUrls: true });
		const second = ensureRuntimeMitmproxy(pin, paths, {
			allowFileUrls: true,
			downloadCommand: "missing-curl-for-cache-hit",
		});

		expect(first.status).toBe("ready");
		if (first.status !== "ready") throw new Error(first.error);
		expect(first.binaryPath).toBe(
			join(paths.mitmproxyMaintainedRoot, pin.version, pin.sha256, "mitmdump"),
		);
		expect(existsSync(first.binaryPath)).toBe(true);
		expect(readFileSync(first.binaryPath, "utf-8")).toContain("fake mitmdump");
		expect(second.status).toBe("ready");
		if (second.status !== "ready") throw new Error(second.error);
		expect(second.binaryPath).toBe(first.binaryPath);
	});

	it("degrades instead of installing on checksum mismatch", () => {
		const { archive } = makeMitmproxyArchive();
		const paths = runtimePaths();

		const result = ensureRuntimeMitmproxy(
			{
				version: "12.2.3-test",
				url: pathToFileURL(archive).toString(),
				sha256: "0".repeat(64),
			},
			paths,
			{ allowFileUrls: true },
		);

		expect(result.status).toBe("degraded");
		if (result.status !== "degraded") throw new Error("expected degraded");
		expect(result.error).toContain("checksum mismatch");
		expect(existsSync(join(paths.mitmproxyMaintainedRoot, "12.2.3-test"))).toBe(false);
	});

	it("requires official GitHub release URLs outside tests", () => {
		const paths = runtimePaths();

		const result = ensureRuntimeMitmproxy(
			{
				version: "12.2.3",
				url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
				sha256: "a".repeat(64),
			},
			paths,
		);

		expect(result.status).toBe("degraded");
		if (result.status !== "degraded") throw new Error("expected degraded");
		expect(result.error).toContain("official GitHub releases");
	});

	it("degrades cleanly when the manifest has no pin", () => {
		const result = ensureRuntimeMitmproxy(null, runtimePaths());

		expect(result).toEqual({
			status: "degraded",
			version: null,
			url: null,
			sha256: null,
			error: "mitmproxy artifact pin is missing",
		});
	});
});

function runtimePaths() {
	tmpRoot ||= mkdtempSync(join(tmpdir(), "clawdi-mitmproxy-fetch-"));
	process.env.HOME = join(tmpRoot, "home");
	process.env.CLAWDI_HOME = join(tmpRoot, "home", ".clawdi");
	process.env.CLAWDI_SERVICE_STATE_DIR = join(tmpRoot, "state");
	process.env.CLAWDI_RUN_DIR = join(tmpRoot, "run");
	return getRuntimePaths({ mode: "hosted" });
}

function makeMitmproxyArchive(): { archive: string; sha256: string } {
	tmpRoot ||= mkdtempSync(join(tmpdir(), "clawdi-mitmproxy-fetch-"));
	const source = join(tmpRoot, "archive-source", "mitmproxy-12.2.3");
	mkdirSync(source, { recursive: true });
	const binary = join(source, "mitmdump");
	writeFileSync(binary, "#!/usr/bin/env sh\nprintf 'fake mitmdump\\n'\n");
	chmodSync(binary, 0o755);
	const archive = join(tmpRoot, `mitmproxy-${Date.now()}-${Math.random()}.tar.gz`);
	const result = spawnSync("tar", ["-czf", archive, "-C", join(tmpRoot, "archive-source"), "."], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(`tar failed: ${result.stdout}${result.stderr}`);
	}
	return {
		archive,
		sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
	};
}
