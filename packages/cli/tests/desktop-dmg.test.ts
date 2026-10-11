import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const cache = resolve(root, "node_modules/.cache");

function packageDmg(failure: "none" | "busy-once" | "busy-always" | "other") {
	mkdirSync(cache, { recursive: true });
	const directory = mkdtempSync(resolve(cache, "desktop-dmg-test-"));
	const image = (path: string, device: string) =>
		`<dict><key>image-path</key><string>${path}</string><key>system-entities</key><array><dict><key>dev-entry</key><string>${device}</string></dict></array></dict>`;
	const plist = (images: string[]) =>
		`<?xml version="1.0"?><plist version="1.0"><dict><key>images</key><array>${images.join("")}</array></dict></plist>`;
	try {
		const bin = resolve(directory, "bin");
		mkdirSync(bin);
		const original = image(`${directory}/original.dmg`, "/dev/disk1");
		writeFileSync(resolve(directory, "before.plist"), plist([original]));
		writeFileSync(
			resolve(directory, "after.plist"),
			plist([
				original,
				image(`${directory}/builder.dmg`, "/dev/disk2"),
				image("/unrelated/mounted.dmg", "/dev/disk3"),
			]),
		);
		writeFileSync(resolve(directory, "attempts"), "");
		writeFileSync(resolve(directory, "detaches"), "");
		writeFileSync(
			resolve(bin, "node"),
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/attempts"
case "$FAILURE" in
  none) exit 0 ;;
  busy-once) if [[ $(wc -l < "$FIXTURE_ROOT/attempts") -gt 1 ]]; then exit 0; fi ;;
  other) echo 'Signing failed' >&2; exit 7 ;;
esac
echo 'hdiutil: could not eject "disk2" - Resource busy' >&2
exit 9
`,
			{ mode: 0o755 },
		);
		writeFileSync(
			resolve(bin, "hdiutil"),
			`#!/usr/bin/env bash
if [[ "$1" == detach ]]; then
  printf '%s\\n' "$*" >> "$FIXTURE_ROOT/detaches"
elif [[ -s "$FIXTURE_ROOT/attempts" ]]; then
  cat "$FIXTURE_ROOT/after.plist"
else
  cat "$FIXTURE_ROOT/before.plist"
fi
`,
			{ mode: 0o755 },
		);
		const result = spawnSync("bash", [resolve(root, "scripts/build-desktop-dmg.sh"), "arm64"], {
			// package-preview.ts invokes the helper from the Desktop workspace.
			cwd: resolve(root, "apps/desktop"),
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				TMPDIR: directory,
				FIXTURE_ROOT: directory,
				FAILURE: failure,
			},
		});
		return {
			status: result.status,
			attempts: readFileSync(resolve(directory, "attempts"), "utf8").trim().split("\n"),
			detaches: readFileSync(resolve(directory, "detaches"), "utf8"),
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("DMG packaging recovery", () => {
	test("packages only the DMG from the built app and does not retry success", () => {
		const result = packageDmg("none");
		expect(result.status).toBe(0);
		expect(result.attempts).toHaveLength(1);
		expect(result.attempts[0]).toContain(
			`--config.afterPack=${root}/apps/desktop/scripts/after-pack.mjs`,
		);
		expect(result.attempts[0]).toContain("--prepackaged");
		expect(result.attempts[0]).toContain("release/mac-arm64/Clawdi.app --mac dmg --arm64");
		expect(result.detaches).toBe("");
	});

	test("detaches only newly mounted temporary DMGs and recovers on one retry", () => {
		const result = packageDmg("busy-once");
		expect(result.status).toBe(0);
		expect(result.attempts).toHaveLength(2);
		expect(result.detaches).toBe("detach -force /dev/disk2\n");
	});

	test("fails after the second busy failure, without a third attempt", () => {
		const result = packageDmg("busy-always");
		expect(result.status).toBe(9);
		expect(result.attempts).toHaveLength(2);
	});

	test("preserves unrelated packaging failures without retrying or detaching", () => {
		const result = packageDmg("other");
		expect(result.status).toBe(7);
		expect(result.attempts).toHaveLength(1);
		expect(result.detaches).toBe("");
	});
});
