export const CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER = "x-clawdi-whatsapp-link-capability";
export const CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY = "clawdi.managedWhatsAppSocket";
export const CLAWDI_MANAGED_WHATSAPP_SOCKET_SCHEMA = "clawdi.managedWhatsAppSocket.v1";

export interface ManagedWhatsAppSocketMetadataJson {
	schemaVersion: typeof CLAWDI_MANAGED_WHATSAPP_SOCKET_SCHEMA;
	capability: string;
	authCert: {
		SERIAL: number;
		ISSUER: string;
		PUBLIC_KEY: { type: "Buffer"; data: string };
	};
}

export function parseManagedWhatsAppSocketMetadataJson(
	value: unknown,
): ManagedWhatsAppSocketMetadataJson {
	const metadata = recordValue(value);
	const authCert = recordValue(metadata?.authCert);
	const publicKey = recordValue(authCert?.PUBLIC_KEY);
	const capability = metadata?.capability;
	const issuer = authCert?.ISSUER;
	const serial = authCert?.SERIAL;
	const publicKeyData = publicKey?.data;
	if (
		!metadata ||
		!hasExactKeys(metadata, ["authCert", "capability", "schemaVersion"]) ||
		metadata.schemaVersion !== CLAWDI_MANAGED_WHATSAPP_SOCKET_SCHEMA ||
		typeof capability !== "string" ||
		!/^clawdi_[a-f0-9]{32}$/.test(capability) ||
		!authCert ||
		!hasExactKeys(authCert, ["ISSUER", "PUBLIC_KEY", "SERIAL"]) ||
		typeof serial !== "number" ||
		!Number.isSafeInteger(serial) ||
		serial < 0 ||
		typeof issuer !== "string" ||
		issuer.length === 0 ||
		issuer.trim() !== issuer ||
		issuer.length > 256 ||
		!publicKey ||
		!hasExactKeys(publicKey, ["data", "type"]) ||
		publicKey.type !== "Buffer" ||
		typeof publicKeyData !== "string" ||
		!isCanonicalBase64Bytes(publicKeyData, 32)
	) {
		throw new Error("invalid Clawdi managed WhatsApp socket metadata");
	}
	return {
		schemaVersion: CLAWDI_MANAGED_WHATSAPP_SOCKET_SCHEMA,
		capability,
		authCert: {
			SERIAL: serial,
			ISSUER: issuer,
			PUBLIC_KEY: { type: "Buffer", data: publicKeyData },
		},
	};
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isCanonicalBase64Bytes(value: string, byteLength: number): boolean {
	const decoded = Buffer.from(value, "base64");
	return decoded.length === byteLength && decoded.toString("base64") === value;
}

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
			socket: "ab9b68888e123ad683dbc26555fc928400c1526c93ec6b66853f2ba30f8177a9",
			noiseHandlerTypes: "a556ca0b67c3448769ad5ed0d59acbf566a21115fa107cd582b1dcb28c4fd516",
		},
		noiseTrustSeam: {
			requiredSocketOption: "authCert",
			scope: "Noise intermediate certificate public key and serial verification",
			available: true,
			providedBy: "clawdi.managedBaileysCompat.v2",
			backwardCompatibleDefault: "WA_CERT_DETAILS",
		},
		webSocketUpgradeHeaderSeam: {
			requiredCredentialMetadata: CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY,
			scope: "WebSocket upgrade only; excluded from fetch and media HTTP",
			available: true,
			providedBy: "clawdi.managedBaileysCompat.v2",
		},
	},
	openclaw: {
		version: "2026.7.1",
		stableCommit: "2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4",
		stockAuthStatePersistenceCompatibility: {
			available: true,
			nativeUpstream: true,
			providedBy: "stock OpenClaw auth-state load/save",
		},
	},
	hermes: {
		version: "2026.7.30",
		packageVersion: "0.19.1",
		stableCommit: "cc4cab2f592e60a197e796506de9168f74baf3ea",
		stockAuthStatePersistenceCompatibility: {
			available: true,
			nativeUpstream: true,
			providedBy: "stock Hermes useMultiFileAuthState load/save",
		},
	},
} as const;

export const WHATSAPP_RUNTIME_REQUIREMENTS = {
	baileysNoiseTrustSeam: WHATSAPP_UPSTREAM_AUDIT.baileysRelease.noiseTrustSeam.available,
	baileysWebSocketUpgradeHeaderSeam:
		WHATSAPP_UPSTREAM_AUDIT.baileysRelease.webSocketUpgradeHeaderSeam.available,
	openclawStockAuthStatePersistence:
		WHATSAPP_UPSTREAM_AUDIT.openclaw.stockAuthStatePersistenceCompatibility.available,
	hermesStockAuthStatePersistence:
		WHATSAPP_UPSTREAM_AUDIT.hermes.stockAuthStatePersistenceCompatibility.available,
	openclawNativePluginE2E: false,
	hermesNativePluginE2E: false,
	liveAccountDrill: false,
} as const;

export const WHATSAPP_LINKING_READY = false;
export const WHATSAPP_RUNTIME_READY = Object.values(WHATSAPP_RUNTIME_REQUIREMENTS).every(
	(requirement) => requirement,
);
export const WHATSAPP_UPSTREAM_READY = WHATSAPP_LINKING_READY && WHATSAPP_RUNTIME_READY;
