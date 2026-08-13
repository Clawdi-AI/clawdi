import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const requireFromBaileys = createRequire(createRequire(import.meta.url).resolve("baileys"));

describe("libsignal dependency patch", () => {
	it("keeps session key material out of lifecycle logs", () => {
		const source = readFileSync(
			requireFromBaileys.resolve("libsignal/src/session_record.js"),
			"utf8",
		);

		const lifecycleLogs = source
			.split("\n")
			.map((line) => line.trim())
			.filter((line) =>
				[
					"Session already closed",
					"Closing session:",
					"Opening session:",
					"Removing old closed session:",
				].some((message) => line.includes(message)),
			);

		expect(lifecycleLogs).toEqual([
			'console.warn("Session already closed");',
			'console.info("Closing session:");',
			'console.info("Opening session:");',
			'console.info("Removing old closed session:");',
		]);
	});
});
