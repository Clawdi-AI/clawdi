import { join } from "node:path";
import type { AgentType } from "../adapters/registry";
import { getAuth, getClawdiDir, readRecoverablePrivateJson } from "./config";
import { withPrivateDirectoryLockSync } from "./private-directory-lock";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "./private-file";

export interface EnvironmentRegistration {
	id: string;
	agentType: AgentType;
	machineId: string;
	machineName: string;
	userId?: string;
}

export interface StoredEnvironmentRegistration {
	id: string;
	agentType: AgentType;
	machineId?: string;
	machineName?: string;
	userId?: string;
}

export function readEnvironmentRegistration(
	agentType: string,
): StoredEnvironmentRegistration | null {
	const value = readRecoverablePrivateJson<unknown>(environmentRegistrationPath(agentType));
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		!record.id.trim() ||
		(record.agentType !== undefined && record.agentType !== agentType) ||
		(record.machineId !== undefined &&
			(typeof record.machineId !== "string" || !record.machineId.trim())) ||
		(record.machineName !== undefined && typeof record.machineName !== "string") ||
		(record.userId !== undefined &&
			(typeof record.userId !== "string" ||
				!record.userId.trim() ||
				record.userId !== record.userId.trim()))
	) {
		return null;
	}
	const currentUserId = getAuth()?.userId?.trim();
	if (typeof record.userId === "string" && record.userId !== currentUserId) return null;
	return {
		id: record.id,
		agentType: agentType as AgentType,
		...(typeof record.machineId === "string" ? { machineId: record.machineId } : {}),
		...(typeof record.machineName === "string" ? { machineName: record.machineName } : {}),
		...(typeof record.userId === "string" ? { userId: record.userId } : {}),
	};
}

export function bindEnvironmentRegistrationUser(
	agentType: AgentType,
	environmentId: string,
	userId: string,
): boolean {
	const normalizedUserId = userId.trim();
	if (!normalizedUserId) throw new Error("Cannot bind an Agent registration without a user id.");
	const clawdiDir = getClawdiDir();
	return withPrivateDirectoryLockSync(join(clawdiDir, "environments.lock"), (lease) => {
		const path = environmentRegistrationPath(agentType);
		const value = readRecoverablePrivateJson<unknown>(path);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const registration = value as Record<string, unknown>;
		if (
			registration.id !== environmentId ||
			(registration.agentType !== undefined && registration.agentType !== agentType)
		) {
			return false;
		}
		if (registration.userId !== undefined) {
			return registration.userId === normalizedUserId;
		}
		lease.assertOwned();
		writePrivateFileAtomic(
			path,
			`${JSON.stringify({ ...registration, userId: normalizedUserId }, null, 2)}\n`,
			{
				mode: PRIVATE_FILE_MODE,
				dirMode: PRIVATE_DIR_MODE,
				durable: true,
			},
		);
		return true;
	});
}

export function writeEnvironmentRegistration(registration: EnvironmentRegistration): void {
	const clawdiDir = getClawdiDir();
	withPrivateDirectoryLockSync(join(clawdiDir, "environments.lock"), (lease) => {
		const path = join(clawdiDir, "environments", `${registration.agentType}.json`);
		lease.assertOwned();
		writePrivateFileAtomic(path, `${JSON.stringify(registration, null, 2)}\n`, {
			mode: PRIVATE_FILE_MODE,
			dirMode: PRIVATE_DIR_MODE,
			durable: true,
		});
	});
}

function environmentRegistrationPath(agentType: string): string {
	return join(getClawdiDir(), "environments", `${agentType}.json`);
}
