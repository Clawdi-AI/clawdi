import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomic } from "./private-file";

const roots: string[] = [];

function tempRoot(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `clawdi-private-file-${label}-`));
	roots.push(root);
	return root;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("never chmods a pre-existing trusted root when writing a child file", () => {
	const root = tempRoot("root");
	chmodSync(root, 0o700);
	// The parent directory of this file IS the trusted root; dirMode is
	// only for directories the writer creates itself, so the root's mode
	// must survive untouched.
	writePrivateFileAtomic(join(root, "child.json"), "{}", {
		mode: 0o600,
		dirMode: 0o755,
		trustedRoot: root,
	});
	expect(statSync(root).mode & 0o777).toBe(0o700);
	expect(statSync(join(root, "child.json")).mode & 0o777).toBe(0o600);
});

test("applies dirMode to subdirectories it creates inside a trusted root", () => {
	const root = tempRoot("subdir");
	chmodSync(root, 0o700);
	writePrivateFileAtomic(join(root, "private", "child.json"), "{}", {
		mode: 0o600,
		dirMode: 0o700,
		trustedRoot: root,
	});
	expect(statSync(root).mode & 0o777).toBe(0o700);
	expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
	expect(statSync(join(root, "private", "child.json")).mode & 0o777).toBe(0o600);
});

test("never re-chmods a pre-existing subdirectory inside a trusted root", () => {
	const root = tempRoot("existing-subdir");
	chmodSync(root, 0o700);
	const sub = join(root, "sub");
	mkdirSync(sub, { recursive: true });
	// 0711 is deliberately traversable, mirroring the runtime root contract.
	chmodSync(sub, 0o711);
	writePrivateFileAtomic(join(sub, "child.json"), "{}", {
		mode: 0o600,
		dirMode: 0o700,
		trustedRoot: root,
	});
	expect(statSync(root).mode & 0o777).toBe(0o700);
	expect(statSync(sub).mode & 0o777).toBe(0o711);
});

test("never re-chmods a pre-existing user directory without a trusted root", () => {
	const root = tempRoot("user-dir");
	chmodSync(root, 0o700);
	writePrivateFileAtomic(join(root, "first.json"), "{}", { mode: 0o600, dirMode: 0o700 });
	writePrivateFileAtomic(join(root, "second.json"), "{}", { mode: 0o600, dirMode: 0o700 });
	expect(statSync(root).mode & 0o777).toBe(0o700);
	expect(readFileSync(join(root, "first.json"), "utf-8")).toBe("{}");
	// The directory is no longer the CLI's to re-assert once it pre-exists.
	chmodSync(root, 0o711);
	writePrivateFileAtomic(join(root, "third.json"), "{}", { mode: 0o600, dirMode: 0o700 });
	expect(statSync(root).mode & 0o777).toBe(0o711);
	expect(lstatSync(join(root, "third.json")).isFile()).toBe(true);
});
