import { getAuth } from "./config";

export class AuthorizationRequiredError extends Error {
	constructor(message = "Not signed in. Run `clawdi auth login` first.") {
		super(message);
		this.name = "AuthorizationRequiredError";
	}
}

export function requireAuth() {
	const auth = getAuth();
	if (!auth) throw new AuthorizationRequiredError();
	return auth;
}
