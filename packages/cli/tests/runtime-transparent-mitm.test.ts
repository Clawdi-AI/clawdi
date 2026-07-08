import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildTransparentMitmNftCleanupRules,
	buildTransparentMitmNftRules,
	loadTransparentMitmEnvConfig,
} from "../src/runtime/transparent-mitm";

describe("runtime transparent MITM nftables", () => {
	it("builds minimal default-allow redirect rules", () => {
		const rules = buildTransparentMitmNftRules({
			runtimeUid: 10001,
			mitmUid: 10002,
			transparentPort: 25080,
			replaceExistingTable: true,
		});

		expect(rules).toContain("# clawdi-transparent-mitm-v1");
		expect(rules).not.toContain("flush ruleset");
		expect(rules).toContain("delete table inet clawdi_transparent_mitm");
		expect(rules).toContain("add table inet clawdi_transparent_mitm");
		expect(rules).toContain(
			"add chain inet clawdi_transparent_mitm output_nat { type nat hook output priority -100; policy accept; }",
		);
		expect(rules).toContain(
			"add rule inet clawdi_transparent_mitm output_nat meta skuid 10002 accept",
		);
		expect(rules).toContain(
			"add rule inet clawdi_transparent_mitm output_nat meta skuid 10001 tcp dport { 80, 443 } redirect to :25080",
		);
		expect(rules).not.toContain("type filter hook output");
		expect(rules).not.toContain("counter drop");
		expect(rules).not.toContain("udp dport 53");
		expect(rules).not.toContain("ct mark");
	});

	it("builds lifecycle cleanup rules for the managed table only", () => {
		expect(buildTransparentMitmNftCleanupRules("clawdi_test_mitm")).toBe(
			"# clawdi-transparent-mitm-v1\ndelete table inet clawdi_test_mitm\n",
		);
	});

	it("loads the single-source env file and lets direct env override it", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-transparent-mitm-"));
		try {
			const envFile = join(root, "transparent-mitm.env");
			writeFileSync(
				envFile,
				[
					'CLAWDI_RUNTIME_USER="clawdi"',
					'CLAWDI_RUNTIME_UID="10001"',
					'CLAWDI_MITM_USER="clawdi-mitm"',
					'CLAWDI_MITM_UID="10002"',
					'CLAWDI_MITM_TRANSPARENT_PORT="25080"',
					'CLAWDI_MITM_NFT_TABLE="clawdi_transparent_mitm"',
					`CLAWDI_MITM_PROFILE_BUNDLE="${join(root, "profiles.json")}"`,
					`CLAWDI_MITM_SECRET_FILE="${join(root, "secrets.json")}"`,
					`CLAWDI_MITM_CA_DIR="${join(root, "ca")}"`,
					`CLAWDI_MITM_CA_CERT="${join(root, "ca", "mitmproxy-ca-cert.pem")}"`,
					'CLAWDI_MITM_SYSTEM_CA_BUNDLE="/etc/ssl/certs/ca-certificates.crt"',
					'CLAWDI_MITMPROXY_VERSION="12.1.0"',
					'CLAWDI_MITMPROXY_URL="https://github.com/mitmproxy/mitmproxy/releases/download/v12.1.0/mitmproxy-12.1.0-linux-x86_64.tar.gz"',
					`CLAWDI_MITMPROXY_BINARY_PATH="${join(root, "mitmdump")}"`,
					`CLAWDI_MITMPROXY_ADDON_PATH="${join(root, "clawdi_mitm_addon.py")}"`,
					`CLAWDI_MITMPROXY_ADDON_SHA256="${"a".repeat(64)}"`,
					`CLAWDI_MITMPROXY_SHA256="${"b".repeat(64)}"`,
					"",
				].join("\n"),
			);

			const config = loadTransparentMitmEnvConfig({
				CLAWDI_MITM_ENV_FILE: envFile,
				CLAWDI_MITM_TRANSPARENT_PORT: "26080",
			});

			expect(config.runtimeUser).toBe("clawdi");
			expect(config.mitmUser).toBe("clawdi-mitm");
			expect(config.runtimeUid).toBe(10001);
			expect(config.mitmUid).toBe(10002);
			expect(config.transparentPort).toBe(26080);
			expect(config.nftTable).toBe("clawdi_transparent_mitm");
			expect(config.mitmproxySha256).toBe("b".repeat(64));
			expect(config.mitmproxyAddonSha256).toBe("a".repeat(64));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
