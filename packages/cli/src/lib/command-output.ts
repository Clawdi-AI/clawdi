import { progressLine } from "./progress";

/** Keep human messages out of machine-readable stdout. */
export function commandMessage(json: boolean | undefined, message = ""): void {
	if (json) progressLine(message);
	else console.log(message);
}

export function commandResult(
	json: boolean | undefined,
	schemaVersion: string,
	result: Record<string, unknown>,
): void {
	if (json) console.log(JSON.stringify({ ...result, schemaVersion }));
}
