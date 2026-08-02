import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	MANAGED_BAILEYS_PATCH_REVISION,
	MANAGED_BAILEYS_STATIC_PATCH_TARGETS,
	type ManagedBaileysRuntime,
	managedBaileysCompatMutationTargets,
	managedBaileysCompatReceiptPath,
	reconcileManagedBaileysCompatibility,
} from "./managed-baileys-compat";

const repositoryRoot = join(import.meta.dir, "../../../..");
const fixtureRoot = join(import.meta.dir, "../../test-fixtures/managed-baileys");
const pristineBaileysRoot = join(
	repositoryRoot,
	"packages/whatsapp-baileys-sidecar/node_modules/baileys",
);
const temporaryRoots: string[] = [];

interface ArtifactFixture {
	runtime: ManagedBaileysRuntime;
	root: string;
	home: string;
	appRoot: string;
	artifactRoot: string;
	consumerPath: string;
	baileysRoot: string;
	installInventory: string;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each(["openclaw", "hermes"] as const)("managed Baileys %s compatibility", (runtime) => {
	it("is inert before a managed Link has produced a receipt", () => {
		const fixture = createArtifactFixture(runtime);

		const result = reconcileManagedBaileysCompatibility({
			desiredRuntime: null,
			home: fixture.home,
			paths: fixture,
		});

		expect(result.status).toBe("inert");
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
		for (const target of artifactTargets(fixture)) {
			expect(sha256File(target.path)).toBe(target.preimageSha256);
		}
	});

	it("applies only the audited preimages and records exact durable authority", () => {
		const fixture = createArtifactFixture(runtime);
		const result = reconcile(fixture, new Date("2026-08-02T01:02:03.000Z"));

		expect(result.status).toBe("applied");
		for (const target of artifactTargets(fixture)) {
			expect(sha256File(target.path)).toBe(target.postimageSha256);
		}
		const receiptPath = managedBaileysCompatReceiptPath(fixture);
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
		expect(receipt).toMatchObject({
			schemaVersion: "clawdi.managedBaileysPatchReceipt.v1",
			patchRevision: MANAGED_BAILEYS_PATCH_REVISION,
			appliedAt: "2026-08-02T01:02:03.000Z",
			artifacts: [
				{
					runtime,
					artifactRoot: fixture.artifactRoot,
					targets: artifactTargets(fixture).map((target) => ({
						path: target.path,
						preimageSha256: target.preimageSha256,
						postimageSha256: target.postimageSha256,
					})),
				},
			],
		});
	});

	it("is a true no-op after the receipt and postimages converge", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture, new Date("2026-08-02T01:02:03.000Z"));
		const receiptPath = managedBaileysCompatReceiptPath(fixture);
		const beforeReceipt = readFileSync(receiptPath, "utf8");
		const beforeTargets = artifactTargets(fixture).map((target) => readFileSync(target.path));

		const result = reconcile(fixture, new Date("2099-01-01T00:00:00.000Z"));

		expect(result.status).toBe("already-patched");
		expect(readFileSync(receiptPath, "utf8")).toBe(beforeReceipt);
		artifactTargets(fixture).forEach((target, index) => {
			expect(readFileSync(target.path)).toEqual(beforeTargets[index]);
		});
	});

	it("recovers a pristine or mixed installer replacement and a missing receipt", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		restorePristineTarget(fixture, targets[0]);
		restorePristineTarget(fixture, targets.at(-1));

		expect(reconcile(fixture).status).toBe("applied");
		for (const target of targets) expect(sha256File(target.path)).toBe(target.postimageSha256);

		rmSync(managedBaileysCompatReceiptPath(fixture));
		expect(reconcile(fixture).status).toBe("receipt-recovered");
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(true);
	});

	it("rolls exact postimages back and refuses all mutation when one target drifted", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		writeFileSync(targets[0].path, `${readFileSync(targets[0].path, "utf8")}\n// drift\n`);
		const unchangedPostimage = readFileSync(targets[1].path);

		const refused = reconcileManagedBaileysCompatibility({
			desiredRuntime: null,
			home: fixture.home,
			paths: fixture,
		});

		expect(refused.status).toBe("rollback-refused");
		expect(readFileSync(targets[1].path)).toEqual(unchangedPostimage);
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(true);

		restorePristineTarget(fixture, targets[0]);
		reconcile(fixture);
		const rolledBack = reconcileManagedBaileysCompatibility({
			desiredRuntime: null,
			home: fixture.home,
			paths: fixture,
		});
		expect(rolledBack.status).toBe("rolled-back");
		for (const target of targets) expect(sha256File(target.path)).toBe(target.preimageSha256);
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
	});
});

it("refuses unknown versions and source drift before writing any receipt", () => {
	const versionFixture = createArtifactFixture("openclaw");
	writeJson(join(versionFixture.artifactRoot, "package.json"), {
		name: "@openclaw/whatsapp",
		version: "2026.7.2",
	});
	expect(() => reconcile(versionFixture)).toThrow("requires @openclaw/whatsapp@2026.7.1");
	expect(existsSync(managedBaileysCompatReceiptPath(versionFixture))).toBe(false);

	const baileysVersionFixture = createArtifactFixture("openclaw");
	writeJson(join(baileysVersionFixture.baileysRoot, "package.json"), {
		name: "baileys",
		version: "7.0.0-rc14",
	});
	expect(() => reconcile(baileysVersionFixture)).toThrow("requires baileys@7.0.0-rc13");
	expect(existsSync(managedBaileysCompatReceiptPath(baileysVersionFixture))).toBe(false);

	const hermesVersionFixture = createArtifactFixture("hermes");
	writeFileSync(
		join(hermesVersionFixture.appRoot, "pyproject.toml"),
		'[project]\nname = "hermes-agent"\nversion = "0.19.2"\n',
	);
	expect(() => reconcile(hermesVersionFixture)).toThrow("requires hermes-agent@0.19.1");
	expect(existsSync(managedBaileysCompatReceiptPath(hermesVersionFixture))).toBe(false);

	const driftFixture = createArtifactFixture("hermes");
	writeFileSync(driftFixture.consumerPath, `${readFileSync(driftFixture.consumerPath, "utf8")}\n`);
	expect(() => reconcile(driftFixture)).toThrow("refused drifted hermes artifacts");
	expect(existsSync(managedBaileysCompatReceiptPath(driftFixture))).toBe(false);
	for (const target of artifactTargets(driftFixture).slice(1)) {
		expect(sha256File(target.path)).toBe(target.preimageSha256);
	}
});

it("refuses symlinked package identity before reading or patching it", () => {
	const fixture = createArtifactFixture("openclaw");
	const packageJson = join(fixture.artifactRoot, "package.json");
	const redirected = join(fixture.root, "redirected-package.json");
	copyFileSync(packageJson, redirected);
	rmSync(packageJson);
	symlinkSync(redirected, packageJson);

	expect(() => reconcile(fixture)).toThrow("package identity must be a real file");
	expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
	for (const target of artifactTargets(fixture)) {
		expect(sha256File(target.path)).toBe(target.preimageSha256);
	}
});

it("snapshots the whole Hermes dependency tree whenever npm ci may replace it", () => {
	const fixture = createArtifactFixture("hermes");
	const nodeModules = join(fixture.artifactRoot, "node_modules");
	const exactTargets = managedBaileysCompatMutationTargets(fixture);

	expect(exactTargets).toContain(join(nodeModules, ".hermes-pkg-hash"));
	expect(exactTargets).not.toContain(nodeModules);

	rmSync(join(fixture.baileysRoot, "package.json"));
	expect(managedBaileysCompatMutationTargets(fixture)).toEqual([fixture.consumerPath, nodeModules]);
});

it("keeps upgrade headers out of fetch/media HTTP and preserves official Noise trust by default", () => {
	const fixture = createArtifactFixture("openclaw");
	reconcile(fixture);
	const websocket = readFileSync(
		join(fixture.baileysRoot, "lib/Socket/Client/websocket.js"),
		"utf8",
	);
	const socket = readFileSync(join(fixture.baileysRoot, "lib/Socket/socket.js"), "utf8");
	const noise = readFileSync(join(fixture.baileysRoot, "lib/Utils/noise-handler.js"), "utf8");
	const targetSources = artifactTargets(fixture).map((target) => ({
		path: target.path,
		source: readFileSync(target.path, "utf8"),
	}));

	expect(websocket).toContain("...this.config.webSocketHeaders");
	expect(websocket).toContain("new WebSocket(this.url");
	expect(socket).not.toContain("webSocketHeaders");
	expect(
		targetSources
			.filter(
				({ path, source }) =>
					path.startsWith(`${fixture.baileysRoot}/`) && source.includes("webSocketHeaders"),
			)
			.map(({ path }) => relative(fixture.baileysRoot, path)),
	).toEqual(["lib/Types/Socket.d.ts", "lib/Socket/Client/websocket.js"]);
	expect(noise).toContain("const trustedCert = authCert ?? WA_CERT_DETAILS;");
	expect(noise).toContain("Curve.verify(trustedCert.PUBLIC_KEY");
	expect(noise).toContain("issuerSerial !== trustedCert.SERIAL");
});

it("passes managed options through every stock initial/reconnect constructor without routing URLs", () => {
	const openclaw = createArtifactFixture("openclaw");
	const hermes = createArtifactFixture("hermes");
	reconcile(openclaw);
	reconcile(hermes);
	const openclawSource = readFileSync(openclaw.consumerPath, "utf8");
	const hermesSource = readFileSync(hermes.consumerPath, "utf8");

	expect(openclawSource.match(/managedSocketOptions\(authDir\)/g)).toHaveLength(2);
	expect(openclawSource).toContain('if (error?.code === "ENOENT") return null;');
	expect(openclawSource).toContain("const waWebSocketUrl = managedOptions ? void 0");
	expect(openclawSource).toContain("...managedOptions ?? {}");
	expect(openclawSource).not.toContain("/v1/channels/whatsapp/baileys");
	expect(openclawSource).not.toContain("CLAWDI_WA_WEBSOCKET_URL");
	expect(hermesSource.match(/managedSocketOptions\(\)/g)).toHaveLength(2);
	expect(hermesSource).toContain("if (error?.code === 'ENOENT') return {};");
	expect(hermesSource).toContain("setTimeout(startSocket, reason === 515 ? 1000 : 3000)");
	expect(hermesSource.indexOf("...managedSocketOptions()")).toBeGreaterThan(
		hermesSource.indexOf("async function startSocket()"),
	);
	expect(hermesSource.indexOf("...managedSocketOptions()")).toBeLessThan(
		hermesSource.indexOf("setTimeout(startSocket"),
	);
	expect(hermesSource).not.toContain("waWebSocketUrl");
	expect(hermesSource).not.toContain("/v1/channels/whatsapp/baileys");
});

function reconcile(fixture: ArtifactFixture, now = new Date("2026-08-02T00:00:00.000Z")) {
	return reconcileManagedBaileysCompatibility({
		desiredRuntime: fixture.runtime,
		home: fixture.home,
		appRoot: fixture.appRoot,
		paths: fixture,
		now: () => now,
	});
}

function createArtifactFixture(runtime: ManagedBaileysRuntime): ArtifactFixture {
	const root = mkdtempSync(join(tmpdir(), `clawdi-managed-baileys-${runtime}-`));
	temporaryRoots.push(root);
	const home = join(root, "home");
	const installInventory = join(root, "state", "install-inventory");
	const appRoot =
		runtime === "openclaw" ? join(home, ".openclaw") : join(home, ".hermes", "hermes-agent");
	const artifactRoot =
		runtime === "openclaw"
			? join(home, ".openclaw", "extensions", "whatsapp")
			: join(appRoot, "scripts", "whatsapp-bridge");
	const consumerPath = join(
		artifactRoot,
		runtime === "openclaw"
			? MANAGED_BAILEYS_STATIC_PATCH_TARGETS.openclaw.relativePath
			: "bridge.js",
	);
	const baileysRoot = join(
		artifactRoot,
		...(runtime === "openclaw"
			? ["node_modules", "baileys"]
			: ["node_modules", "@whiskeysockets", "baileys"]),
	);
	mkdirSync(dirname(consumerPath), { recursive: true });
	if (runtime === "openclaw") {
		copyFileSync(join(fixtureRoot, "openclaw-session-2026.7.1.fixture"), consumerPath);
		writeJson(join(artifactRoot, "package.json"), {
			name: "@openclaw/whatsapp",
			version: "2026.7.1",
		});
	} else {
		const compressed = Buffer.from(
			readFileSync(join(fixtureRoot, "hermes-bridge-0.19.1.js.gz.b64"), "utf8"),
			"base64",
		);
		writeFileSync(consumerPath, gunzipSync(compressed));
		writeFileSync(
			join(appRoot, "pyproject.toml"),
			'[project]\nname = "hermes-agent"\nversion = "0.19.1"\n',
		);
		writeJson(join(artifactRoot, "package.json"), {
			name: "hermes-whatsapp-bridge",
			version: "1.0.0",
		});
	}
	for (const target of MANAGED_BAILEYS_STATIC_PATCH_TARGETS.baileys) {
		const destination = join(baileysRoot, target.relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(pristineBaileysRoot, target.relativePath), destination);
	}
	writeJson(join(baileysRoot, "package.json"), {
		name: runtime === "openclaw" ? "baileys" : "@whiskeysockets/baileys",
		version: "7.0.0-rc13",
	});
	return {
		runtime,
		root,
		home,
		appRoot,
		artifactRoot,
		consumerPath,
		baileysRoot,
		installInventory,
	};
}

function artifactTargets(fixture: ArtifactFixture) {
	const consumer =
		fixture.runtime === "openclaw"
			? MANAGED_BAILEYS_STATIC_PATCH_TARGETS.openclaw
			: MANAGED_BAILEYS_STATIC_PATCH_TARGETS.hermes;
	return [
		{ ...consumer, path: fixture.consumerPath },
		...MANAGED_BAILEYS_STATIC_PATCH_TARGETS.baileys.map((target) => ({
			...target,
			path: join(fixture.baileysRoot, target.relativePath),
		})),
	];
}

function restorePristineTarget(
	fixture: ArtifactFixture,
	target: ReturnType<typeof artifactTargets>[number] | undefined,
): void {
	if (!target) throw new Error("missing fixture target");
	if (target.path === fixture.consumerPath) {
		if (fixture.runtime === "openclaw") {
			copyFileSync(join(fixtureRoot, "openclaw-session-2026.7.1.fixture"), target.path);
		} else {
			const compressed = Buffer.from(
				readFileSync(join(fixtureRoot, "hermes-bridge-0.19.1.js.gz.b64"), "utf8"),
				"base64",
			);
			writeFileSync(target.path, gunzipSync(compressed));
		}
		return;
	}
	copyFileSync(join(pristineBaileysRoot, relative(fixture.baileysRoot, target.path)), target.path);
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
