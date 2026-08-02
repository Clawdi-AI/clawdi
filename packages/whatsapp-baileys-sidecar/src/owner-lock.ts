import { closeSync, constants, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OWNER_LOCK_FILE = ".clawdi-provider-owner.lock";

export type ProviderAccountOwnerLock = {
	path: string;
	release(): void;
};

export function acquireProviderAccountOwnerLock(
	sessionDir: string,
	accountId: string,
): ProviderAccountOwnerLock {
	const path = join(sessionDir, OWNER_LOCK_FILE);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const descriptor = openSync(
				path,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
				0o600,
			);
			writeFileSync(
				descriptor,
				`${JSON.stringify({ accountId, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
				{ encoding: "utf-8" },
			);
			let released = false;
			return {
				path,
				release(): void {
					if (released) return;
					released = true;
					closeSync(descriptor);
					unlinkSync(path);
				},
			};
		} catch (error: unknown) {
			if (!isAlreadyExists(error)) throw error;
			const owner = readOwner(path);
			if (attempt === 0 && owner !== null && !processIsAlive(owner.pid)) {
				unlinkSync(path);
				continue;
			}
			const detail = owner
				? `account ${owner.accountId} is already owned by pid ${owner.pid}`
				: "the provider owner lock already exists and cannot be verified";
			throw new Error(`WhatsApp provider session is exclusively owned: ${detail}`);
		}
	}
	throw new Error("WhatsApp provider session owner lock could not be acquired");
}

function readOwner(path: string): { accountId: string; pid: number } | null {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(value) || typeof value.accountId !== "string" || !Number.isInteger(value.pid)) {
			return null;
		}
		return { accountId: value.accountId, pid: Number(value.pid) };
	} catch {
		return null;
	}
}

function processIsAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return !isNoSuchProcess(error);
	}
}

function isAlreadyExists(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}

function isNoSuchProcess(error: unknown): boolean {
	return isRecord(error) && error.code === "ESRCH";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
