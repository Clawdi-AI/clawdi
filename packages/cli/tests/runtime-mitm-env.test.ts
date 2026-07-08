import { describe, expect, it } from "bun:test";
import { applyMitmTransparentRuntimeEnv, stripMitmSidecarEnv } from "../src/runtime/mitm-env";

describe("runtime MITM env projection", () => {
	it("strips stale proxy and sidecar env from inherited environments", () => {
		const stripped = stripMitmSidecarEnv({
			PATH: "/usr/bin",
			CLAWDI_MITM_ENABLED: "1",
			CLAWDI_MITM_PROFILE_BUNDLE: "/tmp/profiles.json",
			CLAWDI_MITM_PROXY_URL: "http://127.0.0.1:8080",
			CLAWDI_MITM_SYSTEM_CA_CERT: "/tmp/system-ca.crt",
			CLAWDI_MITM_SIDECAR_BUNDLE: "/tmp/bundle",
			CLAWDI_MITM_ADDON_PATH: "/tmp/addon.py",
			CLAWDI_MITM_FUTURE_CONTROL: "future",
			NODE_OPTIONS: "--trace-warnings",
			HTTPS_PROXY: "http://proxy.invalid:8080",
			CODEX_CA_CERTIFICATE: "/tmp/ca.pem",
		});

		expect(stripped.PATH).toBe("/usr/bin");
		expect(stripped.CLAWDI_MITM_ENABLED).toBeUndefined();
		expect(stripped.CLAWDI_MITM_PROFILE_BUNDLE).toBeUndefined();
		expect(stripped.CLAWDI_MITM_PROXY_URL).toBeUndefined();
		expect(stripped.CLAWDI_MITM_SYSTEM_CA_CERT).toBeUndefined();
		expect(stripped.CLAWDI_MITM_SIDECAR_BUNDLE).toBeUndefined();
		expect(stripped.CLAWDI_MITM_ADDON_PATH).toBeUndefined();
		expect(stripped.CLAWDI_MITM_FUTURE_CONTROL).toBeUndefined();
		expect(stripped.NODE_OPTIONS).toBe("--trace-warnings");
		expect(stripped.HTTPS_PROXY).toBeUndefined();
		expect(stripped.CODEX_CA_CERTIFICATE).toBeUndefined();
	});

	it("applies hosted transparent CA env without proxy variables", () => {
		const env: NodeJS.ProcessEnv = {
			HTTPS_PROXY: "http://stale.invalid:8080",
			OPENCLAW_PROXY_URL: "http://stale.invalid:8080",
			CLAWDI_MITM_PROFILE_BUNDLE: "/tmp/profiles.json",
			CLAWDI_MITM_SECRET_FILE: "/tmp/secrets.json",
			CLAWDI_MITM_SYSTEM_CA_CERT: "/tmp/system-ca.crt",
			CLAWDI_MITM_FUTURE_CONTROL: "future",
		};

		applyMitmTransparentRuntimeEnv(env);

		expect(env.HTTPS_PROXY).toBeUndefined();
		expect(env.HTTP_PROXY).toBeUndefined();
		expect(env.OPENCLAW_PROXY_URL).toBeUndefined();
		expect(env.CLAWDI_MITM_PROFILE_BUNDLE).toBeUndefined();
		expect(env.CLAWDI_MITM_SECRET_FILE).toBeUndefined();
		expect(env.CLAWDI_MITM_SYSTEM_CA_CERT).toBeUndefined();
		expect(env.CLAWDI_MITM_FUTURE_CONTROL).toBeUndefined();
		expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
		expect(env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(env.REQUESTS_CA_BUNDLE).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(env.CLAWDI_PROVIDER_PLACEHOLDER_TOKEN).toBe("clawdi-mitm-placeholder");
	});
});
