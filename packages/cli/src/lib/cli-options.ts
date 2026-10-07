import { InvalidArgumentError } from "commander";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RFC4122_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Return whether a value is a complete UUID. */
export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

/** Require a complete UUID before passing an identifier to the Cloud API. */
export function requireUuid(
	value: string,
	label: string,
	options: { rfc4122?: boolean } = {},
): string {
	const valid = options.rfc4122 ? UUID_RFC4122_RE.test(value) : isUuid(value);
	if (!valid) {
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
