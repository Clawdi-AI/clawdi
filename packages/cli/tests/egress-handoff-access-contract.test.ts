import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convergeRuntimeManifest } from "../src/runtime/manifest";
import { normalizeHostedRuntimeBundleV2 } from "../src/runtime/manifest-source";
import { getRuntimePaths, type RuntimePaths } from "../src/runtime/paths";
import { ensureRuntimeStateDirs } from "../src/runtime/state";

/**
 * Hosted tenant platform-identity contract.
 *
 * The tenant image runs three filesystem identities:
 *  - root: boot + convergence writes every platform artifact,
 *  - uid/gid 10001: the tenant workload user (member of no privileged groups),
 *  - uid/gid 10002: the egress sidecar identity that mitmproxy drops to.
 *
 * /etc/clawdi, /var/lib/clawdi, and /var/cache/clawdi are 0700 root-owned;
 * /run/clawdi is 0711 root-owned so only explicitly named handoff files are
 * reachable by other identities. This test simulates kernel access checks
 * (traversal needs x on every ancestor, read needs r on the file itself)
 * because CI runs the suite as an unprivileged user and the writers only
 * chown when running as root. The `intendedOwner` tables below encode the
 * ownership the writers apply in production (each entry cites its writer);
 * when the suite actually runs as root, a guarded assertion additionally
 * verifies stat(uid/gid) matches the intended ownership, proving the
 * writers' chown calls.
 */
const TENANT_UID = 10_001;
const TENANT_GID = 10_001;
const EGRESS_UID = 10_002;
const EGRESS_GID = 10_002;

interface LinuxIdentity {
	uid: number;
	gid: number;
}

const TENANT: LinuxIdentity = { uid: TENANT_UID, gid: TENANT_GID };
const EGRESS: LinuxIdentity = { uid: EGRESS_UID, gid: EGRESS_GID };

const HANDOFF_TEST_SECRET_REF = "secret://handoff/access-contract";

const fixtureRoots: string[] = [];

afterAll(() => {
	for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function permissionGranted(
	mode: number,
	identity: LinuxIdentity,
	nodeUid: number,
	nodeGid: number,
	ownerBit: number,
): boolean {
	if (nodeUid === identity.uid) return (mode & ownerBit) !== 0;
	if (nodeGid === identity.gid) return (mode & (ownerBit >> 3)) !== 0;
	return (mode & (ownerBit >> 6)) !== 0;
}

/** Simulates the kernel walking `path` from the fixture root for `identity`. */
function accessVerdict(
	path: string,
	fixtureRoot: string,
	identity: LinuxIdentity,
	intendedOwner: { uid: number; gid: number } | undefined,
	fileCheck: "read" | "traverse",
): { allowed: boolean; blockedBy: string; nodeMode: number } {
	const owned = intendedOwner
		? () => intendedOwner
		: () => {
				const stat = lstatSync(path);
				return { uid: stat.uid, gid: stat.gid };
			};
	const relative = path.slice(fixtureRoot.length + 1);
	const parts = relative.split("/");
	let current = fixtureRoot;
	for (let index = 0; index < parts.length - 1; index++) {
		current = join(current, parts[index]);
		const stat = lstatSync(current);
		if (!permissionGranted(stat.mode, identity, stat.uid, stat.gid, 0o100)) {
			return { allowed: false, blockedBy: current, nodeMode: stat.mode & 0o777 };
		}
	}
	const fileStat = lstatSync(path);
	const owner = owned();
	const bit = fileCheck === "read" ? 0o400 : 0o100;
	return {
		allowed: permissionGranted(fileStat.mode, identity, owner.uid, owner.gid, bit),
		blockedBy: path,
		nodeMode: fileStat.mode & 0o777,
	};
}

function assertIdentityCanAccess(
	path: string,
	fixtureRoot: string,
	identity: LinuxIdentity,
	label: string,
	intendedOwner?: { uid: number; gid: number },
	fileCheck: "read" | "traverse" = "read",
): void {
	const verdict = accessVerdict(path, fixtureRoot, identity, intendedOwner, fileCheck);
	expect(
		verdict.allowed,
		`${label} must be accessible to ${identity.uid}:${identity.gid} (blocked at ${verdict.blockedBy}, mode ${verdict.nodeMode.toString(
			8,
		)})`,
	).toBe(true);
	if (intendedOwner && typeof process.getuid === "function" && process.getuid() === 0) {
		const stat = statSync(path);
		expect(stat.uid, `${label} owner`).toBe(intendedOwner.uid);
		expect(stat.gid, `${label} group`).toBe(intendedOwner.gid);
	}
}

function assertIdentityCannotAccess(
	path: string,
	fixtureRoot: string,
	identity: LinuxIdentity,
	label: string,
	intendedOwner?: { uid: number; gid: number },
): void {
	const verdict = accessVerdict(path, fixtureRoot, identity, intendedOwner, "read");
	expect(
		verdict.allowed,
		`${label} must NOT be readable by ${identity.uid}:${identity.gid} (traversal/read at ${verdict.blockedBy} granted, mode ${verdict.nodeMode.toString(8)})`,
	).toBe(false);
}

/** Walks a platform root subtree and returns every regular file it contains. */
function platformRenderedFiles(paths: RuntimePaths): string[] {
	const roots = [paths.configurationRoot, paths.serviceStateRoot, paths.cacheRoot, paths.runRoot];
	const walk = (directory: string, files: string[]): string[] => {
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				walk(path, files);
			} else if (stat.isFile()) {
				files.push(path);
			}
		}
		return files;
	};
	const files: string[] = [];
	for (const root of roots) walk(root, files);
	return files.filter((path) => roots.some((root) => path.startsWith(`${root}/`)));
}

function convergeHostedEgressFixture(): { paths: RuntimePaths; root: string } {
	const root = mkdtempSync(join(tmpdir(), "clawdi-handoff-access-"));
	fixtureRoots.push(root);
	const home = join(root, "home", "clawdi");
	const state = join(root, "var", "lib", "clawdi");
	const cache = join(root, "var", "cache", "clawdi");
	const run = join(root, "run", "clawdi");
	// Production (hosted, root) uses /run/systemd/system — systemd's own
	// runtime unit directory, outside the clawdi platform roots, with
	// systemd-prescribed 0755 directory modes. Mirror that topology so the
	// platform-root walk sees the same boundaries production has.
	const systemdSystemRoot = join(root, "systemd-run", "system");
	mkdirSync(join(home, ".openclaw", "bin"), { recursive: true });
	writeFileSync(
		join(home, ".openclaw", "bin", "openclaw"),
		`#!/bin/sh
[ "\${1:-}" != "--version" ] || printf '%s\\n' '2026.7.1'
exit 0
`,
	);
	chmodSync(join(home, ".openclaw", "bin", "openclaw"), 0o755);

	const originalEnv = { ...process.env };
	process.env.HOME = home;
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	const runtimeUid = process.getuid?.() ?? 1_000;
	const runtimeGid = process.getgid?.() ?? 1_000;
	process.env.CLAWDI_RUNTIME_USER = String(runtimeUid);
	process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
	process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
	process.env.CLAWDI_SERVICE_STATE_DIR = state;
	process.env.CLAWDI_RUN_DIR = run;
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = systemdSystemRoot;
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	try {
		// Mirror the tenant image: systemd directory directives pre-create the
		// four platform roots with their canonical modes before the CLI runs.
		for (const [path, mode] of [
			[join(root, "etc", "clawdi"), 0o700],
			[state, 0o700],
			[cache, 0o700],
			[run, 0o711],
			// systemd pre-creates its runtime unit directory before the CLI.
			[systemdSystemRoot, 0o755],
		] as const) {
			mkdirSync(path, { recursive: true, mode });
			chmodSync(path, mode);
		}

		const paths = getRuntimePaths();
		ensureRuntimeStateDirs(paths);
		const engineBinary = join(
			paths.egressEngineMaintainedRoot,
			"12.2.3",
			"2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
			"mitmdump",
		);
		mkdirSync(dirname(engineBinary), { recursive: true });
		writeFileSync(engineBinary, "#!/usr/bin/env sh\necho fake mitmdump\n");
		chmodSync(engineBinary, 0o755);

		const fixture = JSON.parse(
			readFileSync(
				join(import.meta.dir, "../../../test-fixtures/runtime-bundle-v2.golden.json"),
				"utf-8",
			),
		) as Record<string, unknown>;
		const manifest = fixture.manifest as Record<string, unknown>;
		const runtimes = manifest.runtimes as Record<string, Record<string, unknown>>;
		const openclaw = runtimes.openclaw;
		openclaw.providerMode = "unmanaged";
		openclaw.provider_ids = [];
		delete openclaw.primary_model;
		manifest.providers = {};
		manifest.skills = { entries: {} };
		manifest.egressProfiles = {
			profiles: [
				{
					id: "access-contract",
					enabled: true,
					kind: "provider",
					match: { scheme: "https", host: "api.example.test", headers: {}, query: {} },
					rewrite: {
						setHeaders: {
							authorization: {
								type: "secretRef",
								secretRef: HANDOFF_TEST_SECRET_REF,
								prefix: "Bearer ",
							},
						},
					},
					priority: 10,
				},
			],
		};
		fixture.secretValues = {
			"secret://clawdi/auth-token": "handoff-runtime-auth-token",
			"secret://runtime/openclaw/gateway-token": "handoff-gateway-token",
			"secret://tool.codex.apiKey": "handoff-codex-key",
			[HANDOFF_TEST_SECRET_REF]: "handoff-sidecar-secret",
		};
		const load = normalizeHostedRuntimeBundleV2(fixture);
		load.applyContext = {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: 2,
				manifestETag: '"manifest-handoff-access"',
				applyReceiptId: "apply-receipt-handoff-access-0001",
				bootNonce: "boot-nonce-handoff-access-0000001",
			},
			cliPackageSpec: "clawdi@1.2.3-test",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer", token: "bootstrap-bearer-handoff-access" },
			},
		};
		const result = convergeRuntimeManifest(load, paths, {
			hostedRuntimeContract: {
				expectedIdentity: {
					home,
					user: String(runtimeUid),
					uid: runtimeUid,
					gid: runtimeGid,
				},
				resolveUserIdentity: () => ({ uid: runtimeUid, gid: runtimeGid }),
			},
		});
		expect(result.installErrors).toEqual([]);
		return { paths: getRuntimePaths(), root };
	} finally {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	}
}

describe("runtime handoff filesystem access contract", () => {
	test("the egress sidecar identity (uid 10002) can traverse and read every file it consumes", () => {
		const { paths, root } = convergeHostedEgressFixture();

		// Every path the egress sidecar opens. Owners are what the writers
		// apply when running as root:
		//  - writeTransparentEgressEnvFile: chownSync(path, 0, egressGid)
		//  - writeEgressProfileBundle: chownSync(path, 0, egressGid)
		//  - writeEgressAddon: chownSync(path, 0, egressGid)
		//  - writeEgressSecretMaterial: makeEgressIdentityOwned(path)
		//  - makeEgressIdentityPrivateDir: makeEgressIdentityOwned(path)
		const egressConsumed = [
			{
				path: paths.egressTransparentEnv,
				label: "transparent-egress env handoff",
				mode: 0o640,
				owner: { uid: 0, gid: EGRESS_GID },
			},
			{
				path: paths.egressProfileBundle,
				label: "egress profile bundle",
				mode: 0o640,
				owner: { uid: 0, gid: EGRESS_GID },
			},
			{
				path: paths.egressAddon,
				label: "egress addon script",
				mode: 0o640,
				owner: { uid: 0, gid: EGRESS_GID },
			},
			{
				path: join(paths.managedSecretRoot, "egress-secrets.json"),
				label: "egress sidecar secrets",
				mode: 0o600,
				owner: { uid: EGRESS_UID, gid: EGRESS_GID },
			},
			{
				path: paths.egressCaDir,
				label: "mitmproxy confdir",
				mode: 0o700,
				owner: { uid: EGRESS_UID, gid: EGRESS_GID },
				fileCheck: "traverse" as const,
			},
		];

		for (const entry of egressConsumed) {
			expect(existsSync(entry.path), `${entry.label} must be rendered`).toBe(true);
			expect(statSync(entry.path).mode & 0o777, `mode of ${entry.label}`).toBe(entry.mode);
			assertIdentityCanAccess(
				entry.path,
				root,
				EGRESS,
				entry.label,
				entry.owner,
				entry.fileCheck ?? "read",
			);
		}

		// mitmdump writes its CA cert into its confdir after starting; the
		// file it creates inherits the egress-owned directory, and the
		// engine reads it back through that same identity. The cert is not
		// present right after convergence, so this assert only fires when a
		// sidecar run has produced it (root-hosted local runs).
		if (existsSync(paths.egressCaCert)) {
			assertIdentityCanAccess(paths.egressCaCert, root, EGRESS, "mitmproxy CA cert", {
				uid: EGRESS_UID,
				gid: EGRESS_GID,
			});
		}
	});

	test("the tenant workload user (uid 10001) cannot read any platform-rendered file", () => {
		const { paths, root } = convergeHostedEgressFixture();
		const files = platformRenderedFiles(paths);
		expect(files.length).toBeGreaterThan(10);
		const labels = new Map<string, string>([
			[paths.managedConfig, "hosted managed config"],
			[paths.runtimeContextFile, "runtime context"],
			[paths.syncState, "sync state"],
			[paths.instanceData, "instance data"],
			[paths.sensitiveInstanceData, "sensitive instance data"],
			[paths.manifestLastGood, "last-good manifest cache"],
			[paths.appliedState, "applied state"],
			[paths.managedSecretCacheFile, "runtime secrets cache"],
			[paths.egressProfileBundle, "egress profile bundle"],
			[paths.egressTransparentEnv, "transparent-egress env handoff"],
			[paths.egressAddon, "egress addon script"],
			[join(paths.managedSecretRoot, "egress-secrets.json"), "egress sidecar secrets"],
			[paths.daemonAuthToken, "daemon auth token"],
			[paths.bootStatus, "boot status"],
			[paths.cloudStatus, "cloud status"],
			[paths.cloudResult, "cloud result"],
			[paths.liveSyncEnvironmentIndex, "live-sync environment index"],
			[paths.channelsEtag, "channels etag cache"],
			[paths.runtimeWatchStatus, "runtime watch status"],
		]);

		const publishedToTenant = new Set([paths.egressSystemCaFile]);

		// The sidecar runtime publishes the combined system+mitmproxy CA
		// bundle to the tenant workload as its SSL_CERT_FILE. Convergence
		// does not render it, so materialize it exactly the way
		// publishEgressSystemCaBundle does (writePrivateFileAtomic with
		// mode 0640 dirMode 0711, chown root:runtimeGid when root) to
		// exercise the published handoff in both directions.
		mkdirSync(dirname(paths.egressSystemCaFile), { recursive: true, mode: 0o711 });
		chmodSync(dirname(paths.egressSystemCaFile), 0o711);
		writeFileSync(paths.egressSystemCaFile, "# system CA bundle\n# mitmproxy CA cert\n", {
			mode: 0o640,
		});
		chmodSync(paths.egressSystemCaFile, 0o640);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			chownSync(paths.egressSystemCaFile, 0, TENANT_GID);
		}
		const publishedCaOwner = { uid: 0, gid: TENANT_GID };

		for (const file of files) {
			const label = labels.get(file) ?? `platform-rendered file ${file}`;
			if (publishedToTenant.has(file)) {
				assertIdentityCanAccess(file, root, TENANT, label, publishedCaOwner);
				continue;
			}
			assertIdentityCannotAccess(file, root, TENANT, label);
		}

		// The one explicit publish to the tenant must not leak anything else:
		// every sidecar-consumed handoff that is group-readable by the egress
		// identity is exercised explicitly above through the owned-by-table.
		for (const file of [paths.egressProfileBundle, paths.egressTransparentEnv, paths.egressAddon]) {
			assertIdentityCannotAccess(file, root, TENANT, `tenant denial of ${file}`);
		}

		// Systemd's runtime unit directory (/run/systemd/system in
		// production) is systemd-managed 0755 with standard 0644 unit files —
		// the same interface every distro exposes to every local user. Unit
		// files are wiring (ExecStart, paths, User=) and never carry secret
		// values: environment variables live in the 0600 files under the
		// clawdi env root, which the platform-root walk above already
		// verified as unreadable. Assert that contract explicitly.
		const systemdUnits = readdirSync(paths.systemdSystemRoot)
			.filter((entry) => entry.endsWith(".service"))
			.map((entry) => join(paths.systemdSystemRoot, entry));
		expect(systemdUnits.length).toBeGreaterThan(0);
		for (const unit of systemdUnits) {
			expect(statSync(unit).mode & 0o777, `mode of ${unit}`).toBe(0o644);
			const content = readFileSync(unit, "utf-8");
			expect(content).not.toContain("handoff-runtime-auth-token");
			expect(content).not.toContain("handoff-gateway-token");
			expect(content).not.toContain("handoff-sidecar-secret");
		}
	});
});
