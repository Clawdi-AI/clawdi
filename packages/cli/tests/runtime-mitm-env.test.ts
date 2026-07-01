import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	applyMitmSidecarRuntimeEnv,
	buildMitmSidecarEnv,
	stripMitmSidecarControlEnv,
	stripMitmSidecarEnv,
} from "../src/runtime/mitm-env";

describe("runtime MITM env projection", () => {
	it("builds a child proxy/CA env from a profile bundle", () => {
		const profileBundlePath = "/var/lib/clawdi/config/mitm/profiles.json";
		const env = buildMitmSidecarEnv({
			profileBundlePath,
			env: {
				PATH: "/usr/bin",
				HTTPS_PROXY: "http://stale-proxy.invalid:8080",
				https_proxy: "http://stale-lowercase-proxy.invalid:8080",
				NODE_OPTIONS: "--trace-warnings",
				CLAWDI_RUN_DIR: "/run/clawdi",
				CLAWDI_MITM_PROXY_PORT: "19090",
				CLAWDI_MITM_SIDECAR_BUNDLE: "/usr/local/bin/clawdi-mitm-sidecar",
			},
		});

		expect(env.PATH).toBe("/usr/bin");
		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:19090");
		expect(env.HTTP_PROXY).toBe("http://127.0.0.1:19090");
		expect(env.https_proxy).toBe("http://127.0.0.1:19090");
		expect(env.http_proxy).toBe("http://127.0.0.1:19090");
		expect(env.CLAWDI_MITM_ENABLED).toBe("1");
		expect(env.CLAWDI_MITM_PROFILE_BUNDLE).toBe(profileBundlePath);
		expect(env.CLAWDI_MITM_CA_FILE?.startsWith(join("/run/clawdi", "mitm", "sidecars"))).toBe(true);
		expect(env.CLAWDI_MITM_CA_FILE?.endsWith(join("", "ca.pem"))).toBe(true);
		expect(env.CLAWDI_MITM_SECRET_FILE).toBe(join("/run/clawdi", "mitm", "secrets.json"));
		expect(env.NODE_USE_ENV_PROXY).toBe("1");
		expect(env.NODE_OPTIONS).toBe("--trace-warnings");
		expect(env.SSL_CERT_FILE).toBe(env.CLAWDI_MITM_CA_FILE);
		expect(env.NODE_EXTRA_CA_CERTS).toBe(env.CLAWDI_MITM_CA_FILE);
		expect(env.CODEX_CA_CERTIFICATE).toBe(env.CLAWDI_MITM_CA_FILE);
		expect(env.NO_PROXY).toContain("127.0.0.1");
		expect(env.no_proxy).toBe(env.NO_PROXY);
	});

	it("generates an isolated CA path for each sidecar invocation", () => {
		const profileBundlePath = "/var/lib/clawdi/config/mitm/profiles.json";
		const first = buildMitmSidecarEnv({
			profileBundlePath,
			env: { CLAWDI_RUN_DIR: "/run/clawdi" },
		});
		const second = buildMitmSidecarEnv({
			profileBundlePath,
			env: { CLAWDI_RUN_DIR: "/run/clawdi" },
		});

		expect(first.CLAWDI_MITM_SECRET_FILE).toBe(join("/run/clawdi", "mitm", "secrets.json"));
		expect(second.CLAWDI_MITM_SECRET_FILE).toBe(join("/run/clawdi", "mitm", "secrets.json"));
		expect(first.CLAWDI_MITM_CA_FILE).not.toBe(second.CLAWDI_MITM_CA_FILE);
		expect(first.CLAWDI_MITM_CA_FILE?.startsWith(join("/run/clawdi", "mitm", "sidecars"))).toBe(
			true,
		);
		expect(second.CLAWDI_MITM_CA_FILE?.startsWith(join("/run/clawdi", "mitm", "sidecars"))).toBe(
			true,
		);
	});

	it("applies sidecar runtime output without exposing Clawdi MITM internals", () => {
		const env = buildMitmSidecarEnv({
			profileBundlePath: "/var/lib/clawdi/config/mitm/profiles.json",
			env: {
				CLAWDI_RUN_DIR: "/run/clawdi",
				CLAWDI_MITM_SIDECAR_PATH: "/tmp/test-sidecar",
				CLAWDI_MITM_ALLOW_REMOTE_PROXY: "1",
			},
		});

		applyMitmSidecarRuntimeEnv(env, {
			proxyUrl: "http://127.0.0.1:27183",
			caFile: "/run/clawdi/mitm/live-ca.pem",
		});
		stripMitmSidecarControlEnv(env);

		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:27183");
		expect(env.https_proxy).toBe("http://127.0.0.1:27183");
		expect(env.CODEX_CA_CERTIFICATE).toBe("/run/clawdi/mitm/live-ca.pem");
		expect(env.CLAWDI_MITM_ENABLED).toBeUndefined();
		expect(env.CLAWDI_MITM_PROFILE_BUNDLE).toBeUndefined();
		expect(env.CLAWDI_MITM_PROXY_URL).toBeUndefined();
		expect(env.CLAWDI_MITM_CA_FILE).toBeUndefined();
		expect(env.CLAWDI_MITM_SECRET_FILE).toBeUndefined();
		expect(env.CLAWDI_MITM_SIDECAR_PATH).toBeUndefined();
		expect(env.CLAWDI_MITM_SIDECAR_BUNDLE).toBeUndefined();
		expect(env.CLAWDI_MITM_ALLOW_REMOTE_PROXY).toBeUndefined();
	});

	it("strips stale proxy and sidecar env from inherited environments", () => {
		const stripped = stripMitmSidecarEnv({
			PATH: "/usr/bin",
			CLAWDI_MITM_ENABLED: "1",
			CLAWDI_MITM_PROFILE_BUNDLE: "/tmp/profiles.json",
			CLAWDI_MITM_PROXY_URL: "http://127.0.0.1:8080",
			CLAWDI_MITM_SIDECAR_BUNDLE: "/tmp/bundle",
			NODE_OPTIONS: "--trace-warnings",
			HTTPS_PROXY: "http://proxy.invalid:8080",
			CODEX_CA_CERTIFICATE: "/tmp/ca.pem",
		});

		expect(stripped.PATH).toBe("/usr/bin");
		expect(stripped.CLAWDI_MITM_ENABLED).toBeUndefined();
		expect(stripped.CLAWDI_MITM_PROFILE_BUNDLE).toBeUndefined();
		expect(stripped.CLAWDI_MITM_PROXY_URL).toBeUndefined();
		expect(stripped.CLAWDI_MITM_SIDECAR_BUNDLE).toBeUndefined();
		expect(stripped.NODE_OPTIONS).toBe("--trace-warnings");
		expect(stripped.HTTPS_PROXY).toBeUndefined();
		expect(stripped.CODEX_CA_CERTIFICATE).toBeUndefined();
	});
});
