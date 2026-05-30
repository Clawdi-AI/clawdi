export interface SecretFinding {
	label: string;
}

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
	{ label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
	{ label: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
	{ label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
	{ label: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i },
];

export function findLikelySecret(value: string): SecretFinding | null {
	for (const { label, pattern } of SECRET_PATTERNS) {
		if (pattern.test(value)) return { label };
	}
	return null;
}

export function formatSecretMemoryWarning(finding: SecretFinding): string {
	return `Detected a likely ${finding.label}. Store secrets with \`clawdi vault set <KEY> --stdin\` and save a clawdi:// reference in memory instead.`;
}
