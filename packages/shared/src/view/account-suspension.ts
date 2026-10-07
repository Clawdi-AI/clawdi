import type { AccountSuspendedProblem } from "../api/schemas";

/** Copy for the full-page account-suspended state on Web and mobile. */
export const accountSuspendedCopy = {
	title: "Account suspended",
	reason: "Your account has been suspended due to a violation of the Clawdi User Agreement.",
	help: "Contact support if you believe this is a mistake or need help.",
	contactSupport: "Contact support",
	signOut: "Sign out",
	signingOut: "Signing out",
	signOutFailed: "We couldn't sign you out. Try again.",
} as const;

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

/** One store per signed-in account: a late response never marks the next account suspended. */
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

export type AccountSuspensionStore = ReturnType<typeof createAccountSuspensionStore>;

/** Wraps an account client's fetch so any response can reveal the suspension. */
export function observeAccountSuspension<Args extends unknown[]>(
	store: AccountSuspensionStore,
	fetch: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
	return async (...args) => {
		const response = await fetch(...args);
		await store.observeResponse(response);
		return response;
	};
}
