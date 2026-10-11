export function operationIdFromName(name: string | undefined): string | null {
	if (!name?.startsWith("operations/")) return null;
	const id = name.slice("operations/".length);
	return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
