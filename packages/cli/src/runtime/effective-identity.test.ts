import { describe, expect, test } from "bun:test";
import {
	type EffectiveIdentityProcess,
	withEffectiveFilesystemIdentity,
} from "./effective-identity";

function fakeCredentials() {
	let uid = 0;
	let gid = 0;
	let groups = [0, 27];
	const transitions: string[] = [];
	const credentials: EffectiveIdentityProcess = {
		geteuid: () => uid,
		getegid: () => gid,
		getgroups: () => [...groups],
		seteuid: (value) => {
			uid = value;
			transitions.push(`uid:${value}`);
		},
		setegid: (value) => {
			gid = value;
			transitions.push(`gid:${value}`);
		},
		setgroups: (value) => {
			groups = [...value];
			transitions.push(`groups:${value.join(",")}`);
		},
	};
	return { credentials, transitions, current: () => ({ uid, gid, groups }) };
}

describe("effective filesystem identity", () => {
	test("drops supplementary groups and restores root after success", () => {
		const fake = fakeCredentials();
		const result = withEffectiveFilesystemIdentity(
			{ uid: 10_001, gid: 10_001 },
			() => fake.current(),
			fake.credentials,
		);
		expect(result).toEqual({ uid: 10_001, gid: 10_001, groups: [10_001] });
		expect(fake.current()).toEqual({ uid: 0, gid: 0, groups: [0, 27] });
		expect(fake.transitions).toEqual([
			"groups:10001",
			"gid:10001",
			"uid:10001",
			"uid:0",
			"groups:0,27",
			"gid:0",
		]);
	});

	test("restores root before propagating an operation failure", () => {
		const fake = fakeCredentials();
		expect(() =>
			withEffectiveFilesystemIdentity(
				{ uid: 10_001, gid: 10_001 },
				() => {
					throw new Error("projection failed");
				},
				fake.credentials,
			),
		).toThrow("projection failed");
		expect(fake.current()).toEqual({ uid: 0, gid: 0, groups: [0, 27] });
	});

	test("rejects a partial drop that retains a root uid or gid", () => {
		for (const identity of [
			{ uid: 0, gid: 10_001 },
			{ uid: 10_001, gid: 0 },
		]) {
			const fake = fakeCredentials();
			expect(() =>
				withEffectiveFilesystemIdentity(identity, () => undefined, fake.credentials),
			).toThrow("effective filesystem identity must be non-root");
			expect(fake.transitions).toEqual([]);
		}
	});
});
