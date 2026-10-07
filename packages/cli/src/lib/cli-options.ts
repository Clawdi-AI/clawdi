import { InvalidArgumentError } from "commander";

/** Require a complete UUID before passing an identifier to the Cloud API. */
export function requireUuid(value: string, label: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
		throw new Error(`${label} must be a valid UUID.`);
	}
	return value;
}

/** Parse a CLI option that must be a positive, safe integer. */
export function parsePositiveInteger(value: string | number): number {
	const raw = String(value).trim();
	if (!/^\d+$/.test(raw)) {
		throw new InvalidArgumentError("must be a positive integer");
	}

	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new InvalidArgumentError("must be a positive integer");
	}
	return parsed;
}
