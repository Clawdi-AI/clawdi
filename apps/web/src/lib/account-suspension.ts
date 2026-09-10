import type { AccountSuspendedProblem } from "@clawdi/shared/api";
import { createContext, useContext } from "react";

export const ACCOUNT_SUSPENDED_CODE: AccountSuspendedProblem["code"] = "account_suspended";
const ACCOUNT_SUSPENDED_TYPE: AccountSuspendedProblem["type"] =
	"urn:clawdi:problem:account-suspended";

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

export function createAccountSuspensionStore() {
	let suspended = false;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => suspended,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async observeResponse(response: Response): Promise<boolean> {
			if (response.status !== 401) return false;
			try {
				const body: unknown = await response.clone().json();
				if (!isAccountSuspendedProblem(body)) return false;
				suspended = true;
				for (const listener of listeners) listener();
				return true;
			} catch {
				return false;
			}
		},
	};
}

export const AccountSuspensionContext = createContext<ReturnType<
	typeof createAccountSuspensionStore
> | null>(null);

export function useAccountSuspension() {
	const store = useContext(AccountSuspensionContext);
	if (!store) throw new Error("Missing account scope");
	return store;
}
