import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildTransparentEgressNftCleanupRules,
	buildTransparentEgressNftRules,
	loadTransparentEgressEnvConfig,
} from "../src/runtime/transparent-egress";

describe("runtime transparent egress nftables", () => {
	it("builds minimal default-allow redirect rules", () => {
		const rules = buildTransparentEgressNftRules({
			runtimeUid: 10001,
			egressUid: 10002,
			transparentPort: 25080,
			replaceExistingTable: true,
		});

		expect(rules).toContain("# clawdi-transparent-egress-v1");
		expect(rules).not.toContain("flush ruleset");
		expect(rules).toContain("delete table inet clawdi_transparent_egress");
		expect(rules).toContain("add table inet clawdi_transparent_egress");
		expect(rules).toContain(
			"add chain inet clawdi_transparent_egress output_nat { type nat hook output priority -100; policy accept; }",
		);
		expect(rules).toContain(
			"add rule inet clawdi_transparent_egress output_nat meta skuid 10002 accept",
		);
		expect(rules).toContain(
			"add rule inet clawdi_transparent_egress output_nat meta skuid 10001 tcp dport { 80, 443 } redirect to :25080",
		);
		expect(rules).not.toContain("type filter hook output");
		expect(rules).not.toContain("counter drop");
		expect(rules).not.toContain("udp dport 53");
		expect(rules).not.toContain("ct mark");
	});

	it("builds lifecycle cleanup rules for the managed table only", () => {
		expect(buildTransparentEgressNftCleanupRules("clawdi_test_egress")).toBe(
			"# clawdi-transparent-egress-v1\ndelete table inet clawdi_test_egress\n",
		);
	});

	it("loads the single-source env file and lets direct env override it", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-transparent-egress-"));
		try {
			const envFile = join(root, "transparent-egress.env");
			writeFileSync(
				envFile,
				[
					'CLAWDI_RUNTIME_USER="clawdi"',
					'CLAWDI_RUNTIME_UID="10001"',
					'CLAWDI_EGRESS_UID="10002"',
					'CLAWDI_EGRESS_GID="10003"',
					'CLAWDI_EGRESS_TRANSPARENT_PORT="25080"',
					'CLAWDI_EGRESS_NFT_TABLE="clawdi_transparent_egress"',
					`CLAWDI_EGRESS_PROFILE_BUNDLE="${join(root, "profiles.json")}"`,
					`CLAWDI_EGRESS_SECRET_FILE="${join(root, "secrets.json")}"`,
					`CLAWDI_EGRESS_CA_DIR="${join(root, "ca")}"`,
					`CLAWDI_EGRESS_CA_CERT="${join(root, "ca", "mitmproxy-ca-cert.pem")}"`,
					'CLAWDI_EGRESS_SYSTEM_CA_BUNDLE="/etc/ssl/certs/ca-certificates.crt"',
					'CLAWDI_EGRESS_ENGINE_VERSION="12.2.3"',
					'CLAWDI_EGRESS_ENGINE_URL="https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz"',
					`CLAWDI_EGRESS_ENGINE_BINARY_PATH="${join(root, "mitmdump")}"`,
					`CLAWDI_EGRESS_ADDON_PATH="${join(root, "clawdi_egress_addon.py")}"`,
					`CLAWDI_EGRESS_ADDON_SHA256="${"a".repeat(64)}"`,
					`CLAWDI_EGRESS_ENGINE_SHA256="${"b".repeat(64)}"`,
					"",
				].join("\n"),
			);

			const config = loadTransparentEgressEnvConfig({
				CLAWDI_EGRESS_ENV_FILE: envFile,
				CLAWDI_EGRESS_TRANSPARENT_PORT: "26080",
			});

			expect(config.runtimeUser).toBe("clawdi");
			expect(config.runtimeUid).toBe(10001);
			expect(config.egressUid).toBe(10002);
			expect(config.egressGid).toBe(10003);
			expect(config.transparentPort).toBe(26080);
			expect(config.nftTable).toBe("clawdi_transparent_egress");
			expect(config.engineSha256).toBe("b".repeat(64));
			expect(config.addonSha256).toBe("a".repeat(64));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects invalid or root egress numeric identities", () => {
		const base = {
			CLAWDI_RUNTIME_USER: "clawdi",
			CLAWDI_RUNTIME_UID: "10001",
			CLAWDI_EGRESS_UID: "10002",
			CLAWDI_EGRESS_GID: "10002",
			CLAWDI_EGRESS_TRANSPARENT_PORT: "25080",
			CLAWDI_EGRESS_NFT_TABLE: "clawdi_transparent_egress",
			CLAWDI_EGRESS_PROFILE_BUNDLE: "/tmp/profiles.json",
			CLAWDI_EGRESS_CA_DIR: "/tmp/ca",
			CLAWDI_EGRESS_CA_CERT: "/tmp/ca/mitmproxy-ca-cert.pem",
			CLAWDI_EGRESS_SYSTEM_CA_BUNDLE: "/tmp/ca.pem",
			CLAWDI_EGRESS_ENGINE_VERSION: "12.2.3",
			CLAWDI_EGRESS_ENGINE_URL: "https://example.invalid/mitmproxy.tar.gz",
			CLAWDI_EGRESS_ENGINE_SHA256: "b".repeat(64),
			CLAWDI_EGRESS_ENGINE_BINARY_PATH: "/tmp/mitmdump",
			CLAWDI_EGRESS_ADDON_PATH: "/tmp/addon.py",
			CLAWDI_EGRESS_ADDON_SHA256: "a".repeat(64),
		};

		for (const [key, value] of [
			["CLAWDI_EGRESS_UID", "0"],
			["CLAWDI_EGRESS_UID", "-1"],
			["CLAWDI_EGRESS_UID", "4294967295"],
			["CLAWDI_EGRESS_UID", "4294967296"],
			["CLAWDI_EGRESS_GID", "0"],
			["CLAWDI_EGRESS_GID", "1.5"],
		] as const) {
			expect(() => loadTransparentEgressEnvConfig({ ...base, [key]: value })).toThrow(
				`${key} must be a positive Linux UID/GID`,
			);
		}
	});
});
