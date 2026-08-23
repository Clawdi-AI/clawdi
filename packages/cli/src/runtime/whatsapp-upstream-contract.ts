import { hasExactKeys, recordValue } from "./manifest-shared";

export const CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER = "x-clawdi-whatsapp-link-capability";
export const CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY = "clawdi.managedWhatsAppSocket";
export const CLAWDI_MANAGED_WHATSAPP_SOCKET_SCHEMA = "clawdi.managedWhatsAppSocket.v1";
export const CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_METADATA_KEY = "clawdi.managedWhatsAppCredential";
export const CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_SCHEMA = "clawdi.managedWhatsAppCredential.v1";

export interface ManagedWhatsAppSocketMetadataJson {
	schemaVersion: typeof CLAWDI_MANAGED_WHATSAPP_SOCKET_SCHEMA;
	capability: string;
	authCert: {
		SERIAL: number;
		ISSUER: string;
		PUBLIC_KEY: { type: "Buffer"; data: string };
	};
}

export interface ManagedWhatsAppCredentialMetadataJson {
	schemaVersion: typeof CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_SCHEMA;
	credentialId: string;
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

export function parseManagedWhatsAppCredentialMetadataJson(
	value: unknown,
): ManagedWhatsAppCredentialMetadataJson {
	const metadata = recordValue(value);
	if (
		!metadata ||
		!hasExactKeys(metadata, ["credentialId", "schemaVersion"]) ||
		metadata.schemaVersion !== CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_SCHEMA ||
		typeof metadata.credentialId !== "string" ||
		metadata.credentialId.length === 0 ||
		metadata.credentialId.trim() !== metadata.credentialId
	) {
		throw new Error("invalid Clawdi managed WhatsApp credential metadata");
	}
	return {
		schemaVersion: CLAWDI_MANAGED_WHATSAPP_CREDENTIAL_SCHEMA,
		credentialId: metadata.credentialId,
	};
}

function isCanonicalBase64Bytes(value: string, byteLength: number): boolean {
	const decoded = Buffer.from(value, "base64");
	return decoded.length === byteLength && decoded.toString("base64") === value;
}
