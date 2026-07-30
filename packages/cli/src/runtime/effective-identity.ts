export interface EffectiveIdentity {
	uid: number;
	gid: number;
}

export interface EffectiveIdentityProcess {
	geteuid(): number;
	getegid(): number;
	getgroups(): number[];
	seteuid(id: number): void;
	setegid(id: number): void;
	setgroups(groups: readonly number[]): void;
}

const processIdentity: EffectiveIdentityProcess = {
	geteuid: () => requiredCredentialFunction("geteuid", process.geteuid)(),
	getegid: () => requiredCredentialFunction("getegid", process.getegid)(),
	getgroups: () => requiredCredentialFunction("getgroups", process.getgroups)(),
	seteuid: (id) => requiredCredentialFunction("seteuid", process.seteuid)(id),
	setegid: (id) => requiredCredentialFunction("setegid", process.setegid)(id),
	setgroups: (groups) => requiredCredentialFunction("setgroups", process.setgroups)([...groups]),
};

function requiredCredentialFunction<T extends (...args: never[]) => unknown>(
	name: string,
	value: T | undefined,
): T {
	if (typeof value !== "function") {
		throw new Error(`effective identity requires process.${name}`);
	}
	return value;
}

export function withEffectiveFilesystemIdentity<T>(
	identity: EffectiveIdentity,
	operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
	credentials: EffectiveIdentityProcess = processIdentity,
): T {
	const originalUid = credentials.geteuid();
	const originalGid = credentials.getegid();
	const originalGroups = credentials.getgroups();
	if (originalUid !== 0 || (identity.uid === originalUid && identity.gid === originalGid)) {
		return operation();
	}
	if (identity.uid === 0 || identity.gid === 0) {
		throw new Error("effective filesystem identity must be non-root");
	}

	let outcome: { ok: true; value: T } | { ok: false; error: unknown };
	try {
		credentials.setgroups([identity.gid]);
		credentials.setegid(identity.gid);
		credentials.seteuid(identity.uid);
		outcome = { ok: true, value: operation() };
	} catch (error) {
		outcome = { ok: false, error };
	}

	let restoreError: unknown;
	try {
		credentials.seteuid(originalUid);
		credentials.setgroups(originalGroups);
		credentials.setegid(originalGid);
	} catch (error) {
		restoreError = error;
	}
	if (restoreError !== undefined) {
		throw new Error("failed to restore root filesystem identity", { cause: restoreError });
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
