import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentType } from "../adapters/registry";
import { canonicalApiOrigin } from "./api-origin";
import { getAuth, getClawdiDir, getConfig, readRecoverablePrivateJson } from "./config";
import { withPrivateDirectoryLockSync } from "./private-directory-lock";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "./private-file";

export interface VaultWorkspaceBinding {
	path: string;
	apiOrigin: string;
	nativeAgentId?: string;
}

export interface EnvironmentRegistration {
	id: string;
	agentType: AgentType;
	machineId: string;
	machineName: string;
	userId?: string;
	vaultWorkspace?: VaultWorkspaceBinding;
}

export interface StoredEnvironmentRegistration {
	id: string;
	agentType: AgentType;
	machineId?: string;
	machineName?: string;
	userId?: string;
	vaultWorkspace?: VaultWorkspaceBinding;
}

export function readEnvironmentRegistration(
	agentType: string,
): StoredEnvironmentRegistration | null {
	const registration = readEnvironmentRegistrationForCleanup(agentType);
	if (registration?.userId && registration.userId !== getAuth()?.userId?.trim()) return null;
	return registration;
}

/** Validated local provenance only; never use this unfiltered read to authorize sync. */
export function readEnvironmentRegistrationForCleanup(
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
	const binding = record.vaultWorkspace;
	const vaultWorkspace =
		binding &&
		typeof binding === "object" &&
		!Array.isArray(binding) &&
		"path" in binding &&
		typeof binding.path === "string" &&
		"apiOrigin" in binding &&
		typeof binding.apiOrigin === "string" &&
		(!("nativeAgentId" in binding) || typeof binding.nativeAgentId === "string")
			? {
					path: binding.path,
					apiOrigin: binding.apiOrigin,
					...("nativeAgentId" in binding && typeof binding.nativeAgentId === "string"
						? { nativeAgentId: binding.nativeAgentId }
						: {}),
				}
			: undefined;
	return {
		id: record.id,
		...(vaultWorkspace && record.userId && record.machineId ? { vaultWorkspace } : {}),
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
			`${JSON.stringify({ ...registration, userId: normalizedUserId, vaultWorkspace: undefined }, null, 2)}\n`,
			{
				mode: PRIVATE_FILE_MODE,
				dirMode: PRIVATE_DIR_MODE,
				durable: true,
			},
		);
		return true;
	});
}

export function writeEnvironmentRegistration(registration: EnvironmentRegistration): boolean {
	const clawdiDir = getClawdiDir();
	return withPrivateDirectoryLockSync(join(clawdiDir, "environments.lock"), (lease) => {
		const path = join(clawdiDir, "environments", `${registration.agentType}.json`);
		const prior = readRecoverablePrivateJson<StoredEnvironmentRegistration>(path);
		const sameIdentity =
			prior?.id === registration.id &&
			prior?.userId === registration.userId &&
			prior?.machineId === registration.machineId &&
			(!prior.vaultWorkspace ||
				prior.vaultWorkspace.apiOrigin === canonicalApiOrigin(getConfig().apiUrl));
		const binding =
			registration.vaultWorkspace ?? (sameIdentity ? prior?.vaultWorkspace : undefined);
		if (binding && !registration.userId)
			throw new Error("Vault workspace requires an authenticated account identity.");
		const next = { ...registration, vaultWorkspace: binding };
		if (binding) {
			binding.path = realpathSync(resolve(binding.path));
			binding.apiOrigin = canonicalApiOrigin(binding.apiOrigin);
			if (!statSync(binding.path).isDirectory())
				throw new Error("Vault workspace must be an existing directory.");
			assertUniqueVaultWorkspace(registration.agentType, binding.path);
		}
		lease.assertOwned();
		writePrivateFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, {
			mode: PRIVATE_FILE_MODE,
			dirMode: PRIVATE_DIR_MODE,
			durable: true,
		});
		return (
			Boolean(prior?.vaultWorkspace || binding) &&
			(!sameIdentity || JSON.stringify(prior?.vaultWorkspace) !== JSON.stringify(binding))
		);
	});
}

function environmentRegistrationPath(agentType: string): string {
	return join(getClawdiDir(), "environments", `${agentType}.json`);
}

/** Check every registration, including other accounts, before claiming a real workspace. */
export function assertUniqueVaultWorkspace(agentType: string, workspace: string): void {
	const directory = join(getClawdiDir(), "environments");
	if (!existsSync(directory)) return;
	const canonical = realpathSync(workspace);
	const identity = statSync(canonical, { bigint: true });
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".json") || name === `${agentType}.json`) continue;
		const other = readRecoverablePrivateJson<StoredEnvironmentRegistration>(join(directory, name));
		const path = other?.vaultWorkspace?.path;
		const otherIdentity = path && existsSync(path) ? statSync(path, { bigint: true }) : null;
		if (
			path &&
			(path === canonical ||
				(otherIdentity?.dev === identity.dev && otherIdentity.ino === identity.ino))
		) {
			throw new Error("Vault workspace is already bound to another registered Agent.");
		}
	}
}
