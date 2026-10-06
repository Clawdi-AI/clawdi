import { getAuth } from "./config";

export function requireAuth() {
	const auth = getAuth();
	if (!auth) throw new Error("Not signed in. Run `clawdi auth login` first.");
	return auth;
}
