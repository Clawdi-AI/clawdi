import { accountOAuthNavigation } from "../src/auth/account-oauth";

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
	return accountOAuthNavigation(path);
}
