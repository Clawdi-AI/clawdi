import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	egressSnapshotPaths,
	initializeAnonymousEgressSnapshot,
	publishEgressSnapshot,
	waitForEgressSnapshot,
} from "./egress-snapshot";
import { getRuntimePaths } from "./paths";

const environment = { ...process.env };
const roots: string[] = [];
afterEach(() => {
	process.env = { ...environment };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("warm egress rejects claimed data and requires the exact private live acknowledgement", () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-egress-snapshot-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_EGRESS_UID = String(process.getuid?.());
	const paths = getRuntimePaths({ mode: "hosted" });
	const files = egressSnapshotPaths(paths);
	mkdirSync(dirname(files.ack), { recursive: true });
	mkdirSync(paths.statusRoot, { recursive: true });
	const profiles = { schemaVersion: "clawdi.egressProfiles.v1", profiles: [] } as const;
	publishEgressSnapshot(paths, { ...profiles, profiles: [] }, {}, false);
	const ack = () => `${createHash("sha256").update(readFileSync(files.input)).digest("hex")}\n`;
	writeFileSync(files.ack, ack(), { mode: 0o600 });
	expect(() => waitForEgressSnapshot(paths, 100)).not.toThrow();
	publishEgressSnapshot(paths, { ...profiles, profiles: [] }, { "secret://key": "claimed" }, true);
	expect(() => initializeAnonymousEgressSnapshot(paths)).toThrow("non-anonymous");
	expect(() => waitForEgressSnapshot(paths, 10)).toThrow("did not acknowledge");
	writeFileSync(files.ack, ack(), { mode: 0o600 });
	expect(() => waitForEgressSnapshot(paths, 100)).not.toThrow();
	rmSync(files.ack);
	writeFileSync(files.ack, ack(), { mode: 0o644 });
	expect(() => waitForEgressSnapshot(paths, 10)).toThrow("did not acknowledge");
});
