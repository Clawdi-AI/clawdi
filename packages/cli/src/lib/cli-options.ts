import { InvalidArgumentError } from "commander";

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
