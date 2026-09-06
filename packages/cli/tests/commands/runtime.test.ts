import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	assertCurrentEgressIdentity,
	buildMitmdumpArgs,
	publishEgressSystemCaBundle,
} from "../../src/runtime/egress-sidecar";
import { runtimeUserUid } from "../../src/runtime/runtime-user-command";

describe("runtime sidecar egress logging", () => {
	it("omits raw flows and control payloads while retaining warnings and TLS defaults", () => {
		expect(
			buildMitmdumpArgs({
				transparentPort: 25_080,
				caDir: "/run/clawdi/egress/ca",
				addonPath: "/opt/clawdi/egress-addon.py",
			}),
		).toEqual([
			"--mode",
			"transparent",
			"--listen-host",
			"127.0.0.1",
			"--listen-port",
			"25080",
			"--set",
			"confdir=/run/clawdi/egress/ca",
			"--set",
			"stream_large_bodies=1",
			"--set",
			"flow_detail=0",
			"--set",
			"termlog_verbosity=warn",
			"-s",
			"/opt/clawdi/egress-addon.py",
		]);
	});
});

describe("runtime sidecar egress privilege drop", () => {
	it("accepts the current numeric uid without a passwd entry", () => {
		const previousRuntimeUid = process.env.CLAWDI_RUNTIME_UID;
		delete process.env.CLAWDI_RUNTIME_UID;
		try {
			expect(runtimeUserUid("2147483646")).toBe(2_147_483_646);
		} finally {
			if (previousRuntimeUid === undefined) delete process.env.CLAWDI_RUNTIME_UID;
			else process.env.CLAWDI_RUNTIME_UID = previousRuntimeUid;
		}
	});

	it("allows a matching non-root current identity", () => {
		expect(() => assertCurrentEgressIdentity(10002, 10003, 10002, 10003)).not.toThrow();
	});

	it("rejects mismatching or unverifiable non-root current identities", () => {
		expect(() => assertCurrentEgressIdentity(10001, 10001, 10002, 10002)).toThrow(
			"current egress engine identity 10001:10001 does not match configured 10002:10002",
		);
		expect(() => assertCurrentEgressIdentity(undefined, 10002, 10002, 10002)).toThrow(
			"cannot verify non-root egress engine UID/GID",
		);
		expect(() => assertCurrentEgressIdentity(10002, 0, 10002, 10002)).toThrow(
			"egress engine identity must be non-root",
		);
	});
});
describe("runtime sidecar egress CA projection", () => {
	it("creates and overwrites the runtime-readable bundle as root:runtime-group 0640", () => {
		const root = join(tmpdir(), `clawdi-egress-ca-${Date.now()}-${Math.random().toString(36)}`);
		const caCertPath = join(root, "private", "mitmproxy-ca-cert.pem");
		const systemCaBundle = join(root, "published", "ca.pem");
		const runtimeGid = process.getuid?.() === 0 ? 12_345 : (process.getgid?.() ?? 0);
		const config = {
			runtimeUser: "clawdi",
			runtimeUid: 10_001,
			runtimeGid,
			egressUid: 10_002,
			egressGid: 10_002,
			transparentPort: 25_080,
			nftTable: "clawdi_transparent_egress",
			profileBundlePath: join(root, "profiles.json"),
			secretFilePath: join(root, "secrets.json"),
			caDir: join(root, "private"),
			caCertPath,
			systemCaBundle,
			engineVersion: "test",
			engineUrl: "https://example.invalid/mitmproxy.tar.gz",
			engineSha256: "a".repeat(64),
			engineBinaryPath: join(root, "mitmdump"),
			addonPath: join(root, "addon.py"),
			addonSha256: "b".repeat(64),
		};

		try {
			mkdirSync(join(root, "private"), { recursive: true });
			writeFileSync(caCertPath, "first-egress-ca\n");
			publishEgressSystemCaBundle(config);
			const created = statSync(systemCaBundle);
			expect(statSync(dirname(systemCaBundle)).mode & 0o777).toBe(0o711);
			expect(created.mode & 0o777).toBe(0o640);
			expect(readFileSync(systemCaBundle, "utf-8")).toContain("first-egress-ca");
			if (process.getuid?.() === 0) {
				expect(created.uid).toBe(0);
				expect(created.gid).toBe(runtimeGid);
			}

			chmodSync(systemCaBundle, 0o666);
			writeFileSync(caCertPath, "rotated-egress-ca\n");
			publishEgressSystemCaBundle(config);
			const overwritten = statSync(systemCaBundle);
			expect(overwritten.mode & 0o777).toBe(0o640);
			expect(readFileSync(systemCaBundle, "utf-8")).toContain("rotated-egress-ca");
			if (process.getuid?.() === 0) {
				expect(overwritten.uid).toBe(0);
				expect(overwritten.gid).toBe(runtimeGid);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
