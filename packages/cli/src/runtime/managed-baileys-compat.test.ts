import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, SourceTextModule } from "node:vm";
import {
	MANAGED_BAILEYS_STATIC_PATCH_TARGETS,
	type ManagedBaileysRuntime,
	managedBaileysCompatMutationTargets,
	managedBaileysCompatSnapshotRuntimes,
	reconcileManagedBaileysCompatibility,
} from "./managed-baileys-compat";
import { runtimeUserMutationTargets } from "./manifest";
import type { RuntimeManifest } from "./manifest-contract";
import { getRuntimePaths } from "./paths";

const repositoryRoot = join(import.meta.dir, "../../../..");
const pristineBaileysRoot = join(
	repositoryRoot,
	"packages/whatsapp-baileys-sidecar/node_modules/baileys",
);
const qualifiedDefaultsModule = await import(
	pathToFileURL(join(pristineBaileysRoot, "lib/Defaults/index.js")).href
);
const qualifiedDefaultConnectionConfig = Reflect.get(
	qualifiedDefaultsModule,
	"DEFAULT_CONNECTION_CONFIG",
);
if (!qualifiedDefaultConnectionConfig || typeof qualifiedDefaultConnectionConfig !== "object") {
	throw new Error("qualified DEFAULT_CONNECTION_CONFIG export is missing");
}
const qualifiedDefaultWebSocketUrl = Reflect.get(
	qualifiedDefaultConnectionConfig,
	"waWebSocketUrl",
);
if (typeof qualifiedDefaultWebSocketUrl !== "string") {
	throw new Error("qualified default WhatsApp WebSocket URL is missing");
}
const temporaryRoots: string[] = [];

interface ArtifactFixture {
	runtime: ManagedBaileysRuntime;
	root: string;
	home: string;
	appRoot: string;
	baileysRoot: string;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("defines exactly the three audited Baileys targets and no consumer target", () => {
	expect(MANAGED_BAILEYS_STATIC_PATCH_TARGETS.map((target) => target.relativePath)).toEqual([
		"lib/Socket/socket.js",
		"lib/Utils/noise-handler.js",
		"lib/Utils/noise-handler.d.ts",
	]);
	const socketPatch = MANAGED_BAILEYS_STATIC_PATCH_TARGETS[0];
	expect(socketPatch?.hunks.map((hunk) => hunk.after).join("\n")).toContain(
		"DEFAULT_CONNECTION_CONFIG.waWebSocketUrl",
	);
	expect(socketPatch?.hunks.map((hunk) => hunk.after).join("\n")).not.toContain(
		"wss://web.whatsapp.com/ws/chat",
	);
	for (const target of MANAGED_BAILEYS_STATIC_PATCH_TARGETS) {
		expect(new Set(target.hunks.map((hunk) => hunk.id)).size).toBe(target.hunks.length);
	}
});

describe.each(["openclaw", "hermes"] as const)("managed Baileys %s compatibility", (runtime) => {
	it("leaves all-before content unchanged when compatibility is not desired", () => {
		const fixture = createArtifactFixture(runtime);

		const result = reconcileManagedBaileysCompatibility({
			desiredRuntime: null,
			home: fixture.home,
		});

		expect(result.status).toBe("inert");
		assertTargetHunkState(fixture, "before");
	});

	it("leaves a native foreign version inert when compatibility is not desired", () => {
		const fixture = createArtifactFixture(runtime);
		const targets = artifactTargets(fixture);
		for (const { target, path } of targets) {
			let content = readFileSync(path, "utf8");
			for (const hunk of target.hunks) {
				content = content.replace(hunk.before, `// upstream replacement for ${hunk.id}\n`);
			}
			writeFileSync(path, content);
		}
		const unchanged = targets.map(({ path }) => readFileSync(path));

		expect(rollback(fixture).status).toBe("inert");
		targets.forEach(({ path }, index) => {
			expect(readFileSync(path)).toEqual(unchanged[index]);
		});
	});

	it("applies, recognizes, and rolls back uniform content states", () => {
		const fixture = createArtifactFixture(runtime);
		expect(reconcile(fixture).status).toBe("applied");
		assertTargetHunkState(fixture, "after");
		const beforeTargets = artifactTargets(fixture).map(({ path }) => readFileSync(path));
		expect(reconcile(fixture).status).toBe("already-patched");
		artifactTargets(fixture).forEach(({ path }, index) => {
			expect(readFileSync(path)).toEqual(beforeTargets[index]);
		});
		writeBaileysIdentity(fixture, "8.0.0");
		expect(rollback(fixture).status).toBe("rolled-back");
		assertTargetHunkState(fixture, "before");
	});

	it("preserves an unrelated external edit outside owned hunks during rollback", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		const edited = targets[0];
		if (!edited) throw new Error("missing external edit target");
		writeFileSync(edited.path, `${readFileSync(edited.path, "utf8")}\n// external-tail\n`);

		expect(rollback(fixture).status).toBe("rolled-back");

		assertTargetHunkState(fixture, "before");
		expect(readFileSync(edited.path, "utf8")).toEndWith("\n// external-tail\n");
	});

	it("refuses a changed after-hunk when other managed after traces remain", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		const drifted = targets[0];
		const hunk = drifted?.target.hunks.find(
			(candidate) => candidate.id === "socket.managed-default-url.v1",
		);
		if (!drifted || !hunk) throw new Error("missing owned rollback hunk fixture");
		writeFileSync(
			drifted.path,
			readFileSync(drifted.path, "utf8").replace(
				hunk.after,
				hunk.after.replace("DEFAULT_CONNECTION_CONFIG", "DRIFTED_CONNECTION_CONFIG"),
			),
		);
		const unchanged = targets.map(({ path }) => readFileSync(path));

		const result = rollback(fixture);

		expect(result.status).toBe("rollback-refused");
		targets.forEach(({ path }, index) => {
			expect(readFileSync(path)).toEqual(unchanged[index]);
		});
	});

	it("refuses rollback when a present package is missing one audited target", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		const missing = targets[0];
		if (!missing) throw new Error("missing rollback target fixture");
		rmSync(missing.path);
		const unchanged = targets.slice(1).map(({ path }) => readFileSync(path));

		const result = rollback(fixture);

		expect(result.status).toBe("rollback-refused");
		if (result.status !== "rollback-refused") throw new Error("expected rollback refusal");
		expect(result.errors.join("\n")).toContain(`artifact is missing ${missing.path}`);
		targets.slice(1).forEach(({ path }, index) => {
			expect(readFileSync(path)).toEqual(unchanged[index]);
		});
	});

	it("is inert after the package root is uninstalled", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		rmSync(fixture.baileysRoot, { recursive: true });

		expect(rollback(fixture).status).toBe("inert");
	});
});

it.each(["openclaw", "hermes"] as const)(
	"patches and rolls back only the selected %s alias",
	(selectedRuntime) => {
		const fixture = createArtifactFixture(selectedRuntime);
		const otherRuntime = selectedRuntime === "openclaw" ? "hermes" : "openclaw";
		const otherRoot = installArtifactAlias(fixture.home, otherRuntime);
		const otherTargets = artifactTargetsAt(otherRoot);
		const otherBefore = otherTargets.map(({ path }) => readFileSync(path));

		expect(reconcile(fixture).status).toBe("applied");
		assertTargetHunkState(fixture, "after");
		otherTargets.forEach(({ target, path }, index) => {
			expect(readFileSync(path)).toEqual(otherBefore[index]);
			for (const hunk of target.hunks) {
				expect(exactMatchCount(readFileSync(path, "utf8"), hunk.before)).toBe(1);
			}
		});

		expect(rollback(fixture).status).toBe("rolled-back");
		assertTargetHunkState(fixture, "before");
		otherTargets.forEach(({ path }, index) => {
			expect(readFileSync(path)).toEqual(otherBefore[index]);
		});
	},
);

it("rolls back the previous runtime before applying a runtime switch", () => {
	const openclaw = createArtifactFixture("openclaw");
	expect(reconcile(openclaw).status).toBe("applied");
	const hermesAppRoot = join(openclaw.home, ".hermes", "hermes-agent");
	const hermes: ArtifactFixture = {
		runtime: "hermes",
		root: openclaw.root,
		home: openclaw.home,
		appRoot: hermesAppRoot,
		baileysRoot: installArtifactAlias(openclaw.home, "hermes"),
	};

	expect(reconcile(hermes).status).toBe("applied");
	assertTargetHunkState(openclaw, "before");
	assertTargetHunkState(hermes, "after");
});

it("derives snapshot targets from desired and installed aliases", () => {
	const fixture = createArtifactFixture("openclaw");
	expect(
		managedBaileysCompatSnapshotRuntimes({
			desiredRuntime: null,
			home: fixture.home,
		}),
	).toEqual([]);
	reconcile(fixture);
	expect(
		managedBaileysCompatSnapshotRuntimes({
			desiredRuntime: null,
			home: fixture.home,
		}),
	).toEqual(["openclaw"]);
	expect(
		managedBaileysCompatSnapshotRuntimes({
			desiredRuntime: "hermes",
			home: fixture.home,
		}),
	).toEqual(["hermes", "openclaw"]);

	const paths = {
		...getRuntimePaths(),
		userHome: fixture.home,
		localEnvironments: join(fixture.root, "environments"),
	};
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		runtime: "hermes",
		deploymentId: "dep-content-snapshot",
		environmentId: "env-content-snapshot",
		instanceId: "iid-content-snapshot",
		generation: 1,
		issuedAt: "2026-08-02T00:00:00Z",
		controlPlane: { apiUrl: "https://cloud-api.test" },
		runtimes: { hermes: { enabled: true, services: {} } },
		projection: { system: { home: fixture.home, workspace: fixture.home } },
		recovery: {},
	};
	const targets = runtimeUserMutationTargets(manifest, paths, fixture.home, new Map());
	for (const { path } of artifactTargets(fixture)) expect(targets).toContain(path);
	expect(
		targets.some((target) =>
			target.startsWith(
				join(
					fixture.home,
					".hermes",
					"hermes-agent",
					"scripts",
					"whatsapp-bridge",
					"node_modules",
					"@whiskeysockets",
					"baileys",
				),
			),
		),
	).toBe(false);
});

it.each([
	["openclaw", "7.1.2"],
	["hermes", "7.0.0-rc14"],
] as const)("accepts %s alias at alternate exact-hunk %s", (runtime, version) => {
	const fixture = createArtifactFixture(runtime, version);

	expect(reconcile(fixture).status).toBe("applied");
	assertTargetHunkState(fixture, "after");
});

it("applies with unrelated prefix, suffix, other-function, line-offset, import, and comment edits", () => {
	const fixture = createArtifactFixture("openclaw", "7.8.1");
	const targets = artifactTargets(fixture);
	const socket = targets[0];
	const noise = targets[1];
	if (!socket || !noise) throw new Error("missing unrelated-change fixtures");
	writeFileSync(
		socket.path,
		`import './unrelated-side-effect.js';\n// unrelated import comment\n${readFileSync(socket.path, "utf8")}\nexport const unrelatedHelper = () => 7;\n`,
	);
	writeFileSync(
		noise.path,
		`// unrelated prefix changes line offsets\n${readFileSync(noise.path, "utf8")}\n// unrelated suffix\n`,
	);

	expect(reconcile(fixture).status).toBe("applied");
	assertTargetHunkState(fixture, "after");
	expect(readFileSync(socket.path, "utf8")).toStartWith(
		"import './unrelated-side-effect.js';\n// unrelated import comment\n",
	);
	expect(readFileSync(socket.path, "utf8")).toEndWith(
		"\nexport const unrelatedHelper = () => 7;\n",
	);
	expect(readFileSync(noise.path, "utf8")).toEndWith("\n// unrelated suffix\n");
});

it("rejects changed target semantics before mutating any target", () => {
	const fixture = createArtifactFixture("openclaw", "7.9.0-beta.1");
	const targets = artifactTargets(fixture);
	const drifted = targets[0];
	if (!drifted) throw new Error("missing drift target");
	const urlHunk = drifted.target.hunks.find((hunk) => hunk.id === "socket.managed-default-url.v1");
	if (!urlHunk) throw new Error("missing URL hunk");
	writeFileSync(
		drifted.path,
		readFileSync(drifted.path, "utf8").replace(
			urlHunk.before,
			"    const url = resolveConsumerSocketUrl(waWebSocketUrl);\n",
		),
	);
	const unchanged = targets.map(({ path }) => readFileSync(path));

	expect(() => reconcile(fixture)).toThrow("refused non-unique or changed openclaw hunks");
	targets.forEach(({ path }, index) => {
		expect(readFileSync(path)).toEqual(unchanged[index]);
	});
});

it.each(["duplicate-before", "both-forms"] as const)(
	"rejects %s ambiguous hunk context with zero mutation",
	(mode) => {
		const fixture = createArtifactFixture("openclaw");
		const targets = artifactTargets(fixture);
		const target = targets[0];
		const hunk = target?.target.hunks[0];
		if (!target || !hunk) throw new Error("missing ambiguous hunk fixture");
		writeFileSync(
			target.path,
			`${mode === "duplicate-before" ? hunk.before : hunk.after}${readFileSync(target.path, "utf8")}`,
		);
		const unchanged = targets.map(({ path }) => readFileSync(path));

		expect(() => reconcile(fixture)).toThrow("refused non-unique or changed openclaw hunks");
		targets.forEach(({ path }, index) => {
			expect(readFileSync(path)).toEqual(unchanged[index]);
		});
	},
);

it("rejects recognized mixed before/after hunks", () => {
	const fixture = createArtifactFixture("openclaw");
	const target = artifactTargets(fixture)[0];
	setHunkState(target, target?.target.hunks[0]?.id, "after");
	const unchanged = artifactTargets(fixture).map(({ path }) => readFileSync(path));

	expect(() => reconcile(fixture)).toThrow("refused mixed openclaw hunks");
	artifactTargets(fixture).forEach(({ path }, index) => {
		expect(readFileSync(path)).toEqual(unchanged[index]);
	});
});

it.each(["8.0.0", "6.9.9"])("rejects incompatible Baileys major %s", (version) => {
	const fixture = createArtifactFixture("openclaw", version);
	expect(() => reconcile(fixture)).toThrow("requires valid Baileys SemVer major 7");
	assertTargetHunkState(fixture, "before");
});

it.each(["7.*", "7.0", "07.0.0", "7.0.0-rc.01", "v7.0.0", "not-semver"])(
	"rejects malformed Baileys version %s",
	(version) => {
		const fixture = createArtifactFixture("hermes", version);
		expect(() => reconcile(fixture)).toThrow("requires valid Baileys SemVer major 7");
		assertTargetHunkState(fixture, "before");
	},
);

it("reapplies after a compatible 7.x installer replacement", () => {
	const fixture = createArtifactFixture("openclaw");
	reconcile(fixture);
	for (const target of artifactTargets(fixture)) restorePristineTarget(target);
	const socket = artifactTargets(fixture)[0];
	if (!socket) throw new Error("missing installer replacement fixture");
	writeFileSync(socket.path, `${readFileSync(socket.path, "utf8")}\n// installer-7.4-tail\n`);
	writeBaileysIdentity(fixture, "7.4.1-rc.2");

	expect(reconcile(fixture).status).toBe("applied");
	expect(rollback(fixture).status).toBe("rolled-back");
	assertTargetHunkState(fixture, "before");
	expect(readFileSync(socket.path, "utf8")).toEndWith("\n// installer-7.4-tail\n");
});

it("rejects the wrong alias package name and symlinked package identity", () => {
	const wrongName = createArtifactFixture("openclaw");
	writeJson(join(wrongName.baileysRoot, "package.json"), {
		name: "@whiskeysockets/baileys",
		version: "7.0.0-rc13",
	});
	expect(() => reconcile(wrongName)).toThrow("requires package baileys");
	assertTargetHunkState(wrongName, "before");

	const symlinked = createArtifactFixture("hermes");
	const packagePath = join(symlinked.baileysRoot, "package.json");
	const redirected = join(symlinked.root, "redirected-package.json");
	copyFileSync(packagePath, redirected);
	rmSync(packagePath);
	symlinkSync(redirected, packagePath);
	expect(() => reconcile(symlinked)).toThrow("target must be a real file");
	assertTargetHunkState(symlinked, "before");
});

it("refuses a symlinked patch target before mutating any audited file", () => {
	const fixture = createArtifactFixture("openclaw");
	const targets = artifactTargets(fixture);
	const target = targets[0];
	if (!target) throw new Error("missing symlink target fixture");
	const redirected = join(fixture.root, "redirected-target.js");
	copyFileSync(target.path, redirected);
	rmSync(target.path);
	symlinkSync(redirected, target.path);
	const unchanged = targets.slice(1).map(({ path }) => readFileSync(path));

	expect(() => reconcile(fixture)).toThrow("target must be a real file");
	targets.slice(1).forEach(({ path }, index) => {
		expect(readFileSync(path)).toEqual(unchanged[index]);
	});
});

it("snapshots the Hermes dependency tree only when isolated npm ci may replace it", () => {
	const fixture = createArtifactFixture("hermes");
	const bridgeRoot = join(fixture.appRoot, "scripts", "whatsapp-bridge");
	const nodeModules = join(bridgeRoot, "node_modules");
	const exactTargets = managedBaileysCompatMutationTargets(fixture);

	expect(exactTargets).toContain(join(nodeModules, ".hermes-pkg-hash"));
	expect(exactTargets).not.toContain(nodeModules);
	rmSync(join(fixture.baileysRoot, "package.json"));
	expect(managedBaileysCompatMutationTargets(fixture)).toEqual([nodeModules]);
});

it("uses an explicitly mocked local npm for missing pristine Hermes dependencies", () => {
	const fixture = createArtifactFixture("hermes");
	const bridgeRoot = join(fixture.appRoot, "scripts", "whatsapp-bridge");
	const nodeModules = join(bridgeRoot, "node_modules");
	const managedNpm = join(fixture.home, ".local", "bin", "npm");
	const pristineFiles = [
		["package.json", readFileSync(join(fixture.baileysRoot, "package.json"), "utf8")],
		...MANAGED_BAILEYS_STATIC_PATCH_TARGETS.map((target) => [
			target.relativePath,
			readFileSync(join(fixture.baileysRoot, target.relativePath), "utf8"),
		]),
	];
	mkdirSync(dirname(managedNpm), { recursive: true });
	writeFileSync(
		managedNpm,
		`#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const destination = join(process.cwd(), "node_modules", "@whiskeysockets", "baileys");
for (const [relativePath, content] of ${JSON.stringify(pristineFiles)}) {
  const path = join(destination, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
writeFileSync(join(process.cwd(), "npm-invoked"), process.argv.slice(2).join(" "));
`,
	);
	chmodSync(managedNpm, 0o755);
	rmSync(nodeModules, { recursive: true });

	expect(reconcile(fixture).status).toBe("applied");
	expect(readFileSync(join(bridgeRoot, "npm-invoked"), "utf8")).toBe(
		"ci --ignore-scripts --silent",
	);
	assertTargetHunkState(fixture, "after");
});

it("executes patched socket routing without mutating consumer HTTP options", () => {
	const fixture = createArtifactFixture("openclaw");
	reconcile(fixture);
	const socketPath = join(fixture.baileysRoot, "lib/Socket/socket.js");
	const userConfig = socketConfig({
		waWebSocketUrl: "wss://consumer.example/custom",
		auth: { creds: { additionalData: { unrelated: true } } },
	});
	const userSocket = executePatchedSocketPrologue(socketPath, userConfig);
	expect(String(userSocket.url)).toBe("wss://consumer.example/custom");
	expect(userSocket.webSocketConfig).toBe(userConfig);
	expect(userSocket.noiseConfig.authCert).toBeUndefined();

	const metadata = managedMetadata("clawdi_0123456789abcdef0123456789abcdef", 73);
	const managedConfig = socketConfig({
		waWebSocketUrl: "wss://consumer.example/must-not-use",
		options: { headers: { "user-agent": "audited-client" } },
		auth: { creds: { additionalData: { "clawdi.managedWhatsAppSocket": metadata } } },
	});
	const managedSocket = executePatchedSocketPrologue(socketPath, managedConfig);
	expect(String(managedSocket.url)).toBe(qualifiedDefaultWebSocketUrl);
	expect(managedSocket.webSocketConfig).not.toBe(managedConfig);
	expect(managedSocket.webSocketConfig.options?.headers).toEqual({
		"user-agent": "audited-client",
		"x-clawdi-whatsapp-link-capability": metadata.capability,
	});
	expect(managedConfig.options?.headers).toEqual({ "user-agent": "audited-client" });
	expect(managedSocket.noiseConfig.authCert).toEqual(metadata.authCert);
	expect(() =>
		executePatchedSocketPrologue(
			socketPath,
			socketConfig({
				auth: {
					creds: {
						additionalData: { "clawdi.managedWhatsAppSocket": { ...metadata, extra: true } },
					},
				},
			}),
		),
	).toThrow("Invalid Clawdi managed WhatsApp socket metadata");
});

it("keeps managed upgrade identity out of the qualified artifact media fetch", async () => {
	const mediaModule = await import(
		pathToFileURL(join(pristineBaileysRoot, "lib/Utils/messages-media.js")).href
	);
	const getHttpStream = Reflect.get(mediaModule, "getHttpStream");
	if (typeof getHttpStream !== "function")
		throw new Error("qualified getHttpStream export is missing");
	let fetchInit: RequestInit | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		mock(async (_input: string | URL | Request, init?: RequestInit) => {
			fetchInit = init;
			return new Response("media");
		}),
		{ preconnect: originalFetch.preconnect },
	);
	try {
		await Reflect.apply(getHttpStream, undefined, [
			new URL("https://mmg.whatsapp.net/media"),
			{ headers: { "user-agent": "audited-client" } },
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
	expect(fetchInit?.headers).toEqual({ "user-agent": "audited-client" });
	expect(JSON.stringify(fetchInit)).not.toContain("x-clawdi-whatsapp-link-capability");
});

it("executes official Noise trust by default and the managed public key plus serial when present", async () => {
	const fixture = createArtifactFixture("hermes");
	reconcile(fixture);
	const defaultsModule = await import(
		pathToFileURL(join(pristineBaileysRoot, "lib/Defaults/index.js")).href
	);
	const officialCert = Reflect.get(defaultsModule, "WA_CERT_DETAILS");
	if (!officialCert || typeof officialCert !== "object") {
		throw new Error("qualified WA_CERT_DETAILS export is missing");
	}
	const harness = await loadPatchedNoiseHarness(
		join(fixture.baileysRoot, "lib/Utils/noise-handler.js"),
		officialCert,
	);
	const officialSerial = Reflect.get(officialCert, "SERIAL");
	const officialKey = Reflect.get(officialCert, "PUBLIC_KEY");
	if (typeof officialSerial !== "number" || !Buffer.isBuffer(officialKey)) {
		throw new Error("rc13 WA_CERT_DETAILS has an unexpected shape");
	}
	expect(harness.verify(undefined, officialSerial).intermediateAuthorityKey).toEqual(officialKey);
	expect(() => harness.verify(undefined, officialSerial + 1)).toThrow("certification match failed");

	const customCert = managedMetadata("clawdi_0123456789abcdef0123456789abcdef", 73).authCert;
	expect(harness.verify(customCert, customCert.SERIAL).intermediateAuthorityKey).toEqual(
		customCert.PUBLIC_KEY,
	);
	expect(() => harness.verify(customCert, customCert.SERIAL + 1)).toThrow(
		"certification match failed",
	);
});

describe.each(["openclaw", "hermes"] as const)("stock %s auth reconstruction", (runtime) => {
	it("preserves namespaced additionalData through save and rereads it on reconnect", async () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const authDir = join(fixture.root, `auth-${runtime}`);
		const firstMetadata = managedMetadata("clawdi_0123456789abcdef0123456789abcdef", 11);
		await writeStockCreds(authDir, {
			additionalData: { unrelated: "preserved", "clawdi.managedWhatsAppSocket": firstMetadata },
		});
		const initialAuth = await loadStockAuth(authDir);
		const initial = executePatchedSocketPrologue(
			join(fixture.baileysRoot, "lib/Socket/socket.js"),
			socketConfig({ auth: initialAuth.state }),
		);
		expect(managedCapability(initial)).toBe(firstMetadata.capability);

		const secondMetadata = managedMetadata("clawdi_fedcba9876543210fedcba9876543210", 22);
		initialAuth.state.creds.additionalData["clawdi.managedWhatsAppSocket"] = secondMetadata;
		initialAuth.state.creds.accountSyncCounter = 2;
		if (runtime === "hermes") {
			await initialAuth.saveCreds();
		} else {
			await saveOpenClawStyleCreds(authDir, initialAuth.state.creds);
		}

		const reconnectAuth = await loadStockAuth(authDir);
		const reconnect = executePatchedSocketPrologue(
			join(fixture.baileysRoot, "lib/Socket/socket.js"),
			socketConfig({ auth: reconnectAuth.state }),
		);
		expect(managedCapability(reconnect)).toBe(secondMetadata.capability);
		expect(reconnect.noiseConfig.authCert?.PUBLIC_KEY).toEqual(Buffer.alloc(32, 22));
		expect(reconnectAuth.state.creds.additionalData.unrelated).toBe("preserved");
		const persistedMetadata =
			reconnectAuth.state.creds.additionalData["clawdi.managedWhatsAppSocket"];
		if (!persistedMetadata || typeof persistedMetadata !== "object") {
			throw new Error("persisted managed metadata is missing");
		}
		const persistedCert = Reflect.get(persistedMetadata, "authCert");
		if (!persistedCert || typeof persistedCert !== "object") {
			throw new Error("persisted managed authority is missing");
		}
		expect(Buffer.isBuffer(Reflect.get(persistedCert, "PUBLIC_KEY"))).toBe(true);
	});
});

function reconcile(fixture: ArtifactFixture) {
	return reconcileManagedBaileysCompatibility({
		desiredRuntime: fixture.runtime,
		home: fixture.home,
		appRoot: fixture.appRoot,
	});
}

function rollback(fixture: ArtifactFixture) {
	return reconcileManagedBaileysCompatibility({
		desiredRuntime: null,
		home: fixture.home,
	});
}

function createArtifactFixture(
	runtime: ManagedBaileysRuntime,
	version = "7.0.0-rc13",
): ArtifactFixture {
	const root = mkdtempSync(join(tmpdir(), `clawdi-managed-baileys-${runtime}-`));
	temporaryRoots.push(root);
	const home = join(root, "home");
	const appRoot =
		runtime === "openclaw" ? join(home, ".openclaw") : join(home, ".hermes", "hermes-agent");
	const baileysRoot = installArtifactAlias(home, runtime, version);
	return { runtime, root, home, appRoot, baileysRoot };
}

function installArtifactAlias(
	home: string,
	runtime: ManagedBaileysRuntime,
	version = "7.0.0-rc13",
): string {
	const bridgeRoot = join(home, ".hermes", "hermes-agent", "scripts", "whatsapp-bridge");
	const baileysRoot =
		runtime === "openclaw"
			? join(home, ".openclaw", "extensions", "whatsapp", "node_modules", "baileys")
			: join(bridgeRoot, "node_modules", "@whiskeysockets", "baileys");
	for (const target of MANAGED_BAILEYS_STATIC_PATCH_TARGETS) {
		const destination = join(baileysRoot, target.relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(pristineBaileysRoot, target.relativePath), destination);
	}
	writeJson(join(baileysRoot, "package.json"), {
		name: runtime === "openclaw" ? "baileys" : "@whiskeysockets/baileys",
		version,
	});
	if (runtime === "hermes") {
		writeJson(join(bridgeRoot, "package.json"), { name: "hermes-whatsapp-bridge" });
		writeJson(join(bridgeRoot, "package-lock.json"), { lockfileVersion: 3 });
	}
	return baileysRoot;
}

function writeBaileysIdentity(fixture: ArtifactFixture, version: string): void {
	writeJson(join(fixture.baileysRoot, "package.json"), {
		name: fixture.runtime === "openclaw" ? "baileys" : "@whiskeysockets/baileys",
		version,
	});
}

function artifactTargets(fixture: ArtifactFixture) {
	return artifactTargetsAt(fixture.baileysRoot);
}

function artifactTargetsAt(baileysRoot: string) {
	return MANAGED_BAILEYS_STATIC_PATCH_TARGETS.map((target) => ({
		target,
		path: join(baileysRoot, target.relativePath),
	}));
}

function assertTargetHunkState(fixture: ArtifactFixture, state: "before" | "after"): void {
	for (const { target, path } of artifactTargets(fixture)) {
		const content = readFileSync(path, "utf8");
		for (const hunk of target.hunks) {
			expect(exactMatchCount(content, hunk[state])).toBe(1);
			expect(exactMatchCount(content, hunk[state === "before" ? "after" : "before"])).toBe(0);
		}
	}
}

function setHunkState(
	entry: ReturnType<typeof artifactTargets>[number] | undefined,
	hunkId: string | undefined,
	desired: "before" | "after",
): void {
	if (!entry || !hunkId) throw new Error("missing hunk fixture");
	const hunk = entry.target.hunks.find((candidate) => candidate.id === hunkId);
	if (!hunk) throw new Error(`unknown fixture hunk ${hunkId}`);
	const content = readFileSync(entry.path, "utf8");
	const current = desired === "after" ? hunk.before : hunk.after;
	if (exactMatchCount(content, hunk[desired]) === 1 && exactMatchCount(content, current) === 0) {
		return;
	}
	if (exactMatchCount(content, current) !== 1 || exactMatchCount(content, hunk[desired]) !== 0) {
		throw new Error(`fixture hunk ${hunkId} is not uniquely reversible`);
	}
	writeFileSync(entry.path, content.replace(current, hunk[desired]));
}

function exactMatchCount(content: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (offset <= content.length - needle.length) {
		const match = content.indexOf(needle, offset);
		if (match < 0) break;
		count += 1;
		offset = match + 1;
	}
	return count;
}

function restorePristineTarget(
	entry: ReturnType<typeof artifactTargets>[number] | undefined,
): void {
	if (!entry) throw new Error("missing fixture target");
	copyFileSync(join(pristineBaileysRoot, entry.target.relativePath), entry.path);
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface SocketHarnessConfig {
	waWebSocketUrl: string;
	options?: { headers?: Record<string, string> };
	auth: { creds: Record<string, unknown> };
	shouldSyncHistoryMessage: (value: unknown) => boolean;
	logger: { warn(): void };
	[key: string]: unknown;
}

interface SocketHarnessResult {
	url: URL;
	webSocketConfig: SocketHarnessConfig;
	noiseConfig: { authCert?: { SERIAL: number; PUBLIC_KEY: Buffer } };
}

function socketConfig(overrides: Partial<SocketHarnessConfig>): SocketHarnessConfig {
	return {
		waWebSocketUrl: qualifiedDefaultWebSocketUrl,
		browser: ["Clawdi", "Chrome", "1.0.0"],
		auth: { creds: {} },
		shouldSyncHistoryMessage: () => true,
		logger: { warn() {} },
		...overrides,
	};
}

function executePatchedSocketPrologue(
	path: string,
	config: SocketHarnessConfig,
): SocketHarnessResult {
	const source = readFileSync(path, "utf8");
	const helpersStart = source.indexOf("const CLAWDI_MANAGED_SOCKET_KEY");
	const helpersEnd = source.indexOf("/**\n * Connects to WA servers", helpersStart);
	const socketStart = source.indexOf("export const makeSocket =", helpersEnd);
	const connectLine = "    ws.connect();";
	const socketEnd = source.indexOf(connectLine, socketStart) + connectLine.length;
	if (helpersStart < 0 || helpersEnd < 0 || socketStart < 0 || socketEnd < connectLine.length) {
		throw new Error("patched qualified socket prologue is missing");
	}
	const helpers = source.slice(helpersStart, helpersEnd);
	const prologue = source
		.slice(socketStart, socketEnd)
		.replace("export const makeSocket =", "const makeSocket =");
	let capturedWebSocketConfig: SocketHarnessConfig | undefined;
	let capturedNoiseConfig: SocketHarnessResult["noiseConfig"] | undefined;
	class WebSocketClient {
		constructor(
			readonly url: URL,
			readonly config: SocketHarnessConfig,
		) {
			capturedWebSocketConfig = config;
		}
		connect() {}
	}
	const factory = Function(
		"Boom",
		"BinaryInfo",
		"PROCESSABLE_HISTORY_TYPES",
		"generateMdTagPrefix",
		"DisconnectReason",
		"Curve",
		"makeNoiseHandler",
		"NOISE_WA_HEADER",
		"DEFAULT_CONNECTION_CONFIG",
		"WebSocketClient",
		`${helpers}\n${prologue}\nreturn { url, noise, ws };\n};\nreturn makeSocket;`,
	);
	const makeSocket = Reflect.apply(factory, undefined, [
		class Boom extends Error {},
		class BinaryInfo {},
		[],
		() => "tag",
		{ loggedOut: 401 },
		{ generateKeyPair: () => ({ private: Buffer.alloc(32), public: Buffer.alloc(32) }) },
		(noiseConfig: SocketHarnessResult["noiseConfig"]) => {
			capturedNoiseConfig = noiseConfig;
			return {};
		},
		Buffer.from("WA"),
		qualifiedDefaultConnectionConfig,
		WebSocketClient,
	]);
	if (typeof makeSocket !== "function") throw new Error("patched makeSocket did not compile");
	const output = Reflect.apply(makeSocket, undefined, [config]);
	if (!output || typeof output !== "object" || !capturedWebSocketConfig || !capturedNoiseConfig) {
		throw new Error("patched socket prologue did not execute");
	}
	const url = Reflect.get(output, "url");
	if (!(url instanceof URL)) throw new Error("patched socket URL is missing");
	return { url, webSocketConfig: capturedWebSocketConfig, noiseConfig: capturedNoiseConfig };
}

function managedMetadata(capability: string, keyByte: number) {
	return {
		schemaVersion: "clawdi.managedWhatsAppSocket.v1",
		capability,
		authCert: {
			SERIAL: keyByte,
			ISSUER: "ClawdiManagedLink",
			PUBLIC_KEY: Buffer.alloc(32, keyByte),
		},
	};
}

function managedCapability(result: SocketHarnessResult): unknown {
	return result.webSocketConfig.options?.headers?.["x-clawdi-whatsapp-link-capability"];
}

async function loadPatchedNoiseHarness(path: string, officialCert: object) {
	const capture: { issuerSerial: number; verifiedKeys: Buffer[] } = {
		issuerSerial: 0,
		verifiedKeys: [],
	};
	const context = createContext({ Buffer, capture, officialCert });
	const module = new SourceTextModule(readFileSync(path, "utf8"), {
		context,
		identifier: path,
	});
	const stubs = new Map([
		[
			"@hapi/boom",
			new SourceTextModule(`export class Boom extends Error {}`, {
				context,
				identifier: "boom",
			}),
		],
		[
			"../../WAProto/index.js",
			new SourceTextModule(
				`export const proto = { CertChain: {
					decode() { return {
						intermediate: { details: Buffer.from("intermediate"), signature: Buffer.from("sig") },
						leaf: { details: Buffer.from("leaf"), signature: Buffer.from("sig") }
					}; },
					NoiseCertificate: { Details: { decode() { return {
						issuerSerial: capture.issuerSerial, key: Buffer.alloc(32, 1)
					}; } } }
				} };`,
				{ context, identifier: "wa-proto" },
			),
		],
		[
			"../Defaults/index.js",
			new SourceTextModule(
				`export const NOISE_MODE = "Noise_XX_25519_AESGCM_SHA256";
				export const WA_CERT_DETAILS = officialCert;`,
				{ context, identifier: "noise-defaults" },
			),
		],
		[
			"../WABinary/index.js",
			new SourceTextModule(`export async function decodeBinaryNode(value) { return value; }`, {
				context,
				identifier: "wa-binary",
			}),
		],
		[
			"./crypto.js",
			new SourceTextModule(
				`export const aesDecryptGCM = value => value;
				export const aesEncryptGCM = value => Buffer.from(value);
				export const Curve = {
					sharedKey() { return Buffer.alloc(32, 2); },
					verify(key) { capture.verifiedKeys.push(Buffer.from(key)); return true; }
				};
				export const hkdf = (_value, length) => Buffer.alloc(length, 3);
				export const sha256 = () => Buffer.alloc(32, 4);`,
				{ context, identifier: "noise-crypto" },
			),
		],
	]);
	await module.link((specifier) => {
		const dependency = stubs.get(specifier);
		if (!dependency) throw new Error(`unexpected Noise module dependency: ${specifier}`);
		return dependency;
	});
	await module.evaluate();
	const makeNoiseHandler = Reflect.get(module.namespace, "makeNoiseHandler");
	if (typeof makeNoiseHandler !== "function") throw new Error("patched makeNoiseHandler missing");
	return {
		verify(authCert: object | undefined, issuerSerial: number) {
			capture.issuerSerial = issuerSerial;
			capture.verifiedKeys = [];
			const logger = {
				level: "silent",
				child() {
					return this;
				},
				trace() {},
			};
			const handler = Reflect.apply(makeNoiseHandler, undefined, [
				{
					keyPair: { private: Buffer.alloc(32, 5), public: Buffer.alloc(32, 6) },
					NOISE_HEADER: Buffer.from("WA"),
					logger,
					...(authCert ? { authCert } : {}),
				},
			]);
			if (!handler || typeof handler !== "object") throw new Error("Noise handler is invalid");
			const processHandshake = Reflect.get(handler, "processHandshake");
			if (typeof processHandshake !== "function") throw new Error("processHandshake is missing");
			Reflect.apply(processHandshake, handler, [
				{
					serverHello: {
						ephemeral: Buffer.alloc(32, 7),
						static: Buffer.alloc(32, 8),
						payload: Buffer.alloc(32, 9),
					},
				},
				{ private: Buffer.alloc(32, 10), public: Buffer.alloc(32, 11) },
			]);
			const intermediateAuthorityKey = capture.verifiedKeys[1];
			if (!intermediateAuthorityKey) throw new Error("intermediate authority was not verified");
			return { intermediateAuthorityKey };
		},
	};
}

async function stockAuthModules() {
	const authModule = await import(
		pathToFileURL(join(pristineBaileysRoot, "lib/Utils/use-multi-file-auth-state.js")).href
	);
	const genericsModule = await import(
		pathToFileURL(join(pristineBaileysRoot, "lib/Utils/generics.js")).href
	);
	const useMultiFileAuthState = Reflect.get(authModule, "useMultiFileAuthState");
	const BufferJSON = Reflect.get(genericsModule, "BufferJSON");
	if (typeof useMultiFileAuthState !== "function" || !BufferJSON) {
		throw new Error("qualified auth-state exports are missing");
	}
	return { useMultiFileAuthState, BufferJSON };
}

async function writeStockCreds(authDir: string, creds: Record<string, unknown>): Promise<void> {
	const { BufferJSON } = await stockAuthModules();
	mkdirSync(authDir, { recursive: true });
	writeFileSync(join(authDir, "creds.json"), JSON.stringify(creds, BufferJSON.replacer));
}

async function loadStockAuth(authDir: string): Promise<{
	state: {
		creds: Record<string, unknown> & {
			additionalData: Record<string, unknown>;
			accountSyncCounter?: number;
		};
	};
	saveCreds: () => Promise<void>;
}> {
	const { useMultiFileAuthState } = await stockAuthModules();
	return Reflect.apply(useMultiFileAuthState, undefined, [authDir]);
}

async function saveOpenClawStyleCreds(
	authDir: string,
	creds: Record<string, unknown>,
): Promise<void> {
	const { BufferJSON } = await stockAuthModules();
	writeFileSync(join(authDir, "creds.json"), JSON.stringify(creds, BufferJSON.replacer));
}
