import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getClawdiDir } from "./config";
import { withPrivateDirectoryLockSync } from "./private-directory-lock";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "./private-file";

interface MachineIdentity {
	schemaVersion: "clawdi.machineIdentity.v1";
	id: string;
}

const MACHINE_ID_MAX_LENGTH = 200;

export function getOrCreateMachineId(): string {
	const clawdiDir = getClawdiDir();
	const identityPath = join(clawdiDir, "machine.json");
	return withPrivateDirectoryLockSync(join(clawdiDir, "machine-identity.lock"), (lease) => {
		const existing = readMachineIdentity(identityPath);
		if (existing) return existing.id;
		if (existsSync(identityPath)) {
			throw new Error(
				`Local installation identity is invalid at ${identityPath}. Move the damaged file aside, then run \`clawdi agent reconnect\` to recover the existing Agent identity.`,
			);
		}
		const id = legacyMachineId(clawdiDir) ?? randomUUID();
		const identity: MachineIdentity = {
			schemaVersion: "clawdi.machineIdentity.v1",
			id,
		};
		lease.assertOwned();
		writePrivateFileAtomic(identityPath, `${JSON.stringify(identity, null, 2)}\n`, {
			mode: PRIVATE_FILE_MODE,
			dirMode: PRIVATE_DIR_MODE,
			durable: true,
		});
		return id;
	});
}

/** Read the durable installation identity without creating or repairing it. */
export function readMachineId(): string | null {
	return readMachineIdentity(join(getClawdiDir(), "machine.json"))?.id ?? null;
}

function readMachineIdentity(path: string): MachineIdentity | null {
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
		const record = value as Record<string, unknown>;
		if (record.schemaVersion !== "clawdi.machineIdentity.v1" || !validMachineId(record.id)) {
			return null;
		}
		return {
			schemaVersion: "clawdi.machineIdentity.v1",
			id: record.id,
		};
	} catch {
		return null;
	}
}

function legacyMachineId(clawdiDir: string): string | null {
	const environmentsDir = join(clawdiDir, "environments");
	if (!existsSync(environmentsDir)) return null;
	for (const fileName of readdirSync(environmentsDir).sort()) {
		if (!fileName.endsWith(".json")) continue;
		try {
			const value = JSON.parse(readFileSync(join(environmentsDir, fileName), "utf8")) as unknown;
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			const machineId = (value as Record<string, unknown>).machineId;
			if (validMachineId(machineId)) return machineId;
		} catch {
			// Ignore a damaged Agent cache and continue looking for a valid legacy identity.
		}
	}
	return null;
}

function validMachineId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MACHINE_ID_MAX_LENGTH &&
		value.trim() === value
	);
}
