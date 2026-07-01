import { readFileSync } from "node:fs";

export function loadAuthTokenFile(path: string | undefined, label = "--auth-token-file"): void {
	if (!path) return;
	const normalized = path.trim();
	if (!normalized) throw new Error(`${label} must not be empty`);
	const token = readFileSync(normalized, "utf-8").trim();
	if (!token) throw new Error(`${label} ${normalized} is empty`);
	process.env.CLAWDI_AUTH_TOKEN = token;
}
