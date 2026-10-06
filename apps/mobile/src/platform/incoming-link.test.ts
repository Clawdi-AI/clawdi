import { expect, test } from "bun:test";
import { createVaultLinkInbox, mobileLinkDestination } from "@/platform/incoming-link";

const id = "a1234567-1234-1234-1234-123456789abc";
const other = "b1234567-1234-1234-1234-123456789abc";
const token = `v2_${"a".repeat(43)}`;
const link = `https://links.example.test/vault-request#${token}`;

test("verified-host links use existing Session and Vault contracts without routing capability values", () => {
	const staged: string[] = [];
	const stage = (value: string) => {
		staged.push(value);
		return id;
	};
	const hosts = ["links.example.test"];
	expect(mobileLinkDestination(`https://links.example.test/s/${id}`, hosts, stage)).toBe(
		`/s/${id}`,
	);
	expect(mobileLinkDestination(`clawdi://s/${id}`, [], stage)).toBe(`/s/${id}`);
	expect(mobileLinkDestination(link, hosts, stage)).toBe(`/vault-request?intake=${id}`);
	expect(staged).toEqual([link]);
	for (const value of [
		link.replace("links.example.test", "evil.test"),
		link.replace("https:", "http:"),
		link.replace("links.example.test", "user@links.example.test"),
		link.replace("links.example.test", "links.example.test:444"),
		link.replace(`#${token}`, `?token=${token}`),
	]) {
		expect(mobileLinkDestination(value, hosts, stage)).not.toContain(token);
	}
	expect(staged).toEqual([link]);
	expect(mobileLinkDestination(`/vault-request#${token}`, hosts, stage)).toBe("/vault-request");
	expect(
		mobileLinkDestination(`clawdi://vault-request?token=${token}&intake=${id}`, hosts, stage),
	).toBe(`/vault-request?intake=${id}`);
	expect(
		mobileLinkDestination(
			`clawdi://sign-in-oauth?rotating_token_nonce=secret&publicShareId=${id}`,
			hosts,
			stage,
		),
	).toBe(`/sign-in?publicShareId=${id}`);
	expect(mobileLinkDestination("javascript:alert(1)", hosts, stage)).toBe("/open-share");
});

test("Vault intake is latest-only, expires, and is consumed once; stale cleanup cannot erase a newer link", () => {
	let now = 0;
	const inbox = createVaultLinkInbox(() => now);
	try {
		inbox.stage(id, link);
		inbox.stage(other, link);
		inbox.clear(id);
		expect(inbox.take(id)).toBeNull();
		expect(inbox.take(other)).toBe(link);
		expect(inbox.take(other)).toBeNull();
		inbox.stage(id, link);
		now = 60_000;
		expect(inbox.take(id)).toBeNull();
		inbox.stage(id, link);
		inbox.clear(id);
		expect(inbox.take(id)).toBeNull();
		expect(() => inbox.stage(id, `${link}?extra`)).toThrow();
	} finally {
		inbox.clear();
	}
});
