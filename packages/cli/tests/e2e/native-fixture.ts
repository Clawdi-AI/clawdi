import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	NATIVE_TARGETS,
	type NativeTarget,
	nativeAssetName,
} from "../../src/lib/native-release-manifest";
import { isValidSemver } from "../../src/lib/semver";

export interface NativeReleaseFixture {
	directory: string;
	version: string;
	target: NativeTarget;
}

export interface NativeInstallResult {
	code: number;
	stdout: string;
	stderr: string;
	curlLog: string;
}

export interface NativeInstallerInput {
	fixture: NativeReleaseFixture;
	prefix: string;
	home: string;
	clawdiHome: string;
	testRoot: string;
	exactVersion?: boolean;
	shadowClawdi?: boolean;
	artifactDelaySeconds?: number;
}

export function configuredNativeBinary(): string | null {
	const configured = process.env.CLAWDI_NATIVE_BINARY;
	return configured ? realpathSync(configured) : null;
}

export function readNativeIdentity(binary: string): { version: string; target: NativeTarget } {
	const result = spawnSync(binary, ["update", "--native-identity"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`native identity failed: ${result.stderr}`);
	const [version, target] = result.stdout.trim().split("\t");
	if (!version || !target || !(NATIVE_TARGETS as readonly string[]).includes(target)) {
		throw new Error(`invalid native identity output: ${result.stdout}`);
	}
	return { version, target: target as NativeTarget };
}

export function deriveNativeVersion(source: string, destination: string, version: string): void {
	const current = readNativeIdentity(source);
	if (version.length !== current.version.length) {
		throw new Error("derived native fixture version must preserve the compiled string length");
	}
	const bytes = readFileSync(source);
	const before = Buffer.from(current.version);
	const after = Buffer.from(version);
	let offset = 0;
	let replacements = 0;
	while (true) {
		offset = bytes.indexOf(before, offset);
		if (offset === -1) break;
		after.copy(bytes, offset);
		offset += before.length;
		replacements += 1;
	}
	if (replacements !== 3) {
		throw new Error(`expected three compiled version strings, found ${replacements}`);
	}
	writeFileSync(destination, bytes, { mode: 0o755 });
	const versionResult = spawnSync(destination, ["--version"], { encoding: "utf8" });
	if (versionResult.status !== 0 || versionResult.stdout.trim() !== version) {
		throw new Error(`derived native version smoke failed: ${versionResult.stderr}`);
	}
	const identity = readNativeIdentity(destination);
	if (identity.version !== version || identity.target !== current.target) {
		throw new Error("derived native identity does not match the requested fixture");
	}
}

export function derivedNativeFixtureVersions(current: string, count: number): string[] {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(.*)$/.exec(current);
	if (!match) throw new Error(`cannot derive native fixture versions from ${current}`);
	const [, major, minor, patch, suffix] = match;
	if (major === undefined || minor === undefined || patch === undefined || suffix === undefined) {
		throw new Error(`cannot derive native fixture versions from ${current}`);
	}
	const versions: string[] = [];
	for (let index = 0; index < patch.length && versions.length < count; index += 1) {
		for (const digit of "0123456789") {
			if (digit === patch[index] || (index === 0 && patch.length > 1 && digit === "0")) continue;
			const candidatePatch = `${patch.slice(0, index)}${digit}${patch.slice(index + 1)}`;
			const candidate = `${major}.${minor}.${candidatePatch}${suffix}`;
			if (candidate.length === current.length && isValidSemver(candidate)) versions.push(candidate);
			if (versions.length === count) return versions;
		}
	}
	throw new Error(`could not derive ${count} equal-length native fixture versions from ${current}`);
}

export function createNativeReleaseFixture(input: {
	root: string;
	binary: string;
	resourceRoot: string;
	version?: string;
}): NativeReleaseFixture {
	const identity = readNativeIdentity(input.binary);
	const version = input.version ?? identity.version;
	if (version !== identity.version)
		throw new Error("fixture version must match its binary identity");
	const directory = join(input.root, `release-${version}`);
	const payload = join(directory, "payload");
	mkdirSync(payload, { recursive: true });
	cpSync(input.binary, join(payload, "clawdi"));
	chmodSync(join(payload, "clawdi"), 0o755);
	cpSync(join(input.resourceRoot, "egress-addon"), join(payload, "egress-addon"), {
		recursive: true,
	});
	cpSync(join(input.resourceRoot, "skills"), join(payload, "skills"), { recursive: true });
	const asset = nativeAssetName(identity.target);
	run("tar", ["-czf", join(directory, asset), "-C", payload, "clawdi", "egress-addon", "skills"]);
	writeManifest(directory, version, identity.target);
	return { directory, version, target: identity.target };
}

export function rewriteNativeReleaseManifest(fixture: NativeReleaseFixture): void {
	writeManifest(fixture.directory, fixture.version, fixture.target);
}

export function runNativeInstaller(input: NativeInstallerInput): NativeInstallResult {
	const invocation = prepareNativeInstaller(input);
	const result = spawnSync("sh", [invocation.script], {
		env: invocation.env,
		encoding: "utf8",
	});
	return {
		code: result.status ?? 1,
		stdout: result.stdout,
		stderr: result.stderr,
		curlLog: readFileSync(invocation.curlLog, "utf8"),
	};
}

export async function runNativeInstallerAsync(
	input: NativeInstallerInput,
): Promise<NativeInstallResult> {
	const invocation = prepareNativeInstaller(input);
	const child = Bun.spawn(["sh", invocation.script], {
		env: invocation.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr, curlLog: readFileSync(invocation.curlLog, "utf8") };
}

function prepareNativeInstaller(input: NativeInstallerInput) {
	const fakeBin = join(input.testRoot, `curl-${input.fixture.version}-${crypto.randomUUID()}`);
	const curlLog = join(fakeBin, "curl.log");
	mkdirSync(fakeBin, { recursive: true });
	writeFileSync(
		join(fakeBin, "curl"),
		`#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    --proto|--proto-redir|--connect-timeout|--max-time|--max-filesize) shift 2 ;;
    -fsSL|--tlsv1.2) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */-/package/clawdi/dist-tags) printf '{"latest":"%s","beta":"%s"}\\n' "$FAKE_VERSION" "$FAKE_VERSION" > "$output" ;;
  */clawdi-cli-manifest.txt) cp "$FAKE_RELEASE_DIR/clawdi-cli-manifest.txt" "$output" ;;
  */clawdi-cli-*.tar.gz)
    if [ -n "$FAKE_ARTIFACT_DELAY" ]; then sleep "$FAKE_ARTIFACT_DELAY"; fi
    cp "$FAKE_RELEASE_DIR/\${url##*/}" "$output"
    ;;
  *) printf 'unexpected URL: %s\\n' "$url" >&2; exit 22 ;;
esac
`,
		{ mode: 0o755 },
	);
	chmodSync(join(fakeBin, "curl"), 0o755);
	if (input.shadowClawdi) {
		writeFileSync(join(fakeBin, "clawdi"), "#!/bin/sh\nprintf 'legacy\\n'\n", { mode: 0o755 });
		chmodSync(join(fakeBin, "clawdi"), 0o755);
	}
	const { SUDO_USER: _sudoUser, CLAWDI_VERSION: _version, ...baseEnv } = process.env;
	const env = {
		...baseEnv,
		CLAWDI_HOME: input.clawdiHome,
		CLAWDI_INSTALL_PREFIX: input.prefix,
		FAKE_CURL_LOG: curlLog,
		FAKE_ARTIFACT_DELAY: input.artifactDelaySeconds?.toString() ?? "",
		FAKE_RELEASE_DIR: input.fixture.directory,
		FAKE_VERSION: input.fixture.version,
		HOME: input.home,
		NO_COLOR: "1",
		PATH: `${fakeBin}:${input.prefix}/bin:${process.env.PATH ?? ""}`,
		...(input.exactVersion === false ? {} : { CLAWDI_VERSION: input.fixture.version }),
	};
	return { curlLog, env, script: resolve(import.meta.dir, "../../../../install.sh") };
}

function writeManifest(directory: string, version: string, selected: NativeTarget): void {
	const selectedAsset = nativeAssetName(selected);
	const selectedSha = createHash("sha256")
		.update(readFileSync(join(directory, selectedAsset)))
		.digest("hex");
	writeFileSync(
		join(directory, "clawdi-cli-manifest.txt"),
		[
			"clawdi.nativeRelease.v1",
			`version\t${version}`,
			...NATIVE_TARGETS.map((target, index) => {
				const sha = target === selected ? selectedSha : String(index).repeat(64);
				return `artifact\t${target}\t${nativeAssetName(target)}\t${sha}`;
			}),
			"",
		].join("\n"),
	);
}

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
	}
}
