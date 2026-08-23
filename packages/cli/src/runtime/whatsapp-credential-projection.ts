import { resolve } from "node:path";
import { recordValue } from "./manifest-shared";

export type ManagedWhatsAppAuthTarget = "openclaw" | "hermes";

export interface ManagedWhatsAppAuthCredential {
	accountKey: string;
	linkId: string | null;
	credentialId: string;
	authDir: string;
	credsJsonSecretRef: string;
	target: ManagedWhatsAppAuthTarget;
}

export function managedWhatsAppAuthDir(
	home: string,
	target: ManagedWhatsAppAuthTarget,
	accountKey: string,
): string {
	return target === "hermes"
		? resolve(home, ".hermes", "platforms", "whatsapp", "session")
		: resolve(home, ".openclaw", "credentials", "whatsapp", accountKey);
}

export function managedWhatsAppAuthCredentials(
	channelCredentials: unknown,
): ManagedWhatsAppAuthCredential[] {
	if (!Array.isArray(channelCredentials)) return [];
	return channelCredentials
		.flatMap(parseManagedWhatsAppAuthCredential)
		.sort((left, right) =>
			`${left.target}:${left.accountKey}:${left.credentialId}`.localeCompare(
				`${right.target}:${right.accountKey}:${right.credentialId}`,
			),
		);
}

function parseManagedWhatsAppAuthCredential(value: unknown): ManagedWhatsAppAuthCredential[] {
	const record = recordValue(value);
	if (!record) return [];
	if (record.provider !== "whatsapp" || record.kind !== "whatsapp_baileys_auth_state") return [];
	const accountKey = stringValue(record.accountKey);
	const linkId = stringValue(record.linkId);
	const credentialId = stringValue(record.credentialId);
	const files = Array.isArray(record.files) ? record.files : [];
	const credsFile = files
		.map(recordValue)
		.find((file) => file?.path === "creds.json" && typeof file.secretRef === "string");
	const credsJsonSecretRef = credsFile ? stringValue(credsFile.secretRef) : null;
	if (!accountKey || !credentialId || !credsJsonSecretRef) {
		throw new Error("WhatsApp auth credential projection is incomplete");
	}
	const targets = recordValue(record.targets);
	if (!targets) {
		throw new Error("WhatsApp auth credential projection is incomplete");
	}
	const credentials: ManagedWhatsAppAuthCredential[] = [];
	const openclawTarget = recordValue(targets.openclaw);
	const openclawAuthDir = stringValue(openclawTarget?.authDir);
	if (openclawAuthDir) {
		credentials.push({
			accountKey,
			linkId,
			credentialId,
			authDir: openclawAuthDir,
			credsJsonSecretRef,
			target: "openclaw",
		});
	}
	const hermesTarget = recordValue(targets.hermes);
	const hermesAuthDir = hermesTarget ? stringValue(hermesTarget.authDir) : null;
	if (hermesAuthDir) {
		credentials.push({
			accountKey,
			linkId,
			credentialId,
			authDir: hermesAuthDir,
			credsJsonSecretRef,
			target: "hermes",
		});
	}
	if (credentials.length === 0) {
		throw new Error("WhatsApp auth credential projection is incomplete");
	}
	return credentials;
}
function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
