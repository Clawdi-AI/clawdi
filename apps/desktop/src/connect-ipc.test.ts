import { expect, test } from "bun:test";
import {
	assertConnectSender,
	readExcludedProjectRemoval,
	verificationPageToOpen,
} from "./connect-ipc";

const CONNECT_URL = "clawdi-app://connect/renderer.html";

function sender(url = CONNECT_URL) {
	return { mainFrame: { url } };
}

test("accepts IPC only from the Connect window main frame at its exact URL", () => {
	const connect = sender();
	expect(() =>
		assertConnectSender({ sender: connect, senderFrame: connect.mainFrame }, connect, CONNECT_URL),
	).not.toThrow();

	const other = sender();
	expect(() =>
		assertConnectSender({ sender: other, senderFrame: other.mainFrame }, connect, CONNECT_URL),
	).toThrow("Unexpected Connect client.");
	expect(() =>
		assertConnectSender({ sender: connect, senderFrame: connect.mainFrame }, null, CONNECT_URL),
	).toThrow("Unexpected Connect client.");

	const subframe = { url: CONNECT_URL };
	expect(() =>
		assertConnectSender({ sender: connect, senderFrame: subframe }, connect, CONNECT_URL),
	).toThrow("Unexpected Connect frame.");
	expect(() =>
		assertConnectSender({ sender: connect, senderFrame: null }, connect, CONNECT_URL),
	).toThrow("Unexpected Connect frame.");

	const navigated = sender("https://attacker.test/");
	expect(() =>
		assertConnectSender(
			{ sender: navigated, senderFrame: navigated.mainFrame },
			navigated,
			CONNECT_URL,
		),
	).toThrow("Unexpected Connect URL.");
});

test("the renderer can only remove a currently excluded project", () => {
	const current = ["/work/client", "/work/scratch"];
	expect(readExcludedProjectRemoval("/work/client", current)).toBe("/work/client");
	for (const value of ["/work/other", "", 42, null, ["/work/client"], { path: "/work/client" }]) {
		expect(() => readExcludedProjectRemoval(value, current)).toThrow(
			"Choose an excluded project to remove.",
		);
	}
});

test("reopens only an HTTPS verification page without credentials or fragments", () => {
	const page = "https://accounts.example.test/device?user_code=ABCD-EFGH";
	expect(verificationPageToOpen(page)).toBe(page);
	for (const uri of [
		null,
		"",
		"not a url",
		"http://accounts.example.test/device",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"https://user:secret@accounts.example.test/device",
		"https://accounts.example.test/device#token",
	]) {
		expect(verificationPageToOpen(uri)).toBeNull();
	}
});
