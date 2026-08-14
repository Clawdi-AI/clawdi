import { describe, expect, test } from "bun:test";
import {
	daemonProgramRevision,
	runtimeProgramRevision,
	runtimeServiceProgramRevision,
	runtimeSidecarProgramRevision,
} from "./runtime-impact-revision";

const daemonManifest = {
	clawdiCli: { packageSpec: "clawdi@1.2.3" },
	controlPlane: { apiUrl: "https://cloud.test" },
	liveSync: { enabled: false, agents: [] },
};

const sidecarManifest = {
	instanceId: "instance-test",
	egressProfiles: { profiles: [] },
};

describe("runtime impact revisions", () => {
	test("hashes canonical runtime program impact", () => {
		const impact = {
			renderedProjection: {
				channels: null,
				gateway: null,
				locale: null,
				mcp: null,
				provider: null,
				skills: null,
			},
			desiredRuntime: { enabled: true, services: {} },
			secretValues: { TOKEN: "one" },
		};
		expect(runtimeProgramRevision(impact)).toBe(runtimeProgramRevision({ ...impact }));
		expect(runtimeProgramRevision({ ...impact, secretValues: { TOKEN: "two" } })).not.toBe(
			runtimeProgramRevision(impact),
		);
	});

	test("scopes service, daemon, and sidecar authority independently", () => {
		const service = {
			runtime: "hermes",
			service: "dashboard",
			command: "/bin/hermes",
			args: ["dashboard"],
			cwd: "/home/clawdi",
			env: { PORT: "9119" },
		};
		expect(runtimeServiceProgramRevision({ ...service })).toBe(
			runtimeServiceProgramRevision(service),
		);
		expect(daemonProgramRevision({ ...daemonManifest })).toBe(
			daemonProgramRevision(daemonManifest),
		);
		const cliOnlyChange = {
			...daemonManifest,
			clawdiCli: { packageSpec: "clawdi@2.0.0" },
		};
		expect(daemonProgramRevision(cliOnlyChange)).not.toBe(daemonProgramRevision(daemonManifest));
		expect(
			daemonProgramRevision({
				...daemonManifest,
				controlPlane: { apiUrl: "https://other.test" },
			}),
		).not.toBe(daemonProgramRevision(daemonManifest));
		expect(runtimeSidecarProgramRevision({ ...sidecarManifest, instanceId: "other" })).not.toBe(
			runtimeSidecarProgramRevision(sidecarManifest),
		);
	});

	test("restarts the sidecar when an Agent Plugin egress profile changes", () => {
		const withAgentPluginProfile = {
			...sidecarManifest,
			egressProfiles: {
				profiles: [
					{
						id: "agent-plugin-clawdi-cloud",
						enabled: true,
						kind: "provider" as const,
						match: {
							scheme: "https" as const,
							host: "cloud-api.clawdi.ai:443",
							path: { type: "equals" as const, value: "/v1/mcp/clawdi" },
							headers: {
								"X-Clawdi-Agent-Plugin": { type: "equals" as const, value: "clawdi-cloud" },
							},
							query: {},
						},
						rewrite: {
							preservePath: true,
							removeHeaders: ["X-Clawdi-Agent-Plugin"],
							setHeaders: {
								Authorization: {
									type: "secretRef" as const,
									secretRef: "secret://clawdi/auth-token",
									prefix: "Bearer ",
								},
							},
						},
						logging: { redactHeaders: ["Authorization"], redactUrlPatterns: [] },
						priority: 60,
						owner: "agent-plugin-projection",
					},
				],
			},
		};

		expect(runtimeSidecarProgramRevision(withAgentPluginProfile)).not.toBe(
			runtimeSidecarProgramRevision(sidecarManifest),
		);
	});
});
