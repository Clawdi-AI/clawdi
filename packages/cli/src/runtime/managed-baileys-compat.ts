import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isValidSemver } from "../lib/semver";
import type { RuntimePaths } from "./paths";
import { makeRuntimeUserOwned, spawnRuntimeUserCommand } from "./runtime-user-command";

export const MANAGED_BAILEYS_PATCH_REVISION = "clawdi.managedBaileysCompat.v3";

const BAILEYS_COMPATIBLE_MAJOR = 7;
const RECEIPT_FILE = "managed-baileys-compat.json";
const RECEIPT_SCHEMA = "clawdi.managedBaileysPatchReceipt.v4";

export type ManagedBaileysRuntime = "openclaw" | "hermes";

interface StrictContextHunk {
	id: string;
	before: string;
	after: string;
}

interface StaticPatchTarget {
	relativePath: string;
	auditPristineSha256: string;
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
	version: string;
	path: string;
	sha256: string;
}

interface ManagedBaileysPatchReceiptTarget {
	relativePath: string;
	observedBeforeSha256: string;
	observedAfterSha256: string;
	ownedHunkIds: string[];
}

interface ManagedBaileysPatchReceiptArtifact {
	runtime: ManagedBaileysRuntime;
	artifactRoot: string;
	baileys: {
		name: string;
		observedVersion: string;
		compatibleMajor: typeof BAILEYS_COMPATIBLE_MAJOR;
	};
	targets: ManagedBaileysPatchReceiptTarget[];
}

interface ManagedBaileysPatchReceipt {
	schemaVersion: typeof RECEIPT_SCHEMA;
	patchRevision: typeof MANAGED_BAILEYS_PATCH_REVISION;
	artifact: ManagedBaileysPatchReceiptArtifact;
}

type ManagedBaileysReconcileResult =
	| { status: "inert"; receiptPath: string }
	| { status: "compatible"; receiptPath: string }
	| { status: "already-patched"; receiptPath: string }
	| { status: "applied"; receiptPath: string }
	| { status: "rolled-back"; receiptPath: string }
	| { status: "rollback-refused"; receiptPath: string; errors: string[] };

const BAILEYS_TARGETS = [
	{
		relativePath: "lib/Socket/socket.js",
		auditPristineSha256: "ab9b68888e123ad683dbc26555fc928400c1526c93ec6b66853f2ba30f8177a9",
		hunks: [
			{
				id: "socket.default-connection-config-import.v1",
				before:
					"import { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, NOISE_WA_HEADER, PROCESSABLE_HISTORY_TYPES, TimeMs, UPLOAD_TIMEOUT } from '../Defaults/index.js';\n",
				after:
					"import { DEFAULT_CONNECTION_CONFIG, DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, NOISE_WA_HEADER, PROCESSABLE_HISTORY_TYPES, TimeMs, UPLOAD_TIMEOUT } from '../Defaults/index.js';\n",
			},
			{
				id: "socket.managed-metadata-validator.v1",
				before:
					"import { executeWMexQuery } from './mex.js';\n" +
					"/**\n" +
					" * Connects to WA servers and performs:\n",
				after:
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
				id: "socket.managed-noise-and-upgrade.v1",
				before:
					"        routingInfo: authState?.creds?.routingInfo\n" +
					"    });\n" +
					"    const ws = new WebSocketClient(url, config);\n",
				after:
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
			},
		],
	},
	{
		relativePath: "lib/Utils/noise-handler.js",
		auditPristineSha256: "970f9526ce0e5a6bebf937328b3d835966a9282c0d232f31b5c0bb283531afe8",
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
		auditPristineSha256: "a556ca0b67c3448769ad5ed0d59acbf566a21115fa107cd582b1dcb28c4fd516",
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

export function managedBaileysCompatReceiptPath(
	paths: Pick<RuntimePaths, "installInventory">,
): string {
	return join(paths.installInventory, RECEIPT_FILE);
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
	paths: Pick<RuntimePaths, "installInventory">;
}): ManagedBaileysReconcileResult {
	const receiptPath = managedBaileysCompatReceiptPath(input.paths);
	if (!input.desiredRuntime) return rollbackManagedBaileysCompatibility(receiptPath, input.home);
	if (!input.appRoot) {
		throw new Error(`managed WhatsApp ${input.desiredRuntime} artifact root is unavailable`);
	}
	if (input.desiredRuntime === "hermes") {
		ensureHermesManagedBaileysDependencies(input.home, input.appRoot);
	}
	const artifact = resolveArtifact({
		runtime: input.desiredRuntime,
		home: input.home,
		appRoot: input.appRoot,
	});
	const packageIdentity = verifyArtifactIdentity(artifact);
	const observedVersion = packageIdentity.version;
	const targetStates = artifact.targets.map((target) => classifyTarget(artifact, target));
	assertRecognizedTargets(artifact, targetStates);

	let existingReceipt = readReceipt(receiptPath);
	if (existingReceipt && !receiptLayoutMatches(existingReceipt.artifact, artifact)) {
		const rollback = rollbackManagedBaileysCompatibility(receiptPath, input.home);
		if (rollback.status === "rollback-refused") {
			throw new Error(
				`managed WhatsApp compatibility could not recover the previous artifact: ${rollback.errors.join(", ")}`,
			);
		}
		existingReceipt = null;
	}

	const allHunks = targetStates.flatMap((target) => target.hunks);
	if (!existingReceipt) {
		if (allHunks.every((hunk) => hunk.state === "after")) {
			if (artifact.runtime === "hermes") {
				writeHermesDependencyStamp(assertHermesBridgeRoot(artifact));
			}
			return { status: "compatible", receiptPath };
		}
		if (!allHunks.every((hunk) => hunk.state === "before")) {
			throw new Error(
				`managed WhatsApp compatibility refused mixed before/after hunks without an ownership receipt for ${artifact.runtime}`,
			);
		}
	}

	const versionChanged = existingReceipt
		? existingReceipt.artifact.baileys.observedVersion !== observedVersion
		: false;
	const beforeHunks = allHunks.filter((hunk) => hunk.state === "before");
	if (existingReceipt && versionChanged && beforeHunks.length === 0) {
		removeReceiptDurable(receiptPath);
		if (artifact.runtime === "hermes") {
			writeHermesDependencyStamp(assertHermesBridgeRoot(artifact));
		}
		return { status: "compatible", receiptPath };
	}
	if (existingReceipt && beforeHunks.length === 0) {
		if (artifact.runtime === "hermes") {
			writeHermesDependencyStamp(assertHermesBridgeRoot(artifact));
		}
		return { status: "already-patched", receiptPath };
	}

	const ownedHunks = ownedHunksForApply(targetStates, existingReceipt, versionChanged);
	const plans = targetStates.map((state) =>
		planTargetHunkMutation(
			state,
			new Set(state.hunks.filter((hunk) => hunk.state === "before").map((hunk) => hunk.hunk.id)),
			"after",
		),
	);
	const receipt = buildReceipt(artifact, observedVersion, plans, ownedHunks);
	writeReceiptDurable(receiptPath, receipt);
	applyTargetPlans(plans, [{ path: packageIdentity.path, expectedSha256: packageIdentity.sha256 }]);
	if (artifact.runtime === "hermes") writeHermesDependencyStamp(assertHermesBridgeRoot(artifact));
	return { status: "applied", receiptPath };
}

function rollbackManagedBaileysCompatibility(
	receiptPath: string,
	home: string,
): ManagedBaileysReconcileResult {
	const receipt = readReceipt(receiptPath);
	if (!receipt) return { status: "inert", receiptPath };
	const artifact = resolveInstalledArtifact(receipt.artifact.runtime, home);
	const errors: string[] = [];
	if (!receiptLayoutMatches(receipt.artifact, artifact)) {
		errors.push("managed WhatsApp compatibility receipt does not match the audited artifact");
	} else if (directoryEntryExists(artifact.root)) {
		let packageIdentity: VerifiedPackageIdentity | null = null;
		try {
			packageIdentity = verifyArtifactIdentity(artifact);
		} catch (error) {
			errors.push(String(error));
		}
		const targetStates: ClassifiedTarget[] = [];
		if (errors.length === 0) {
			for (const target of artifact.targets) {
				try {
					targetStates.push(classifyTarget(artifact, target));
				} catch (error) {
					errors.push(String(error));
				}
			}
		}
		if (errors.length === 0) {
			try {
				assertRecognizedTargets(artifact, targetStates);
			} catch (error) {
				errors.push(String(error));
			}
		}
		if (errors.length > 0) return { status: "rollback-refused", receiptPath, errors };
		if (packageIdentity?.version === receipt.artifact.baileys.observedVersion) {
			const receiptTargets = new Map(
				receipt.artifact.targets.map((target) => [target.relativePath, target]),
			);
			const plans = targetStates.map((state) => {
				const receiptTarget = receiptTargets.get(state.target.relativePath);
				if (!receiptTarget) throw new Error("managed WhatsApp receipt target is missing");
				return planTargetHunkMutation(state, new Set(receiptTarget.ownedHunkIds), "before");
			});
			applyTargetPlans(plans, [
				{ path: packageIdentity.path, expectedSha256: packageIdentity.sha256 },
			]);
		}
	}
	removeReceiptDurable(receiptPath);
	return { status: "rolled-back", receiptPath };
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
		{ timeoutMs: 300_000 },
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
	writeDurableAtomic(stamp, content, 0o644, 0o755);
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

function verifyArtifactIdentity(artifact: ManagedBaileysArtifact): VerifiedPackageIdentity {
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
	if (typeof version !== "string" || !isValidSemver(version) || !version.startsWith("7.")) {
		throw new Error(
			`managed WhatsApp compatibility requires valid Baileys SemVer major 7; found ${String(version)}`,
		);
	}
	return { version, path: packagePath, sha256: sha256String(packageContent) };
}

type HunkState = "before" | "after" | "unknown";

interface ClassifiedHunk {
	hunk: StrictContextHunk;
	state: HunkState;
	beforeMatches: number[];
	afterMatches: number[];
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
	return {
		hunk,
		beforeMatches,
		afterMatches,
		state:
			beforeMatches.length === 1 && afterMatches.length === 0
				? "before"
				: beforeMatches.length === 0 && afterMatches.length === 1
					? "after"
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

function assertRecognizedTargets(
	artifact: ManagedBaileysArtifact,
	states: ClassifiedTarget[],
): void {
	const unknown = states.flatMap((target) =>
		target.hunks.flatMap((hunk) =>
			hunk.state === "unknown"
				? [
						`${target.path}#${hunk.hunk.id} (before=${hunk.beforeMatches.length}, after=${hunk.afterMatches.length})`,
					]
				: [],
		),
	);
	if (unknown.length > 0) {
		throw new Error(
			`managed WhatsApp compatibility patch refused non-unique or changed ${artifact.runtime} hunks: ${unknown.join(", ")}`,
		);
	}
}

function ownedHunksForApply(
	states: ClassifiedTarget[],
	existingReceipt: ManagedBaileysPatchReceipt | null,
	versionChanged: boolean,
): Map<string, Set<string>> {
	const receiptTargets = new Map(
		(existingReceipt?.artifact.targets ?? []).map((target) => [target.relativePath, target]),
	);
	return new Map(
		states.map((state) => {
			const owned = new Set<string>();
			if (!versionChanged) {
				for (const id of receiptTargets.get(state.target.relativePath)?.ownedHunkIds ?? []) {
					owned.add(id);
				}
			}
			for (const hunk of state.hunks) {
				if (hunk.state === "before") owned.add(hunk.hunk.id);
			}
			return [state.target.relativePath, owned];
		}),
	);
}

function planTargetHunkMutation(
	state: ClassifiedTarget,
	selectedHunkIds: ReadonlySet<string>,
	desired: Exclude<HunkState, "unknown">,
): TargetMutationPlan {
	const knownIds = new Set(state.hunks.map((hunk) => hunk.hunk.id));
	for (const id of selectedHunkIds) {
		if (!knownIds.has(id)) throw new Error(`managed WhatsApp patch references unknown hunk ${id}`);
	}
	const edits = state.hunks.flatMap((hunk) => {
		if (!selectedHunkIds.has(hunk.hunk.id) || hunk.state === desired) return [];
		if (hunk.state === "unknown") {
			throw new Error(`managed WhatsApp patch cannot mutate unknown hunk ${hunk.hunk.id}`);
		}
		const source = hunk.state === "before" ? hunk.hunk.before : hunk.hunk.after;
		const replacement = desired === "after" ? hunk.hunk.after : hunk.hunk.before;
		const offsets = hunk.state === "before" ? hunk.beforeMatches : hunk.afterMatches;
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
		const expected = selectedHunkIds.has(hunk.hunk.id) ? desired : hunk.state;
		if (result.state !== expected) {
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

function stageReplacement(path: string, content: string): string {
	const stagingPath = join(dirname(path), `.${basename(path)}.clawdi-stage-${randomUUID()}`);
	const mode = statSync(path).mode & 0o777;
	let descriptor: number | null = null;
	try {
		descriptor = openSync(stagingPath, "wx", mode);
		const bytes = Buffer.from(content);
		let offset = 0;
		while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = null;
		chmodSync(stagingPath, mode);
		makeRuntimeUserOwned(stagingPath);
		return stagingPath;
	} catch (error) {
		rmSync(stagingPath, { force: true });
		throw error;
	} finally {
		if (descriptor !== null) closeSync(descriptor);
	}
}

function replaceTargetContents(
	entries: readonly { path: string; expectedSha256: string; content: string }[],
	auditedStates: readonly { path: string; expectedSha256: string }[] = entries,
): void {
	const staged: Array<(typeof entries)[number] & { stagingPath: string }> = [];
	try {
		for (const entry of entries) {
			staged.push({ ...entry, stagingPath: stageReplacement(entry.path, entry.content) });
		}
		for (const entry of auditedStates) {
			if (sha256File(entry.path) !== entry.expectedSha256) {
				throw new Error(
					`managed WhatsApp compatibility artifact changed during reconcile: ${entry.path}`,
				);
			}
		}
		for (const entry of staged) {
			renameSync(entry.stagingPath, entry.path);
			makeRuntimeUserOwned(entry.path);
			fsyncDirectory(dirname(entry.path));
		}
	} finally {
		for (const entry of staged) rmSync(entry.stagingPath, { force: true });
	}
}

function writeReceiptDurable(path: string, receipt: ManagedBaileysPatchReceipt): void {
	writeDurableAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`, 0o600, 0o755);
}

function writeDurableAtomic(path: string, content: string, mode: number, dirMode: number): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: dirMode });
	const stagingPath = join(directory, `.${basename(path)}.clawdi-stage-${randomUUID()}`);
	let descriptor: number | null = null;
	try {
		descriptor = openSync(stagingPath, "wx", mode);
		const bytes = Buffer.from(content);
		let offset = 0;
		while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = null;
		chmodSync(stagingPath, mode);
		renameSync(stagingPath, path);
		fsyncDirectory(directory);
	} finally {
		if (descriptor !== null) closeSync(descriptor);
		rmSync(stagingPath, { force: true });
	}
}

function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
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

function buildReceipt(
	artifact: ManagedBaileysArtifact,
	observedVersion: string,
	plans: TargetMutationPlan[],
	ownedHunks: ReadonlyMap<string, ReadonlySet<string>>,
): ManagedBaileysPatchReceipt {
	const planByPath = new Map(plans.map((plan) => [plan.state.target.relativePath, plan]));
	return {
		schemaVersion: RECEIPT_SCHEMA,
		patchRevision: MANAGED_BAILEYS_PATCH_REVISION,
		artifact: {
			runtime: artifact.runtime,
			artifactRoot: artifact.root,
			baileys: {
				name: artifact.packageName,
				observedVersion,
				compatibleMajor: BAILEYS_COMPATIBLE_MAJOR,
			},
			targets: artifact.targets.map((target) => {
				const plan = planByPath.get(target.relativePath);
				if (!plan) throw new Error(`managed WhatsApp patch plan is missing ${target.relativePath}`);
				const owned = ownedHunks.get(target.relativePath) ?? new Set<string>();
				return {
					relativePath: target.relativePath,
					observedBeforeSha256: plan.observedBeforeSha256,
					observedAfterSha256: plan.observedAfterSha256,
					ownedHunkIds: target.hunks.map((hunk) => hunk.id).filter((id) => owned.has(id)),
				};
			}),
		},
	};
}

function receiptLayoutMatches(
	receipt: ManagedBaileysPatchReceiptArtifact | undefined,
	artifact: ManagedBaileysArtifact,
): boolean {
	if (
		!receipt ||
		receipt.runtime !== artifact.runtime ||
		receipt.artifactRoot !== artifact.root ||
		receipt.baileys.name !== artifact.packageName ||
		receipt.baileys.compatibleMajor !== BAILEYS_COMPATIBLE_MAJOR
	) {
		return false;
	}
	if (receipt.targets.length !== artifact.targets.length) return false;
	return receipt.targets.every((target, index) => {
		const expected = artifact.targets[index];
		if (!expected || target.relativePath !== expected.relativePath) return false;
		const knownHunks = new Set(expected.hunks.map((hunk) => hunk.id));
		return target.ownedHunkIds.every((id) => knownHunks.has(id));
	});
}

function readReceipt(path: string): ManagedBaileysPatchReceipt | null {
	if (!existsSync(path)) return null;
	try {
		if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path)) {
			throw new Error("receipt must be a real file");
		}
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		const record = recordValue(value);
		if (!record || !hasExactKeys(record, ["artifact", "patchRevision", "schemaVersion"])) {
			throw new Error("receipt root is invalid");
		}
		if (
			record.schemaVersion !== RECEIPT_SCHEMA ||
			record.patchRevision !== MANAGED_BAILEYS_PATCH_REVISION
		) {
			throw new Error("unknown receipt schema or patch revision");
		}
		const artifact = recordValue(record.artifact);
		const baileys = recordValue(artifact?.baileys);
		const targets = artifact?.targets;
		if (
			!artifact ||
			!hasExactKeys(artifact, ["artifactRoot", "baileys", "runtime", "targets"]) ||
			(artifact.runtime !== "openclaw" && artifact.runtime !== "hermes") ||
			typeof artifact.artifactRoot !== "string" ||
			!baileys ||
			!hasExactKeys(baileys, ["compatibleMajor", "name", "observedVersion"]) ||
			typeof baileys.name !== "string" ||
			typeof baileys.observedVersion !== "string" ||
			!isValidSemver(baileys.observedVersion) ||
			!baileys.observedVersion.startsWith("7.") ||
			baileys.compatibleMajor !== BAILEYS_COMPATIBLE_MAJOR ||
			!Array.isArray(targets) ||
			targets.length === 0
		) {
			throw new Error("receipt artifact set is invalid");
		}
		let ownsAnyHunk = false;
		const relativePaths = new Set<string>();
		for (const targetValue of targets) {
			const target = recordValue(targetValue);
			if (
				!target ||
				!hasExactKeys(target, [
					"observedAfterSha256",
					"observedBeforeSha256",
					"ownedHunkIds",
					"relativePath",
				]) ||
				typeof target.relativePath !== "string" ||
				relativePaths.has(target.relativePath) ||
				!isSha256(target.observedBeforeSha256) ||
				!isSha256(target.observedAfterSha256) ||
				!Array.isArray(target.ownedHunkIds)
			) {
				throw new Error("receipt target is invalid");
			}
			relativePaths.add(target.relativePath);
			const hunkIds = new Set<string>();
			for (const hunkId of target.ownedHunkIds) {
				if (typeof hunkId !== "string" || !hunkId || hunkIds.has(hunkId)) {
					throw new Error("receipt owned hunk id is invalid");
				}
				hunkIds.add(hunkId);
				ownsAnyHunk = true;
			}
		}
		if (!ownsAnyHunk) throw new Error("receipt owns no compatibility hunks");
		return value as ManagedBaileysPatchReceipt;
	} catch (error) {
		throw new Error(`managed WhatsApp compatibility receipt is invalid: ${String(error)}`);
	}
}

function removeReceiptDurable(path: string): void {
	rmSync(path, { force: true });
	fsyncDirectory(dirname(path));
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function directoryEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return false;
		throw error;
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
