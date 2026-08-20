import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { managedRuntimeSystemdUnitEntries, RUNTIME_SYSTEMD_DROP_IN_FILE } from "./systemd";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeFixture(root: string, path: string, contents: string): void {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
}

describe("managed runtime systemd unit classification", () => {
	test("classifies only prefixed, generated, and exact generated drop-in units", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-systemd-classification-"));
		roots.push(root);
		const generated = `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n`;
		const dropIn = RUNTIME_SYSTEMD_DROP_IN_FILE;
		writeFixture(root, "clawdi-prefix.service", "foreign");
		writeFixture(root, "generated.service", generated);
		writeFixture(root, "foreign.service", "foreign");
		writeFixture(root, join("official.service.d", dropIn), generated);
		writeFixture(root, join("official.service.d", "20-foreign.conf"), generated);
		writeFixture(root, join("foreign.service.d", dropIn), "foreign");

		const classified = managedRuntimeSystemdUnitEntries(root)
			.map(({ kind, unitName }) => [kind, unitName])
			.sort((left, right) => left[1].localeCompare(right[1]));
		expect(classified).toEqual([
			["base-unit", "clawdi-prefix.service"],
			["base-unit", "generated.service"],
			["hosted-drop-in", "official.service"],
		]);
	});

	test("returns no units for a missing root", () => {
		const root = join(tmpdir(), `clawdi-systemd-missing-${crypto.randomUUID()}`);
		expect(managedRuntimeSystemdUnitEntries(root)).toEqual([]);
	});
});
