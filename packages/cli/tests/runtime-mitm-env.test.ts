import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	applyMitmBrokerRuntimeEnv,
	buildMitmBrokerEnv,
	stripMitmBrokerControlEnv,
	stripMitmBrokerEnv,
} from "../src/runtime/mitm-env";

describe("runtime MITM env projection", () => {
	it("builds a child proxy/CA env from a profile bundle", () => {
		const profileBundlePath = "/var/lib/clawdi/config/mitm/profiles.json";
		const env = buildMitmBrokerEnv({
			profileBundlePath,
			env: {
				PATH: "/usr/bin",
				HTTPS_PROXY: "http://stale-proxy.invalid:8080",
				https_proxy: "http://stale-lowercase-proxy.invalid:8080",
				NODE_OPTIONS: "--trace-warnings",
				CLAWDI_RUN_DIR: "/run/clawdi",
				CLAWDI_MITM_PROXY_PORT: "19090",
				CLAWDI_MITM_BROKER_BUNDLE: "/usr/local/bin/clawdi-mitm-broker",
			},
		});

		expect(env.PATH).toBe("/usr/bin");
		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:19090");
		expect(env.HTTP_PROXY).toBe("http://127.0.0.1:19090");
		expect(env.https_proxy).toBe("http://127.0.0.1:19090");
		expect(env.http_proxy).toBe("http://127.0.0.1:19090");
		expect(env.CLAWDI_MITM_ENABLED).toBe("1");
		expect(env.CLAWDI_MITM_PROFILE_BUNDLE).toBe(profileBundlePath);
		expect(env.CLAWDI_MITM_CA_FILE).toBe(join("/run/clawdi", "mitm", "ca.pem"));
		expect(env.CLAWDI_MITM_SECRET_FILE).toBe(join("/run/clawdi", "mitm", "secrets.json"));
		expect(env.NODE_USE_ENV_PROXY).toBe("1");
		expect(env.NODE_OPTIONS).toBe("--trace-warnings");
		expect(env.SSL_CERT_FILE).toBe(join("/run/clawdi", "mitm", "ca.pem"));
		expect(env.NODE_EXTRA_CA_CERTS).toBe(join("/run/clawdi", "mitm", "ca.pem"));
		expect(env.CODEX_CA_CERTIFICATE).toBe(join("/run/clawdi", "mitm", "ca.pem"));
		expect(env.NO_PROXY).toContain("127.0.0.1");
		expect(env.no_proxy).toBe(env.NO_PROXY);
	});

	it("applies broker runtime output without exposing Clawdi MITM internals", () => {
		const env = buildMitmBrokerEnv({
			profileBundlePath: "/var/lib/clawdi/config/mitm/profiles.json",
			env: {
				CLAWDI_RUN_DIR: "/run/clawdi",
				CLAWDI_MITM_BROKER_PATH: "/tmp/test-broker",
				CLAWDI_MITM_ALLOW_REMOTE_PROXY: "1",
			},
		});

		applyMitmBrokerRuntimeEnv(env, {
			proxyUrl: "http://127.0.0.1:27183",
			caFile: "/run/clawdi/mitm/live-ca.pem",
		});
		stripMitmBrokerControlEnv(env);

		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:27183");
		expect(env.https_proxy).toBe("http://127.0.0.1:27183");
		expect(env.CODEX_CA_CERTIFICATE).toBe("/run/clawdi/mitm/live-ca.pem");
		expect(env.CLAWDI_MITM_ENABLED).toBeUndefined();
		expect(env.CLAWDI_MITM_PROFILE_BUNDLE).toBeUndefined();
		expect(env.CLAWDI_MITM_PROXY_URL).toBeUndefined();
		expect(env.CLAWDI_MITM_CA_FILE).toBeUndefined();
		expect(env.CLAWDI_MITM_SECRET_FILE).toBeUndefined();
		expect(env.CLAWDI_MITM_BROKER_PATH).toBeUndefined();
		expect(env.CLAWDI_MITM_BROKER_BUNDLE).toBeUndefined();
		expect(env.CLAWDI_MITM_ALLOW_REMOTE_PROXY).toBeUndefined();
	});

	it("strips stale proxy and broker env from inherited environments", () => {
		const stripped = stripMitmBrokerEnv({
			PATH: "/usr/bin",
			CLAWDI_MITM_ENABLED: "1",
			CLAWDI_MITM_PROFILE_BUNDLE: "/tmp/profiles.json",
			CLAWDI_MITM_PROXY_URL: "http://127.0.0.1:8080",
			CLAWDI_MITM_BROKER_BUNDLE: "/tmp/bundle",
			NODE_OPTIONS: "--trace-warnings",
			HTTPS_PROXY: "http://proxy.invalid:8080",
			CODEX_CA_CERTIFICATE: "/tmp/ca.pem",
		});

		expect(stripped.PATH).toBe("/usr/bin");
		expect(stripped.CLAWDI_MITM_ENABLED).toBeUndefined();
		expect(stripped.CLAWDI_MITM_PROFILE_BUNDLE).toBeUndefined();
		expect(stripped.CLAWDI_MITM_PROXY_URL).toBeUndefined();
		expect(stripped.CLAWDI_MITM_BROKER_BUNDLE).toBeUndefined();
		expect(stripped.NODE_OPTIONS).toBe("--trace-warnings");
		expect(stripped.HTTPS_PROXY).toBeUndefined();
		expect(stripped.CODEX_CA_CERTIFICATE).toBeUndefined();
	});
});
