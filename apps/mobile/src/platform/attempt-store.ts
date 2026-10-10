export type AttemptStore = {
	getItemAsync: (key: string) => Promise<string | null>;
	setItemAsync: (key: string, value: string) => Promise<void>;
	deleteItemAsync: (key: string) => Promise<void>;
};

/** Serialize journal writes and compare-and-set before deleting or changing a
 * submission marker. An old screen must not erase another screen's POST.
 */
export function createSerializedAttemptStore<T>(
	store: AttemptStore,
	options: {
		parse: (raw: string) => T | null;
		sameIntent: (previous: T, next: T) => boolean;
		ownerError: string;
	},
) {
	let pending: Promise<void> = Promise.resolve();
	function serialize<T>(work: () => Promise<T>): Promise<T> {
		const result = pending.then(work);
		pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	async function read(key: string) {
		const raw = await store.getItemAsync(key);
		if (raw === null) return null;
		const attempt = options.parse(raw);
		if (!attempt) throw new Error("Invalid saved attempt");
		return attempt;
	}
	async function compare(key: string, expected: T | null, isCurrent: () => boolean) {
		if (!isCurrent()) throw new Error(options.ownerError);
		const saved = await read(key);
		if (!isCurrent()) throw new Error(options.ownerError);
		// Compare canonical forms: an equal attempt may be built with another key order.
		const canonical = expected === null ? null : options.parse(JSON.stringify(expected));
		if (expected !== null && canonical === null) throw new Error("Invalid saved attempt");
		if (JSON.stringify(saved) !== JSON.stringify(canonical))
			throw new Error("Saved request changed");
	}
	return {
		readSavedAttempt: (key: string) => serialize(() => read(key)),
		saveAttempt: (key: string, attempt: T, isCurrent: () => boolean) =>
			serialize(async () => {
				await compare(key, null, isCurrent);
				await store.setItemAsync(key, JSON.stringify(attempt));
			}),
		replaceAttempt: (key: string, expected: T, next: T, isCurrent: () => boolean) =>
			serialize(async () => {
				if (!options.sameIntent(expected, next)) throw new Error("Request payload changed");
				await compare(key, expected, isCurrent);
				await store.setItemAsync(key, JSON.stringify(next));
			}),
		clearAttempt: (key: string, expected: T, isCurrent: () => boolean) =>
			serialize(async () => {
				await compare(key, expected, isCurrent);
				await store.deleteItemAsync(key);
			}),
	};
}
