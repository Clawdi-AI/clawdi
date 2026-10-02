import { type CreationAttempt, parseCreationAttempt } from "./state";

type AttemptStore = {
	getItemAsync: (key: string) => Promise<string | null>;
	setItemAsync: (key: string, value: string) => Promise<void>;
	deleteItemAsync: (key: string) => Promise<void>;
};

/** Serialize journal writes and compare-and-set before deleting or changing a
 * submission marker. An old screen must not erase another screen's POST.
 */
export function createAttemptStore(store: AttemptStore) {
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
		if (!raw) return null;
		const attempt = parseCreationAttempt(raw);
		if (!attempt) throw new Error("Invalid saved creation attempt");
		return attempt;
	}
	async function compare(key: string, expected: CreationAttempt | null, isCurrent: () => boolean) {
		if (!isCurrent()) throw new Error("Creation owner changed");
		const saved = await read(key);
		if (!isCurrent()) throw new Error("Creation owner changed");
		if (JSON.stringify(saved) !== JSON.stringify(expected))
			throw new Error("Saved request changed");
	}
	return {
		readSavedAttempt: (key: string) => serialize(() => read(key)),
		saveAttempt: (key: string, attempt: CreationAttempt, isCurrent: () => boolean) =>
			serialize(async () => {
				await compare(key, null, isCurrent);
				await store.setItemAsync(key, JSON.stringify(attempt));
			}),
		replaceAttempt: (
			key: string,
			expected: CreationAttempt,
			next: CreationAttempt,
			isCurrent: () => boolean,
		) =>
			serialize(async () => {
				if (
					next.id !== expected.id ||
					JSON.stringify(next.request) !== JSON.stringify(expected.request) ||
					JSON.stringify(next.draft) !== JSON.stringify(expected.draft)
				)
					throw new Error("Request payload changed");
				await compare(key, expected, isCurrent);
				await store.setItemAsync(key, JSON.stringify(next));
			}),
		clearAttempt: (key: string, expected: CreationAttempt, isCurrent: () => boolean) =>
			serialize(async () => {
				await compare(key, expected, isCurrent);
				await store.deleteItemAsync(key);
			}),
	};
}
