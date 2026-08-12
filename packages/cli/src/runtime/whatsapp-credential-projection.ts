export interface ManagedWhatsAppAuthCredential {
	accountKey: string;
	credentialId: string;
	authDir: string;
	credsJsonSecretRef: string;
	target: "openclaw" | "hermes" | "legacy";
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
	const credentials: ManagedWhatsAppAuthCredential[] = [];
	const openclawTarget = targets ? recordValue(targets.openclaw) : null;
	const openclawAuthDir = targets
		? stringValue(openclawTarget?.authDir)
		: stringValue(record.authDir);
	if (openclawAuthDir) {
		credentials.push({
			accountKey,
			credentialId,
			authDir: openclawAuthDir,
			credsJsonSecretRef,
			target: targets ? "openclaw" : "legacy",
		});
	}
	const hermesTarget = targets ? recordValue(targets.hermes) : null;
	const hermesAuthDir = hermesTarget ? stringValue(hermesTarget.authDir) : null;
	if (hermesAuthDir) {
		credentials.push({
			accountKey,
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

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
