import type { AccountSuspensionStore } from "@clawdi/shared/view";
import { createContext, useContext } from "react";

export const AccountSuspensionContext = createContext<AccountSuspensionStore | null>(null);

export function useAccountSuspension() {
	const store = useContext(AccountSuspensionContext);
	if (!store) throw new Error("Missing account scope");
	return store;
}
