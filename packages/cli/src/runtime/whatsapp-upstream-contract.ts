export const CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER = "x-clawdi-whatsapp-link-capability";

// Audit evidence is intentionally centralized with the readiness requirements.
// Updating a version without re-auditing these exact artifacts must not enable
// the runtime projection.
export const WHATSAPP_UPSTREAM_AUDIT = {
	auditedAt: "2026-08-02",
	baileysRelease: {
		version: "7.0.0-rc13",
		gitCommit: "8053b086ecc97ec3f78299561de11959bab05d39",
		artifacts: {
			openclaw: {
				consumer: "openclaw",
				consumerVersion: "2026.7.1",
				consumerStableCommit: "2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4",
				package: "baileys",
			},
			hermes: {
				consumer: "hermes",
				consumerVersion: "2026.7.30",
				consumerPackageVersion: "0.19.1",
				consumerStableCommit: "cc4cab2f592e60a197e796506de9168f74baf3ea",
				package: "@whiskeysockets/baileys",
			},
		},
		sharedSurfaceSha256: {
			noiseHandler: "970f9526ce0e5a6bebf937328b3d835966a9282c0d232f31b5c0bb283531afe8",
			socketTypes: "3555af5f3f73ceae7bb1b77018620b6a8cdfb21dc00029b4d655956eb86bb300",
		},
		noiseTrustSeam: {
			requiredSocketOption: "authCert",
			scope: "Noise intermediate certificate public key and serial verification",
			available: true,
			providedBy: "clawdi.managedBaileysCompat.v1",
			backwardCompatibleDefault: "WA_CERT_DETAILS",
		},
		webSocketUpgradeHeaderSeam: {
			requiredSocketOption: "webSocketHeaders",
			scope: "WebSocket upgrade only; excluded from fetch and media HTTP",
			available: true,
			providedBy: "clawdi.managedBaileysCompat.v1",
		},
	},
	openclaw: {
		version: "2026.7.1",
		stableCommit: "2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4",
		consumerSocketConstructionCompatibility: {
			available: true,
			nativeUpstream: false,
			providedBy: "clawdi.managedBaileysCompat.v1",
		},
	},
	hermes: {
		version: "2026.7.30",
		packageVersion: "0.19.1",
		stableCommit: "cc4cab2f592e60a197e796506de9168f74baf3ea",
		consumerSocketConstructionCompatibility: {
			available: true,
			nativeUpstream: false,
			providedBy: "clawdi.managedBaileysCompat.v1",
		},
	},
} as const;

export const WHATSAPP_RUNTIME_REQUIREMENTS = {
	baileysNoiseTrustSeam: WHATSAPP_UPSTREAM_AUDIT.baileysRelease.noiseTrustSeam.available,
	baileysWebSocketUpgradeHeaderSeam:
		WHATSAPP_UPSTREAM_AUDIT.baileysRelease.webSocketUpgradeHeaderSeam.available,
	openclawPatchedConsumerSocketConstruction:
		WHATSAPP_UPSTREAM_AUDIT.openclaw.consumerSocketConstructionCompatibility.available,
	hermesPatchedConsumerSocketConstruction:
		WHATSAPP_UPSTREAM_AUDIT.hermes.consumerSocketConstructionCompatibility.available,
	openclawNativePluginE2E: false,
	hermesNativePluginE2E: false,
	liveAccountDrill: false,
} as const;

export const WHATSAPP_LINKING_READY = false;
export const WHATSAPP_RUNTIME_READY = Object.values(WHATSAPP_RUNTIME_REQUIREMENTS).every(
	(requirement) => requirement,
);
export const WHATSAPP_UPSTREAM_READY = WHATSAPP_LINKING_READY && WHATSAPP_RUNTIME_READY;
