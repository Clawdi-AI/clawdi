import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildInvisibleGatewayNftRules,
	readResolverAddresses,
} from "../src/runtime/invisible-gateway";

describe("runtime invisible gateway nftables", () => {
	it("builds an atomic fail-closed nftables table replacement", () => {
		const rules = buildInvisibleGatewayNftRules({
			agentUid: 10001,
			sidecarUid: 0,
			transparentPort: 25080,
			resolverIpv4: ["10.43.0.10"],
			resolverIpv6: ["fd00::10"],
			replaceExistingTable: true,
		});

		expect(rules).toContain("# clawdi-invisible-gateway-v1");
		expect(rules).not.toContain("flush ruleset");
		expect(rules).toContain("delete table inet clawdi_invisible_gateway");
		expect(rules).toContain("add table inet clawdi_invisible_gateway");
		expect(rules).toContain(
			"add chain inet clawdi_invisible_gateway output_nat { type nat hook output priority -100; policy accept; }",
		);
		expect(rules).toContain(
			"add chain inet clawdi_invisible_gateway output_filter { type filter hook output priority 0; policy accept; }",
		);
		expect(rules).toContain(
			"add rule inet clawdi_invisible_gateway output_nat meta skuid 0 accept",
		);
		expect(rules).toContain(
			"add rule inet clawdi_invisible_gateway output_nat meta skuid 10001 tcp dport { 80, 443 } ct mark set 0xc1a0d1 redirect to :25080",
		);
		expect(rules).not.toContain(
			"add rule inet clawdi_invisible_gateway output_filter meta skuid 10001 tcp dport 25080 accept",
		);
		expect(rules).toContain(
			'add rule inet clawdi_invisible_gateway output_filter meta skuid 10001 oifname "lo" tcp dport 25080 accept',
		);
		expect(rules).toContain(
			"add rule inet clawdi_invisible_gateway output_filter meta skuid 10001 ct mark 0xc1a0d1 accept",
		);
		expect(rules).not.toContain("meta skuid != 10001 accept");
		expect(rules).toContain(
			"add rule inet clawdi_invisible_gateway output_filter meta skuid 10001 ip daddr 10.43.0.10 udp dport 53 accept",
		);
		expect(rules).toContain(
			"add rule inet clawdi_invisible_gateway output_filter meta skuid 10001 ip6 daddr fd00::10 tcp dport 53 accept",
		);
		expect(rules).toContain(
			"add rule inet clawdi_invisible_gateway output_filter meta skuid 10001 counter drop",
		);
	});

	it("reads resolver addresses from resolv.conf", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-invisible-gateway-"));
		try {
			const resolv = join(root, "resolv.conf");
			writeFileSync(
				resolv,
				[
					"nameserver 10.43.0.10",
					"nameserver fd00::10",
					"nameserver invalid",
					"search svc.cluster.local",
					"",
				].join("\n"),
			);

			expect(readResolverAddresses(resolv)).toEqual({
				ipv4: ["10.43.0.10"],
				ipv6: ["fd00::10"],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
