export interface Vault {
	id: string;
	userId: string;
	slug: string;
	name: string;
	createdAt: string;
}

export interface VaultItem {
	id: string;
	vaultId: string;
	itemName: string;
	section: string;
	createdAt: string;
	updatedAt: string;
}

export interface VaultRef {
	vault: string;
	section: string;
	field: string;
}

export function parseVaultUri(uri: string): VaultRef | null {
	const match = uri.match(/^clawdi:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
	if (!match) return null;
	return { vault: match[1], section: match[2], field: match[3] };
}
