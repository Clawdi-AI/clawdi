import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateFileEvidence, writePrivateFileAtomic } from "./private-file";

const policy = {
	uid: process.geteuid?.() ?? -1,
	gid: process.getegid?.() ?? -1,
	modes: [0o600],
	maxBytes: 1024,
};

test.each(["same-bytes-file", "same-bytes-parent"])(
	"CAS rejects replaced evidence: %s",
	(replacement) => {
		const root = mkdtempSync(join(tmpdir(), "private-evidence-"));
		const parent = join(root, "native");
		mkdirSync(parent);
		const target = join(parent, ".env");
		const journal = join(root, "journal");
		writeFileSync(target, "TOKEN=preserve\n", { mode: 0o600 });
		writeFileSync(journal, "old journal", { mode: 0o600 });
		const evidence = readPrivateFileEvidence(target, policy);
		const rootEvidence = readPrivateFileEvidence(journal, policy);
		try {
			if (replacement === "same-bytes-file") renameSync(target, `${target}.old`);
			else {
				renameSync(parent, `${parent}.old`);
				mkdirSync(parent);
			}
			writeFileSync(target, "TOKEN=preserve\n", { mode: 0o600 });
			expect(() =>
				writePrivateFileAtomic(journal, "new journal", {
					directoryFd: rootEvidence.directoryFd,
					beforeRename: () => {
						rootEvidence.assertCurrent();
						evidence.assertCurrent();
					},
				}),
			).toThrow();
			expect(readFileSync(journal, "utf8")).toBe("old journal");
			expect(readFileSync(target, "utf8")).toBe("TOKEN=preserve\n");
		} finally {
			evidence.close();
			rootEvidence.close();
			rmSync(root, { recursive: true });
		}
	},
);

test("safe reads reject symbolic parents, wrong owners and permissive secret modes", () => {
	const root = mkdtempSync(join(tmpdir(), "private-evidence-"));
	try {
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "link"));
		const file = join(root, "real", ".env");
		writeFileSync(file, "TOKEN=preserve", { mode: 0o600 });
		expect(() => readPrivateFileEvidence(join(root, "link", ".env"), policy)).toThrow();
		expect(() => readPrivateFileEvidence(file, { ...policy, uid: policy.uid + 1 })).toThrow();
		for (const mode of [0o644, 0o660, 0o666]) {
			chmodSync(file, mode);
			expect(() => readPrivateFileEvidence(file, policy)).toThrow();
		}
		expect(readFileSync(file, "utf8")).toBe("TOKEN=preserve");
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("FIFO evidence fails without blocking the reader", () => {
	const root = mkdtempSync(join(tmpdir(), "private-evidence-"));
	try {
		const fifo = join(root, "fifo");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		const script = `import { readPrivateFileEvidence } from ${JSON.stringify(join(import.meta.dir, "private-file.ts"))}; try { readPrivateFileEvidence(${JSON.stringify(fifo)}, ${JSON.stringify(policy)}); process.exit(1); } catch { process.exit(0); }`;
		const result = spawnSync(process.execPath, ["-e", script], { timeout: 5000 });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
	} finally {
		rmSync(root, { recursive: true });
	}
});
