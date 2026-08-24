// Upgrade procedure: packages/cli/docs/managed-baileys-compat-upgrade.md
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import { isValidSemver } from "../lib/semver";
import { makeRuntimeUserOwned, spawnRuntimeUserCommand } from "./runtime-user-command";

const HERMES_BAILEYS_DEPENDENCY_INSTALL_TIMEOUT_MS = 300_000;

export type ManagedBaileysRuntime = "openclaw" | "hermes";

interface StrictContextHunk {
	id: string;
	before: string;
	after: string;
	predecessors?: readonly string[];
}

interface StaticPatchTarget {
	relativePath: string;
	hunks: readonly StrictContextHunk[];
}

interface ManagedBaileysArtifact {
	runtime: ManagedBaileysRuntime;
	root: string;
	packageName: "baileys" | "@whiskeysockets/baileys";
	targets: readonly StaticPatchTarget[];
	hermesBridgeRoot?: string;
}

interface VerifiedPackageIdentity {
	path: string;
	sha256: string;
}

type ManagedBaileysReconcileResult =
	| { status: "inert" }
	| { status: "already-patched" }
	| { status: "applied" }
	| { status: "rolled-back" }
	| { status: "rollback-refused"; errors: string[] };

const BAILEYS_TARGETS = [
	{
		relativePath: "lib/Socket/socket.js",
		hunks: [
			{
				id: "socket.default-connection-config-import.v1",
				before:
					"import { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, NOISE_WA_HEADER, PROCESSABLE_HISTORY_TYPES, TimeMs, UPLOAD_TIMEOUT } from '../Defaults/index.js';\n",
				after:
					"import { DEFAULT_CONNECTION_CONFIG, DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, NOISE_WA_HEADER, PROCESSABLE_HISTORY_TYPES, TimeMs, UPLOAD_TIMEOUT } from '../Defaults/index.js';\n",
			},
			{
				id: "socket.managed-metadata-validator.v2",
				before:
					"import { executeWMexQuery } from './mex.js';\n" +
					"/**\n" +
					" * Connects to WA servers and performs:\n",
				after:
					"import { executeWMexQuery } from './mex.js';\n" +
					"const CLAWDI_MANAGED_SOCKET_KEY = 'clawdi.managedWhatsAppSocket';\n" +
					"const CLAWDI_MANAGED_SOCKET_SCHEMA = 'clawdi.managedWhatsAppSocket.v1';\n" +
					"const hasExactKeys = (value, keys) => Object.keys(value).sort().join('\\0') === [...keys].sort().join('\\0');\n" +
					"const managedSocketMetadata = (creds) => {\n" +
					"    const additionalData = creds?.additionalData;\n" +
					"    if (!additionalData || typeof additionalData !== 'object' || Array.isArray(additionalData) || !Object.prototype.hasOwnProperty.call(additionalData, CLAWDI_MANAGED_SOCKET_KEY)) {\n" +
					"        return undefined;\n" +
					"    }\n" +
					"    const value = additionalData[CLAWDI_MANAGED_SOCKET_KEY];\n" +
					"    const authCert = value?.authCert;\n" +
					"    if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, ['authCert', 'schemaVersion']) || value.schemaVersion !== CLAWDI_MANAGED_SOCKET_SCHEMA || !authCert || typeof authCert !== 'object' || Array.isArray(authCert) || !hasExactKeys(authCert, ['ISSUER', 'PUBLIC_KEY', 'SERIAL']) || !Number.isSafeInteger(authCert.SERIAL) || authCert.SERIAL < 0 || typeof authCert.ISSUER !== 'string' || !authCert.ISSUER || authCert.ISSUER.trim() !== authCert.ISSUER || authCert.ISSUER.length > 256 || !Buffer.isBuffer(authCert.PUBLIC_KEY) || authCert.PUBLIC_KEY.length !== 32) {\n" +
					"        throw new Error('Invalid Clawdi managed WhatsApp socket metadata');\n" +
					"    }\n" +
					"    return value;\n" +
					"};\n" +
					"/**\n" +
					" * Connects to WA servers and performs:\n",
				predecessors: [
					"import { executeWMexQuery } from './mex.js';\n" +
						"const CLAWDI_MANAGED_SOCKET_KEY = 'clawdi.managedWhatsAppSocket';\n" +
						"const CLAWDI_MANAGED_SOCKET_SCHEMA = 'clawdi.managedWhatsAppSocket.v1';\n" +
						"const CLAWDI_LINK_CAPABILITY_HEADER = 'x-clawdi-whatsapp-link-capability';\n" +
						"const hasExactKeys = (value, keys) => Object.keys(value).sort().join('\\0') === [...keys].sort().join('\\0');\n" +
						"const managedSocketMetadata = (creds) => {\n" +
						"    const additionalData = creds?.additionalData;\n" +
						"    if (!additionalData || typeof additionalData !== 'object' || Array.isArray(additionalData) || !Object.prototype.hasOwnProperty.call(additionalData, CLAWDI_MANAGED_SOCKET_KEY)) {\n" +
						"        return undefined;\n" +
						"    }\n" +
						"    const value = additionalData[CLAWDI_MANAGED_SOCKET_KEY];\n" +
						"    const authCert = value?.authCert;\n" +
						"    if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, ['authCert', 'capability', 'schemaVersion']) || value.schemaVersion !== CLAWDI_MANAGED_SOCKET_SCHEMA || typeof value.capability !== 'string' || !/^clawdi_[a-f0-9]{32}$/.test(value.capability) || !authCert || typeof authCert !== 'object' || Array.isArray(authCert) || !hasExactKeys(authCert, ['ISSUER', 'PUBLIC_KEY', 'SERIAL']) || !Number.isSafeInteger(authCert.SERIAL) || authCert.SERIAL < 0 || typeof authCert.ISSUER !== 'string' || !authCert.ISSUER || authCert.ISSUER.trim() !== authCert.ISSUER || authCert.ISSUER.length > 256 || !Buffer.isBuffer(authCert.PUBLIC_KEY) || authCert.PUBLIC_KEY.length !== 32) {\n" +
						"        throw new Error('Invalid Clawdi managed WhatsApp socket metadata');\n" +
						"    }\n" +
						"    return value;\n" +
						"};\n" +
						"/**\n" +
						" * Connects to WA servers and performs:\n",
				],
			},
			{
				id: "socket.managed-metadata-read.v1",
				before:
					"    const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository } = config;\n" +
					"    const publicWAMBuffer = new BinaryInfo();\n",
				after:
					"    const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository } = config;\n" +
					"    const managedMetadata = managedSocketMetadata(authState?.creds);\n" +
					"    const publicWAMBuffer = new BinaryInfo();\n",
			},
			{
				id: "socket.managed-default-url.v1",
				before:
					"    const url = typeof waWebSocketUrl === 'string' ? new URL(waWebSocketUrl) : waWebSocketUrl;\n",
				after:
					"    const effectiveWebSocketUrl = managedMetadata ? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl : waWebSocketUrl;\n" +
					"    const url = typeof effectiveWebSocketUrl === 'string' ? new URL(effectiveWebSocketUrl) : effectiveWebSocketUrl;\n",
			},
			{
				id: "socket.managed-noise.v2",
				before:
					"        routingInfo: authState?.creds?.routingInfo\n" +
					"    });\n" +
					"    const ws = new WebSocketClient(url, config);\n",
				after:
					"        routingInfo: authState?.creds?.routingInfo,\n" +
					"        authCert: managedMetadata?.authCert\n" +
					"    });\n" +
					"    const ws = new WebSocketClient(url, config);\n",
				predecessors: [
					"        routingInfo: authState?.creds?.routingInfo,\n" +
						"        authCert: managedMetadata?.authCert\n" +
						"    });\n" +
						"    const webSocketConfig = managedMetadata ? {\n" +
						"        ...config,\n" +
						"        options: {\n" +
						"            ...config.options,\n" +
						"            headers: {\n" +
						"                ...config.options?.headers,\n" +
						"                [CLAWDI_LINK_CAPABILITY_HEADER]: managedMetadata.capability\n" +
						"            }\n" +
						"        }\n" +
						"    } : config;\n" +
						"    const ws = new WebSocketClient(url, webSocketConfig);\n",
				],
			},
		],
	},
	{
		relativePath: "lib/Utils/noise-handler.js",
		hunks: [
			{
				id: "noise.configurable-trust.v1",
				before:
					"export const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }) => {\n    logger = logger.child({ class: 'ns' });\n",
				after:
					"export const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo, authCert }) => {\n    const trustedCert = authCert ?? WA_CERT_DETAILS;\n    logger = logger.child({ class: 'ns' });\n",
			},
			{
				id: "noise.verify-configured-trust.v1",
				before:
					"            const verifyIntermediate = Curve.verify(WA_CERT_DETAILS.PUBLIC_KEY, certIntermediate.details, certIntermediate.signature);\n" +
					"            if (!verify) {\n" +
					"                throw new Boom('noise certificate signature invalid', { statusCode: 400 });\n" +
					"            }\n" +
					"            if (!verifyIntermediate) {\n" +
					"                throw new Boom('noise intermediate certificate signature invalid', { statusCode: 400 });\n" +
					"            }\n" +
					"            if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {\n",
				after:
					"            const verifyIntermediate = Curve.verify(trustedCert.PUBLIC_KEY, certIntermediate.details, certIntermediate.signature);\n" +
					"            if (!verify) {\n" +
					"                throw new Boom('noise certificate signature invalid', { statusCode: 400 });\n" +
					"            }\n" +
					"            if (!verifyIntermediate) {\n" +
					"                throw new Boom('noise intermediate certificate signature invalid', { statusCode: 400 });\n" +
					"            }\n" +
					"            if (issuerSerial !== trustedCert.SERIAL) {\n",
			},
		],
	},
	{
		relativePath: "lib/Utils/noise-handler.d.ts",
		hunks: [
			{
				id: "noise.types-configurable-trust.v1",
				before:
					"export declare const makeNoiseHandler: ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }: {\n",
				after:
					"export declare const makeNoiseHandler: ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo, authCert }: {\n",
			},
			{
				id: "noise.types-auth-cert.v1",
				before: "    routingInfo?: Buffer | undefined;\n" + "}) => {\n",
				after:
					"    routingInfo?: Buffer | undefined;\n" +
					"    authCert?: {\n" +
					"        SERIAL: number;\n" +
					"        ISSUER: string;\n" +
					"        PUBLIC_KEY: Uint8Array;\n" +
					"    };\n" +
					"}) => {\n",
			},
		],
	},
] as const satisfies readonly StaticPatchTarget[];

export function managedBaileysCompatSnapshotRuntimes(input: {
	desiredRuntime: ManagedBaileysRuntime | null;
	home: string;
}): ManagedBaileysRuntime[] {
	const runtimes = new Set<ManagedBaileysRuntime>();
	if (input.desiredRuntime) runtimes.add(input.desiredRuntime);
	for (const runtime of ["openclaw", "hermes"] as const) {
		if (
			runtime !== input.desiredRuntime &&
			artifactContainsAfterHunk(resolveInstalledArtifact(runtime, input.home))
		) {
			runtimes.add(runtime);
		}
	}
	return [...runtimes];
}

export function managedBaileysCompatMutationTargets(input: {
	runtime: ManagedBaileysRuntime;
	home: string;
	appRoot: string;
}): string[] {
	const artifact = resolveArtifact(input);
	if (input.runtime === "hermes" && !existsSync(join(artifact.root, "package.json"))) {
		return [join(assertHermesBridgeRoot(artifact), "node_modules")];
	}
	const targets = artifact.targets.map((target) => join(artifact.root, target.relativePath));
	if (input.runtime === "hermes") {
		targets.push(join(assertHermesBridgeRoot(artifact), "node_modules", ".hermes-pkg-hash"));
	}
	return targets;
}

export function reconcileManagedBaileysCompatibility(input: {
	desiredRuntime: ManagedBaileysRuntime | null;
	home: string;
	appRoot?: string;
}): ManagedBaileysReconcileResult {
	if (input.desiredRuntime && !input.appRoot) {
		throw new Error(`managed WhatsApp ${input.desiredRuntime} artifact root is unavailable`);
	}
	const desiredArtifact =
		input.desiredRuntime && input.appRoot
			? resolveArtifact({
					runtime: input.desiredRuntime,
					home: input.home,
					appRoot: input.appRoot,
				})
			: null;
	let rolledBack = false;
	for (const runtime of ["openclaw", "hermes"] as const) {
		if (runtime === input.desiredRuntime) continue;
		const artifact = resolveInstalledArtifact(runtime, input.home);
		if (!artifactContainsAfterHunk(artifact)) continue;
		try {
			rolledBack = reconcileArtifact(artifact, "before") === "mutated" || rolledBack;
		} catch (error) {
			if (!input.desiredRuntime) {
				return { status: "rollback-refused", errors: [String(error)] };
			}
			throw error;
		}
	}
	if (!input.desiredRuntime) return { status: rolledBack ? "rolled-back" : "inert" };
	if (input.desiredRuntime === "hermes") {
		if (!input.appRoot) throw new Error("managed WhatsApp Hermes artifact root is unavailable");
		ensureHermesManagedBaileysDependencies(input.home, input.appRoot);
	}
	if (!desiredArtifact) throw new Error("managed WhatsApp compatibility artifact is unavailable");
	const result = reconcileArtifact(desiredArtifact, "after");
	if (desiredArtifact.runtime === "hermes") {
		writeHermesDependencyStamp(assertHermesBridgeRoot(desiredArtifact));
	}
	return { status: result === "mutated" ? "applied" : "already-patched" };
}

function reconcileArtifact(
	artifact: ManagedBaileysArtifact,
	desired: "before" | "after",
): "unchanged" | "mutated" {
	const targetStates = artifact.targets.map((target) => classifyTarget(artifact, target));
	const current = uniformArtifactState(artifact, targetStates);
	if (current === desired) return "unchanged";
	const packageIdentity = verifyArtifactIdentity(artifact, desired === "after");
	const plans = targetStates.map((state) => planTargetHunkMutation(state, desired));
	applyTargetPlans(plans, [{ path: packageIdentity.path, expectedSha256: packageIdentity.sha256 }]);
	return "mutated";
}

function ensureHermesManagedBaileysDependencies(home: string, appRoot: string): void {
	const expectedAppRoot = join(home, ".hermes", "hermes-agent");
	if (resolve(appRoot) !== resolve(expectedAppRoot)) {
		throw new Error(`managed WhatsApp Hermes app root must be ${expectedAppRoot}`);
	}
	const bridgeRoot = join(appRoot, "scripts", "whatsapp-bridge");
	const packagePath = join(
		bridgeRoot,
		"node_modules",
		"@whiskeysockets",
		"baileys",
		"package.json",
	);
	if (existsSync(packagePath)) return;
	for (const required of ["package.json", "package-lock.json"] as const) {
		if (!existsSync(join(bridgeRoot, required))) {
			throw new Error(`managed WhatsApp Hermes bridge is missing ${required}`);
		}
	}
	const managedNpm = join(home, ".local", "bin", "npm");
	const result = spawnRuntimeUserCommand(
		existsSync(managedNpm) ? managedNpm : "npm",
		["ci", "--ignore-scripts", "--silent"],
		home,
		bridgeRoot,
		{ timeoutMs: HERMES_BAILEYS_DEPENDENCY_INSTALL_TIMEOUT_MS },
	);
	if (result.status !== 0) {
		const detail = String(result.stderr || result.stdout || "npm ci failed")
			.trim()
			.slice(-1_000);
		throw new Error(`managed WhatsApp Hermes dependency install failed: ${detail}`);
	}
	if (!existsSync(packagePath)) {
		throw new Error("managed WhatsApp Hermes dependency install did not produce Baileys");
	}
}

function writeHermesDependencyStamp(bridgeRoot: string): void {
	const packageJson = join(bridgeRoot, "package.json");
	const stamp = join(bridgeRoot, "node_modules", ".hermes-pkg-hash");
	const content = `${sha256File(packageJson).slice(0, 16)}\n`;
	if (existsSync(stamp)) {
		if (!lstatSync(stamp).isFile() || realpathSync(stamp) !== resolve(stamp)) {
			throw new Error(`managed WhatsApp Hermes dependency stamp must be a real file: ${stamp}`);
		}
		if (readFileSync(stamp, "utf8") === content) return;
	}
	writePrivateFileAtomic(stamp, content, { mode: 0o644, dirMode: 0o755, durable: true });
	makeRuntimeUserOwned(stamp);
}

function resolveArtifact(input: {
	runtime: ManagedBaileysRuntime;
	home: string;
	appRoot: string;
}): ManagedBaileysArtifact {
	if (input.runtime === "openclaw") {
		const expectedAppRoot = join(input.home, ".openclaw");
		if (resolve(input.appRoot) !== resolve(expectedAppRoot)) {
			throw new Error(`managed WhatsApp OpenClaw app root must be ${expectedAppRoot}`);
		}
		return resolveInstalledArtifact("openclaw", input.home);
	}
	const expectedAppRoot = join(input.home, ".hermes", "hermes-agent");
	if (resolve(input.appRoot) !== resolve(expectedAppRoot)) {
		throw new Error(`managed WhatsApp Hermes app root must be ${expectedAppRoot}`);
	}
	return resolveInstalledArtifact("hermes", input.home);
}

function resolveInstalledArtifact(
	runtime: ManagedBaileysRuntime,
	home: string,
): ManagedBaileysArtifact {
	if (runtime === "openclaw") {
		return {
			runtime,
			root: join(home, ".openclaw", "extensions", "whatsapp", "node_modules", "baileys"),
			packageName: "baileys",
			targets: BAILEYS_TARGETS,
		};
	}
	const hermesBridgeRoot = join(home, ".hermes", "hermes-agent", "scripts", "whatsapp-bridge");
	return {
		runtime,
		root: join(hermesBridgeRoot, "node_modules", "@whiskeysockets", "baileys"),
		packageName: "@whiskeysockets/baileys",
		targets: BAILEYS_TARGETS,
		hermesBridgeRoot,
	};
}

function assertHermesBridgeRoot(artifact: ManagedBaileysArtifact): string {
	if (!artifact.hermesBridgeRoot) throw new Error("managed WhatsApp Hermes bridge root is missing");
	return artifact.hermesBridgeRoot;
}

function verifyArtifactIdentity(
	artifact: ManagedBaileysArtifact,
	requireCompatibleVersion: boolean,
): VerifiedPackageIdentity {
	assertTrustedRealDirectory(artifact.root);
	const packagePath = join(artifact.root, "package.json");
	assertTrustedRealFile(artifact.root, packagePath);
	const packageContent = readFileSync(packagePath, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(packageContent);
	} catch (error) {
		throw new Error(
			`managed WhatsApp compatibility could not read ${packagePath}: ${String(error)}`,
		);
	}
	const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	const name = record ? Reflect.get(record, "name") : null;
	const version = record ? Reflect.get(record, "version") : null;
	if (name !== artifact.packageName) {
		throw new Error(
			`managed WhatsApp compatibility requires package ${artifact.packageName}; found ${String(name)}`,
		);
	}
	if (
		requireCompatibleVersion &&
		(typeof version !== "string" || !isValidSemver(version) || !version.startsWith("7."))
	) {
		throw new Error(
			`managed WhatsApp compatibility requires valid Baileys SemVer major 7; found ${String(version)}`,
		);
	}
	return { path: packagePath, sha256: sha256String(packageContent) };
}

type HunkState = "before" | "after" | "predecessor" | "unknown";

interface ClassifiedHunk {
	hunk: StrictContextHunk;
	state: HunkState;
	beforeMatches: number[];
	afterMatches: number[];
	predecessorMatches: { content: string; offsets: number[] }[];
}

interface ClassifiedTarget {
	target: StaticPatchTarget;
	path: string;
	content: string;
	sha256: string;
	hunks: ClassifiedHunk[];
}

interface TargetMutationPlan {
	state: ClassifiedTarget;
	content: string;
	observedBeforeSha256: string;
	observedAfterSha256: string;
}

function artifactContainsAfterHunk(artifact: ManagedBaileysArtifact): boolean {
	for (const target of artifact.targets) {
		const path = join(artifact.root, target.relativePath);
		try {
			if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path)) continue;
			const content = readFileSync(path, "utf8");
			if (target.hunks.some((hunk) => exactMatchOffsets(content, hunk.after).length > 0)) {
				return true;
			}
		} catch {
			// Passive cleanup stays inert unless managed patch content is positively identified.
		}
	}
	return false;
}

function classifyTarget(
	artifact: ManagedBaileysArtifact,
	target: StaticPatchTarget,
): ClassifiedTarget {
	const path = join(artifact.root, target.relativePath);
	if (!existsSync(path)) {
		throw new Error(`managed WhatsApp compatibility artifact is missing ${path}`);
	}
	assertTrustedRealFile(artifact.root, path);
	const content = readFileSync(path, "utf8");
	return {
		target,
		path,
		content,
		sha256: sha256String(content),
		hunks: target.hunks.map((hunk) => classifyHunk(content, hunk)),
	};
}

function classifyHunk(content: string, hunk: StrictContextHunk): ClassifiedHunk {
	const beforeMatches = exactMatchOffsets(content, hunk.before);
	const afterMatches = exactMatchOffsets(content, hunk.after);
	const predecessorMatches = (hunk.predecessors ?? []).map((predecessor) => ({
		content: predecessor,
		offsets: exactMatchOffsets(content, predecessor),
	}));
	const predecessorMatchCount = predecessorMatches.reduce(
		(count, predecessor) => count + predecessor.offsets.length,
		0,
	);
	return {
		hunk,
		beforeMatches,
		afterMatches,
		predecessorMatches,
		state:
			beforeMatches.length === 1 && afterMatches.length === 0 && predecessorMatchCount === 0
				? "before"
				: beforeMatches.length === 0 && afterMatches.length === 1 && predecessorMatchCount === 0
					? "after"
					: beforeMatches.length === 0 && afterMatches.length === 0 && predecessorMatchCount === 1
						? "predecessor"
						: "unknown",
	};
}

function exactMatchOffsets(content: string, needle: string): number[] {
	const offsets: number[] = [];
	let offset = 0;
	while (offset <= content.length - needle.length) {
		const match = content.indexOf(needle, offset);
		if (match < 0) break;
		offsets.push(match);
		offset = match + 1;
	}
	return offsets;
}

function uniformArtifactState(
	artifact: ManagedBaileysArtifact,
	states: ClassifiedTarget[],
): Exclude<HunkState, "unknown"> {
	const unknown = states.flatMap((target) =>
		target.hunks.flatMap((hunk) =>
			hunk.state === "unknown"
				? [
						`${target.path}#${hunk.hunk.id} (before=${hunk.beforeMatches.length}, after=${hunk.afterMatches.length}, predecessor=${hunk.predecessorMatches.reduce((count, predecessor) => count + predecessor.offsets.length, 0)})`,
					]
				: [],
		),
	);
	if (unknown.length > 0) {
		throw new Error(
			`managed WhatsApp compatibility patch refused non-unique or changed ${artifact.runtime} hunks: ${unknown.join(", ")}`,
		);
	}
	const recognized = states.flatMap((target) => target.hunks);
	if (recognized.every((hunk) => hunk.state === "before")) return "before";
	if (recognized.every((hunk) => hunk.state === "after")) return "after";
	if (
		recognized.every((hunk) =>
			hunk.hunk.predecessors ? hunk.state === "predecessor" : hunk.state === "after",
		)
	) {
		return "predecessor";
	}
	throw new Error(`managed WhatsApp compatibility patch refused mixed ${artifact.runtime} hunks`);
}

function planTargetHunkMutation(
	state: ClassifiedTarget,
	desired: Exclude<HunkState, "unknown">,
): TargetMutationPlan {
	const edits = state.hunks.flatMap((hunk) => {
		if (hunk.state === desired) return [];
		if (hunk.state === "unknown") {
			throw new Error(`managed WhatsApp patch cannot mutate unknown hunk ${hunk.hunk.id}`);
		}
		const predecessor = hunk.predecessorMatches.find((candidate) => candidate.offsets.length === 1);
		const source =
			hunk.state === "before"
				? hunk.hunk.before
				: hunk.state === "after"
					? hunk.hunk.after
					: predecessor?.content;
		if (!source) throw new Error(`managed WhatsApp predecessor hunk ${hunk.hunk.id} is missing`);
		const replacement = desired === "after" ? hunk.hunk.after : hunk.hunk.before;
		const offsets =
			hunk.state === "before"
				? hunk.beforeMatches
				: hunk.state === "after"
					? hunk.afterMatches
					: (predecessor?.offsets ?? []);
		const offset = offsets[0];
		if (offset === undefined) throw new Error(`managed WhatsApp hunk ${hunk.hunk.id} is missing`);
		return [{ id: hunk.hunk.id, offset, source, replacement }];
	});
	const ordered = [...edits].sort((left, right) => left.offset - right.offset);
	for (let index = 1; index < ordered.length; index += 1) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (previous && current && previous.offset + previous.source.length > current.offset) {
			throw new Error(`managed WhatsApp patch hunks overlap: ${previous.id} and ${current.id}`);
		}
	}
	let content = state.content;
	for (const edit of ordered.reverse()) {
		content = `${content.slice(0, edit.offset)}${edit.replacement}${content.slice(edit.offset + edit.source.length)}`;
	}
	for (const hunk of state.hunks) {
		const result = classifyHunk(content, hunk.hunk);
		if (result.state !== desired) {
			throw new Error(`managed WhatsApp hunk mutation verification failed for ${hunk.hunk.id}`);
		}
	}
	return {
		state,
		content,
		observedBeforeSha256: state.sha256,
		observedAfterSha256: sha256String(content),
	};
}

function applyTargetPlans(
	plans: TargetMutationPlan[],
	additionalAuditedStates: readonly { path: string; expectedSha256: string }[] = [],
): void {
	const entries = plans.flatMap((plan) =>
		plan.content === plan.state.content
			? []
			: [
					{
						path: plan.state.path,
						expectedSha256: plan.observedBeforeSha256,
						content: plan.content,
					},
				],
	);
	replaceTargetContents(entries, [
		...additionalAuditedStates,
		...plans.map((plan) => ({
			path: plan.state.path,
			expectedSha256: plan.observedBeforeSha256,
		})),
	]);
	for (const plan of plans) {
		if (sha256File(plan.state.path) !== plan.observedAfterSha256) {
			throw new Error(`managed WhatsApp compatibility verification failed for ${plan.state.path}`);
		}
	}
}

function replaceTargetContents(
	entries: readonly { path: string; expectedSha256: string; content: string }[],
	auditedStates: readonly { path: string; expectedSha256: string }[] = entries,
): void {
	for (const entry of auditedStates) {
		if (sha256File(entry.path) !== entry.expectedSha256) {
			throw new Error(
				`managed WhatsApp compatibility artifact changed during reconcile: ${entry.path}`,
			);
		}
	}
	for (const entry of entries) {
		writePrivateFileAtomic(entry.path, entry.content, {
			mode: statSync(entry.path).mode & 0o777,
			durable: true,
		});
		makeRuntimeUserOwned(entry.path);
	}
}

function assertTrustedRealDirectory(path: string): void {
	if (!lstatSync(path).isDirectory() || realpathSync(path) !== resolve(path)) {
		throw new Error(`managed WhatsApp compatibility root must be a real directory: ${path}`);
	}
}

function assertTrustedRealFile(root: string, path: string): void {
	const relativePath = relative(resolve(root), resolve(path));
	if (!relativePath || relativePath.startsWith("..")) {
		throw new Error(`managed WhatsApp compatibility target is outside artifact root: ${path}`);
	}
	if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path)) {
		throw new Error(`managed WhatsApp compatibility target must be a real file: ${path}`);
	}
}

function sha256File(path: string): string {
	const descriptor = openSync(path, "r");
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		let count = 0;
		do {
			count = readSync(descriptor, buffer, 0, buffer.length, null);
			if (count > 0) hash.update(buffer.subarray(0, count));
		} while (count > 0);
	} finally {
		closeSync(descriptor);
	}
	return hash.digest("hex");
}

function sha256String(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export const MANAGED_BAILEYS_STATIC_PATCH_TARGETS = BAILEYS_TARGETS;
