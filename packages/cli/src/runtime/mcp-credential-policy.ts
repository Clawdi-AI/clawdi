const sensitiveNamePattern =
	/(?:^|_)(?:ACCESS_?KEY|API_?KEY|AUTHORIZATION|AUTH_?TOKEN|BEARER_?TOKEN|CLIENT_?SECRET|CREDENTIALS?|PASS(?:WORD|WD)?|PAT|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;

export function isValidMcpEnvironmentName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
}

export function isMcpSensitiveHeaderName(name: string): boolean {
	const normalized = name.toLowerCase();
	return (
		["authorization", "cookie", "proxy-authorization", "x-api-key", "x-auth-token"].includes(
			normalized,
		) || sensitiveNamePattern.test(name.replaceAll("-", "_"))
	);
}

export function isMcpSensitiveEnvironmentName(name: string): boolean {
	return name.toUpperCase() === "AUTH" || sensitiveNamePattern.test(name);
}

export function containsMcpPlaceholder(value: string): boolean {
	return /\$\{[^}]*\}/.test(value);
}

export function containsMcpSecretMaterial(value: string): boolean {
	const lowered = value.toLowerCase();
	return (
		lowered.includes("-----begin private key-----") ||
		/(?:sk|pk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}/.test(value)
	);
}

export function looksLikeMcpSecretLiteral(value: string): boolean {
	const lowered = value.trim().toLowerCase();
	return (
		["bearer ", "basic ", "apikey ", "api-key "].some((prefix) => lowered.startsWith(prefix)) ||
		/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/.test(value) ||
		containsMcpSecretMaterial(value)
	);
}
