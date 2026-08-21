import type { AccountSuspendedProblem } from "@clawdi/shared/api";

export const ACCOUNT_SUSPENDED_CODE: AccountSuspendedProblem["code"] = "account_suspended";
const ACCOUNT_SUSPENDED_TYPE: AccountSuspendedProblem["type"] =
	"urn:clawdi:problem:account-suspended";

let accountSuspended = false;
const listeners = new Set<() => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isAccountSuspendedProblem(value: unknown): value is AccountSuspendedProblem {
	return (
		isRecord(value) &&
		value.type === ACCOUNT_SUSPENDED_TYPE &&
		value.status === 401 &&
		value.code === ACCOUNT_SUSPENDED_CODE &&
		typeof value.detail === "string"
	);
}

export function getAccountSuspendedSnapshot(): boolean {
	return accountSuspended;
}

export function getAccountSuspendedServerSnapshot(): boolean {
	return false;
}

export function subscribeToAccountSuspension(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function markAccountSuspended(): void {
	if (accountSuspended) return;
	accountSuspended = true;
	for (const listener of listeners) listener();
}

export function clearAccountSuspension(): void {
	if (!accountSuspended) return;
	accountSuspended = false;
	for (const listener of listeners) listener();
}

export async function observeAccountSuspensionResponse(response: Response): Promise<boolean> {
	if (response.status !== 401) return false;
	try {
		const body: unknown = await response.clone().json();
		if (!isAccountSuspendedProblem(body)) return false;
		markAccountSuspended();
		return true;
	} catch {
		return false;
	}
}
