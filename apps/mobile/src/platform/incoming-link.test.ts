import { expect, test } from "bun:test";
import {
	createVaultLinkInbox,
	isDevelopmentClientLaunchUrl,
	mobileLinkDestination,
	type NotificationActionTarget,
	notificationActionTarget,
} from "@/platform/incoming-link";

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

test("notification actions route dashboard URLs in-app and open allowlisted pages in the browser", () => {
	const stage = () => id;
	const hosts = ["links.example.test"];
	const route = (href: string): NotificationActionTarget => ({ kind: "route", href });
	expect(
		notificationActionTarget("https://cloud.clawdi.ai/?settings=billing-wallet", hosts, stage),
	).toEqual(route("/settings/wallet"));
	expect(
		notificationActionTarget(`https://cloud.clawdi.ai/agents/${id}#files`, hosts, stage),
	).toEqual(route(`/agents/${id}`));
	expect(notificationActionTarget("/sessions?agent=a", hosts, stage)).toEqual(
		route("/sessions?agent=a"),
	);
	expect(notificationActionTarget(`https://links.example.test/agents/${id}`, hosts, stage)).toEqual(
		route(`/agents/${id}`),
	);
	// Web-only dashboard pages and other Clawdi pages keep Web's full navigation.
	expect(notificationActionTarget("https://cloud.clawdi.ai/admin/x/y", hosts, stage)).toEqual({
		kind: "browser",
		url: "https://cloud.clawdi.ai/admin/x/y",
	});
	expect(notificationActionTarget("https://www.clawdi.ai/changelog", hosts, stage)).toEqual({
		kind: "browser",
		url: "https://www.clawdi.ai/changelog",
	});
	for (const value of [
		"https://example.com/agents",
		"http://cloud.clawdi.ai/agents",
		"https://links.example.test:444/agents",
		"https://user@links.example.test/agents",
		"https://clawdi.ai.evil.test/",
		"javascript:alert(1)",
	]) {
		expect(notificationActionTarget(value, hosts, stage)).toBeNull();
	}
});

test("only dev-launcher URLs bypass the incoming-link table", () => {
	const metro =
		"?url=http%3A%2F%2F127.0.0.1%3A8096&disableOnboarding=1&disableAutoLaunch=1&disableFab=1";
	expect(isDevelopmentClientLaunchUrl(`exp+clawdi://expo-development-client/${metro}`)).toBe(true);
	expect(isDevelopmentClientLaunchUrl(`clawdi://expo-development-client/${metro}`)).toBe(true);
	for (const value of [
		"clawdi://projects/join",
		"clawdi:///expo-development-client",
		"https://links.example.test/expo-development-client",
		"exp+clawdi://other-host/?url=http%3A%2F%2F127.0.0.1%3A8096",
		"/expo-development-client",
		"not a url",
	]) {
		expect(isDevelopmentClientLaunchUrl(value)).toBe(false);
	}
});
