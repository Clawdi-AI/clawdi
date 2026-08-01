export const CLAWDI_WHATSAPP_LINK_CAPABILITY_ENV = "CLAWDI_WHATSAPP_LINK_CAPABILITY";
export const CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER = "x-clawdi-whatsapp-link-capability";

// Audit evidence is intentionally centralized with the readiness requirements.
// Updating a version without re-auditing these exact artifacts must not enable
// the runtime projection.
export const WHATSAPP_UPSTREAM_AUDIT = {
	auditedAt: "2026-08-01",
	baileys: {
		package: "@whiskeysockets/baileys",
		version: "7.0.0-rc13",
		gitCommit: "8053b086ecc97ec3f78299561de11959bab05d39",
		npmIntegrity:
			"sha512-8JPc8gaaCRykkjW2jxLGQ7/RZGrc7awO7WU+QJocf58eSUI9jAdcuYLynzhAbyU4UWvJJsHImZ+5E/JaZj5ypA==",
		noiseTrustSeam: {
			requiredSocketOption: "authCert",
			scope: "Noise intermediate certificate public key and serial verification",
			available: false,
		},
	},
	openclaw: {
		version: "2026.7.1",
		stableCommit: "2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4",
		mainCommit: "9e43844264a736b234e32af5b018da1e4a058c87",
		npmIntegrity:
			"sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==",
		nativeManagedUpgradeIdentity: false,
	},
	hermes: {
		version: "2026.7.30",
		packageVersion: "0.19.1",
		stableCommit: "cc4cab2f592e60a197e796506de9168f74baf3ea",
		mainCommit: "470cf66b039c73bdd2c21d43094ce41a4db74eae",
		nativeManagedUpgradeIdentity: false,
	},
} as const;

export const WHATSAPP_RUNTIME_REQUIREMENTS = {
	baileysNoiseTrustSeam: WHATSAPP_UPSTREAM_AUDIT.baileys.noiseTrustSeam.available,
	openclawManagedUpgradeIdentity: WHATSAPP_UPSTREAM_AUDIT.openclaw.nativeManagedUpgradeIdentity,
	hermesManagedUpgradeIdentity: WHATSAPP_UPSTREAM_AUDIT.hermes.nativeManagedUpgradeIdentity,
	openclawNativePluginE2E: false,
	hermesNativePluginE2E: false,
	liveAccountDrill: false,
} as const;

export const WHATSAPP_LINKING_READY = false;
export const WHATSAPP_RUNTIME_READY = Object.values(WHATSAPP_RUNTIME_REQUIREMENTS).every(
	(requirement) => requirement,
);
export const WHATSAPP_UPSTREAM_READY = WHATSAPP_LINKING_READY && WHATSAPP_RUNTIME_READY;
