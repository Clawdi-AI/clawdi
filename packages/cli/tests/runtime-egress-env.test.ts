import { describe, expect, it } from "bun:test";
import {
	applyEgressTransparentRuntimeEnv,
	buildEgressEngineEnv,
	stripEgressSidecarEnv,
} from "../src/runtime/egress-env";

describe("runtime egress env projection", () => {
	it("strips stale proxy and sidecar env from inherited environments", () => {
		const stripped = stripEgressSidecarEnv({
			PATH: "/usr/bin",
			CLAWDI_EGRESS_ENABLED: "1",
			CLAWDI_EGRESS_PROFILE_BUNDLE: "/tmp/profiles.json",
			CLAWDI_EGRESS_PROXY_URL: "http://127.0.0.1:8080",
			CLAWDI_EGRESS_SYSTEM_CA_CERT: "/tmp/system-ca.crt",
			CLAWDI_EGRESS_SIDECAR_BUNDLE: "/tmp/bundle",
			CLAWDI_EGRESS_ADDON_PATH: "/tmp/addon.py",
			CLAWDI_EGRESS_FUTURE_CONTROL: "future",
			NODE_OPTIONS: "--trace-warnings",
			HTTPS_PROXY: "http://proxy.invalid:8080",
			CODEX_CA_CERTIFICATE: "/tmp/ca.pem",
		});

		expect(stripped.PATH).toBe("/usr/bin");
		expect(stripped.CLAWDI_EGRESS_ENABLED).toBeUndefined();
		expect(stripped.CLAWDI_EGRESS_PROFILE_BUNDLE).toBeUndefined();
		expect(stripped.CLAWDI_EGRESS_PROXY_URL).toBeUndefined();
		expect(stripped.CLAWDI_EGRESS_SYSTEM_CA_CERT).toBeUndefined();
		expect(stripped.CLAWDI_EGRESS_SIDECAR_BUNDLE).toBeUndefined();
		expect(stripped.CLAWDI_EGRESS_ADDON_PATH).toBeUndefined();
		expect(stripped.CLAWDI_EGRESS_FUTURE_CONTROL).toBeUndefined();
		expect(stripped.NODE_OPTIONS).toBe("--trace-warnings");
		expect(stripped.HTTPS_PROXY).toBeUndefined();
		expect(stripped.CODEX_CA_CERTIFICATE).toBeUndefined();
	});

	it("applies hosted transparent CA env without proxy variables", () => {
		const env: NodeJS.ProcessEnv = {
			HTTPS_PROXY: "http://stale.invalid:8080",
			OPENCLAW_PROXY_URL: "http://stale.invalid:8080",
			CLAWDI_EGRESS_PROFILE_BUNDLE: "/tmp/profiles.json",
			CLAWDI_EGRESS_SECRET_FILE: "/tmp/secrets.json",
			CLAWDI_EGRESS_SYSTEM_CA_CERT: "/tmp/system-ca.crt",
			CLAWDI_EGRESS_FUTURE_CONTROL: "future",
		};

		applyEgressTransparentRuntimeEnv(env);

		expect(env.HTTPS_PROXY).toBeUndefined();
		expect(env.HTTP_PROXY).toBeUndefined();
		expect(env.OPENCLAW_PROXY_URL).toBeUndefined();
		expect(env.CLAWDI_EGRESS_PROFILE_BUNDLE).toBeUndefined();
		expect(env.CLAWDI_EGRESS_SECRET_FILE).toBeUndefined();
		expect(env.CLAWDI_EGRESS_SYSTEM_CA_CERT).toBeUndefined();
		expect(env.CLAWDI_EGRESS_FUTURE_CONTROL).toBeUndefined();
		expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
		expect(env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(env.REQUESTS_CA_BUNDLE).toBe("/etc/ssl/certs/ca-certificates.crt");
		expect(env.CLAWDI_PROVIDER_PLACEHOLDER_TOKEN).toBe("clawdi-egress-placeholder");
	});

	it("builds a minimal egress engine env without bridge credentials", () => {
		const env = buildEgressEngineEnv(
			{
				PATH: "/usr/bin",
				LANG: "C.UTF-8",
				NODE_OPTIONS: "--inspect",
				CLAWDI_AUTH_TOKEN: "runtime-auth",
				CLAWDI_RUNTIME_BRIDGE_TOKEN: "bridge-secret",
				CLAWDI_RUNTIME_BRIDGE_SURFACES: '[{"name":"openclaw"}]',
				CLAWDI_EGRESS_ENV_FILE: "/run/clawdi/egress.env",
				CLAWDI_EGRESS_PROFILE_BUNDLE: "/run/clawdi/egress-profiles.json",
				CLAWDI_EGRESS_SECRET_FILE: "/run/clawdi/egress-secrets.json",
				HTTPS_PROXY: "http://proxy.invalid:8080",
			},
			{ home: "/run/clawdi/egress-ca" },
		);

		expect(env).toEqual({
			PATH: "/usr/bin",
			LANG: "C.UTF-8",
			CLAWDI_EGRESS_ENV_FILE: "/run/clawdi/egress.env",
			HOME: "/run/clawdi/egress-ca",
		});
	});

	it("passes only addon config when the egress engine is configured directly", () => {
		const env = buildEgressEngineEnv(
			{
				PATH: "/usr/bin",
				CLAWDI_RUNTIME_BRIDGE_TOKEN: "bridge-secret",
				CLAWDI_EGRESS_PROFILE_BUNDLE: "/run/clawdi/egress-profiles.json",
				CLAWDI_EGRESS_SECRET_FILE: "/run/clawdi/egress-secrets.json",
				CLAWDI_EGRESS_ENGINE_BINARY_PATH: "/opt/mitmdump",
			},
			{ home: "/run/clawdi/egress-ca" },
		);

		expect(env).toEqual({
			PATH: "/usr/bin",
			CLAWDI_EGRESS_ENV_FILE: "",
			CLAWDI_EGRESS_PROFILE_BUNDLE: "/run/clawdi/egress-profiles.json",
			CLAWDI_EGRESS_SECRET_FILE: "/run/clawdi/egress-secrets.json",
			HOME: "/run/clawdi/egress-ca",
		});
	});
});
