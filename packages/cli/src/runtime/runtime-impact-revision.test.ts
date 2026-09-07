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
	test("changes sidecar revision for an addon-only update", () => {
		const program = {
			transparentPort: 8080,
			profileBundlePath: "/run/clawdi/egress/profiles.json",
			secretFilePath: "/run/clawdi/secrets/egress.json",
			engine: {
				status: "ready" as const,
				version: "12.2.3",
				url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
				sha256: "a".repeat(64),
				cacheDir: "/var/cache/clawdi/mitmproxy",
				binaryPath: "/var/cache/clawdi/mitmproxy/mitmdump",
			},
			addonSha256: "b".repeat(64),
		};
		const identity = { runtimeUid: 10001, runtimeGid: 10001, egressUid: 10002, egressGid: 10002 };
		const revision = runtimeSidecarProgramRevision(sidecarManifest, program, identity);
		expect(runtimeSidecarProgramRevision(sidecarManifest, { ...program }, identity)).toBe(revision);
		expect(
			runtimeSidecarProgramRevision(
				sidecarManifest,
				{ ...program, addonSha256: "c".repeat(64) },
				identity,
			),
		).not.toBe(revision);
	});

	test("hashes canonical runtime program impact", () => {
		const impact = {
			renderedProjection: {
				channels: null,
				gateway: null,
				locale: null,
				mcp: null,
				provider: null,
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
});
