import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ApiClient } from "../lib/api-client";
import { canonicalApiOrigin } from "../lib/api-origin";
import { getAuth, getConfig } from "../lib/config";
import {
	assertUniqueVaultWorkspace,
	readEnvironmentRegistration,
	readEnvironmentRegistrationForCleanup,
} from "../lib/environment-registration";
import { readMachineId } from "../lib/machine-identity";
import {
	clearConnectedVaultFiles,
	connectedVaultFilesSupported,
	syncRuntimeVaultFiles,
} from "../runtime/vault-files";
import { getServeStateDir } from "./paths";

export interface ConnectedVaultSync {
	enabled: boolean;
	reconcile(force?: boolean): Promise<void>;
	revoke(): void;
	finish(): Promise<void>;
}

/** Cold-start cleanup must run before account-filtered registration selects workers. */
export function clearAccountMismatchedVaultFiles(agentType: string, agentId?: string): void {
	if (!connectedVaultFilesSupported() || process.env.CLAWDI_RUNTIME_MODE === "hosted") return;
	const previous = readEnvironmentRegistrationForCleanup(agentType);
	const binding = previous?.vaultWorkspace;
	if (
		!previous?.userId ||
		!previous.machineId ||
		!binding ||
		previous.userId === getAuth()?.userId ||
		previous.machineId !== readMachineId() ||
		(agentId !== undefined && previous.id !== agentId)
	)
		return;
	const stateRoot = getServeStateDir(agentType);
	clearConnectedVaultFiles(
		join(stateRoot, "vault-files.json"),
		stateRoot,
		process.env.HOME || homedir(),
		{
			userId: previous.userId,
			machineId: previous.machineId,
			agentId: previous.id,
			workspace: binding.path,
			nativeAgentId: binding.nativeAgentId,
			apiUrl: binding.apiOrigin,
		},
		true,
	);
}

/** A single coalescing consumer of the engine's existing SSE and heartbeat ticks. */
export function prepareConnectedVaultSync(input: {
	agentType: string;
	agentId: string;
	api: ApiClient;
	abort: AbortSignal;
	report(message: string | null, failure?: boolean): void;
}): ConnectedVaultSync {
	const { agentType, agentId, api, abort, report } = input;
	const stateRoot = getServeStateDir(agentType);
	const receiptPath = join(stateRoot, "vault-files.json");
	const home = process.env.HOME || homedir();
	const registration = readEnvironmentRegistration(agentType);
	const binding = registration?.vaultWorkspace;
	const userId = registration?.userId;
	const machineId = registration?.machineId;
	let enabled = process.env.CLAWDI_RUNTIME_MODE !== "hosted" && connectedVaultFilesSupported();
	let running: Promise<void> | null = null;
	let pending = false;
	let pendingClear = false;
	let retryAt = 0;
	let backoff = 0;
	const clear = () => {
		if (process.env.CLAWDI_RUNTIME_MODE === "hosted" || !connectedVaultFilesSupported()) return;
		try {
			if (binding && userId && machineId) {
				pendingClear = true;
				clearConnectedVaultFiles(
					receiptPath,
					stateRoot,
					home,
					{
						userId,
						machineId,
						agentId,
						workspace: binding.path,
						nativeAgentId: binding.nativeAgentId,
						apiUrl: api.baseUrl,
					},
					true,
				);
				pendingClear = false;
			}
		} catch {
			report(
				"Owned Vault cleanup is deferred; persistent filesystem conflicts require local repair.",
				true,
			);
		}
	};
	const current = () => {
		const latest = readEnvironmentRegistration(agentType);
		if (
			!binding ||
			!userId ||
			!machineId ||
			registration?.id !== agentId ||
			getAuth()?.userId !== userId ||
			readMachineId() !== machineId ||
			canonicalApiOrigin(getConfig().apiUrl) !== api.baseUrl ||
			binding.apiOrigin !== api.baseUrl ||
			latest?.id !== agentId ||
			latest.userId !== userId ||
			latest.machineId !== machineId ||
			latest.vaultWorkspace?.path !== binding.path ||
			latest.vaultWorkspace.apiOrigin !== binding.apiOrigin ||
			latest.vaultWorkspace.nativeAgentId !== binding.nativeAgentId ||
			realpathSync(binding.path) !== binding.path
		) {
			throw new Error("Vault registration identity changed");
		}
		assertUniqueVaultWorkspace(agentType, binding.path);
	};
	if (process.env.CLAWDI_RUNTIME_MODE === "hosted") enabled = false;
	else if (!connectedVaultFilesSupported()) {
		report("Automatic Vault files require macOS or Linux/WSL; native Windows is unsupported.");
	} else {
		try {
			current();
			if (!binding || !userId || !machineId) throw new Error("Missing binding");
			clearConnectedVaultFiles(receiptPath, stateRoot, home, {
				userId,
				machineId,
				agentId,
				workspace: binding.path,
				nativeAgentId: binding.nativeAgentId,
				apiUrl: api.baseUrl,
			});
		} catch {
			enabled = false;
			try {
				clearAccountMismatchedVaultFiles(agentType, agentId);
			} catch {
				report("Owned Vault files need local repair.", true);
			}
			if (registration?.id === agentId && registration.userId === getAuth()?.userId) {
				try {
					if (binding) clear();
					else clearConnectedVaultFiles(receiptPath, stateRoot, home);
				} catch {
					report("Owned Vault files need local repair.", true);
				}
			}
			report(
				`Vault file sync is disabled. Run clawdi setup --agent ${agentType} --vault-workspace <path>.`,
			);
		}
	}
	const reconcile = (force = false): Promise<void> => {
		if (force) {
			retryAt = 0;
			backoff = 0;
		}
		if (!enabled || abort.aborted) return Promise.resolve();
		pending = true;
		if (running) return running;
		running = (async () => {
			while (pending && !abort.aborted && enabled) {
				pending = false;
				try {
					current();
				} catch {
					enabled = false;
					clear();
					report("Vault identity or workspace changed; run setup and restart the daemon.");
					return;
				}
				if (Date.now() < retryAt) {
					if (backoff > 0) return;
					await delay(retryAt - Date.now(), undefined, { signal: abort }).catch(() => {});
					if (abort.aborted) return;
				}
				if (!binding || !userId || !machineId) return;
				try {
					const result = await syncRuntimeVaultFiles({
						apiUrl: api.baseUrl,
						agentId,
						home,
						workspace: binding.path,
						receiptPath,
						connected: {
							userId,
							machineId,
							nativeAgentId: binding.nativeAgentId,
							stateRoot,
							assertCurrent() {
								current();
								if (abort.aborted) throw new Error("Vault sync stopped");
							},
							async request(url, init) {
								current();
								const token = await api.getAccessToken();
								current();
								const headers = new Headers(init.headers);
								headers.set("Authorization", `Bearer ${token}`);
								headers.set("X-Clawdi-Machine-Id", machineId);
								return fetch(url, {
									...init,
									headers,
									signal: AbortSignal.any([abort, AbortSignal.timeout(10000)]),
								});
							},
						},
					});
					report(
						result === "revoked" ? "Vault access was revoked; generated files removed." : null,
						result === "revoked",
					);
					backoff = 0;
					// At most four catch-up passes per second; a queued burst remains one signal.
					retryAt = Date.now() + 250;
				} catch {
					try {
						current();
					} catch {
						enabled = false;
						clear();
					}
					backoff = Math.min(backoff ? backoff * 2 : 60000, 300000);
					retryAt = Date.now() + backoff;
					if (!abort.aborted)
						report("Vault file sync deferred; last good files retained where possible.", true);
				}
			}
		})().finally(() => {
			running = null;
			if (pendingClear) clear();
		});
		return running;
	};
	return {
		get enabled() {
			return enabled;
		},
		reconcile,
		revoke: clear,
		async finish() {
			await running;
			if (pendingClear) clear();
			try {
				current();
			} catch {
				clear();
			}
		},
	};
}
