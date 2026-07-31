import { describe, expect, test } from "bun:test";
import {
	daemonProgramRevision,
	runtimeProgramRevision,
	runtimeServiceProgramRevision,
	runtimeSidecarProgramRevision,
} from "./runtime-impact-revision";

const daemonManifest = {
	clawdiCli: { packageSpec: "clawdi@1.0.0" },
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
		expect(runtimeSidecarProgramRevision({ ...sidecarManifest, instanceId: "other" })).not.toBe(
			runtimeSidecarProgramRevision(sidecarManifest),
		);
	});
});
