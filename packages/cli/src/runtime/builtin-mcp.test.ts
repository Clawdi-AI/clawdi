import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBuiltinMcp, planBuiltinMcp } from "./builtin-mcp";
import { managedMcpEgressProfiles, managedMcpHeaderPlaceholder } from "./hosted-egress-profiles";
import { hostedRuntimeBundleV2Schema } from "./manifest-source";
import { getRuntimePaths } from "./paths";

test("tenant MCP package uses exact-path proxy credentials and rejects installed artifact drift", () => {
	const root = mkdtempSync(join(tmpdir(), "builtin-mcp-"));
	try {
		const fixture = hostedRuntimeBundleV2Schema.parse(
			JSON.parse(
				readFileSync(
					join(import.meta.dir, "../../../../test-fixtures/runtime-bundle-v2.golden.json"),
					"utf8",
				),
			),
		);
		const desired = {
			url: "https://cloud.example/v1/mcp/clawdi",
			transport: "streamable-http" as const,
			localVault: 1 as const,
			headers: { Authorization: { secretRef: "secret://clawdi/auth-token", prefix: "Bearer " } },
		};
		const paths = { ...getRuntimePaths(), serviceStateRoot: join(root, "state") };
		const plan = planBuiltinMcp(fixture.manifest, paths, desired, join(root, "workspace"));
		installBuiltinMcp(plan);
		installBuiltinMcp(plan);
		expect(plan.server.command).toBe("/usr/local/bin/node");
		const context = JSON.parse(readFileSync(plan.server.args[2] ?? "", "utf8"));
		expect(context.agentId).toBe(fixture.manifest.environmentId);
		expect(context.root).toBe(join(root, "workspace"));
		expect(context.authorization).toBe(
			`Bearer ${managedMcpHeaderPlaceholder("clawdi", "Authorization")}`,
		);
		expect(statSync(plan.server.args[0] ?? "").mode & 0o777).toBe(0o644);
		const [profile] = managedMcpEgressProfiles({ mcp: { servers: { clawdi: desired } } });
		expect(profile?.match.path).toEqual({ type: "equals", value: "/v1/mcp/clawdi" });
		expect(profile?.rewrite?.setHeaders.Authorization).toEqual({
			type: "secretRef",
			secretRef: "secret://clawdi/auth-token",
			prefix: "Bearer ",
		});
		writeFileSync(plan.server.args[0] ?? "", "tampered");
		expect(() => installBuiltinMcp(plan)).toThrow("integrity mismatch");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
