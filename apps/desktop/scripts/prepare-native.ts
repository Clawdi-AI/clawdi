import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "tar";
import { validateNativeArchive } from "../../../packages/cli/src/lib/native-activation";
import {
	nativeTargetForPlatform,
	parseNativeReleaseManifest,
} from "../../../packages/cli/src/lib/native-release-manifest";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const cliPackage = JSON.parse(
	readFileSync(join(repositoryRoot, "packages", "cli", "package.json"), "utf8"),
) as { version?: unknown };
const version = typeof cliPackage.version === "string" ? cliPackage.version : null;
const target =
	process.env.CLAWDI_NATIVE_TARGET || nativeTargetForPlatform(process.platform, process.arch);
if (!version || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
	throw new Error("CLI package has an invalid version");
}
if (!target) throw new Error(`unsupported desktop build host: ${process.platform}-${process.arch}`);

const releaseBase = `https://github.com/Clawdi-AI/clawdi/releases/download/clawdi-cli-v${version}`;
const manifestText = new TextDecoder().decode(
	await download(`${releaseBase}/clawdi-cli-manifest.txt`, 64 * 1024),
);
const manifest = parseNativeReleaseManifest(manifestText);
if (manifest.version !== version)
	throw new Error("native release version does not match the CLI package");
const artifact = manifest.artifacts.find((candidate) => candidate.target === target);
if (!artifact) throw new Error(`native release does not include ${target}`);
const archive = await download(`${releaseBase}/${artifact.asset}`, 256 * 1024 * 1024);
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== artifact.sha256) throw new Error("native desktop resource checksum mismatch");
await validateNativeArchive(archive);

const output = join(desktopRoot, "resources", "native");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true, mode: 0o755 });
await extractArchive(output, archive);
writeFileSync(join(output, "clawdi-cli-manifest.txt"), manifestText, { mode: 0o644 });
chmodSync(join(output, "clawdi"), 0o755);
console.log(`prepared Clawdi CLI ${version} (${target}) for Electron`);

async function download(url: string, maxBytes: number): Promise<Buffer> {
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(3 * 60_000),
	});
	if (!response.ok) throw new Error(`download failed with HTTP ${response.status}: ${url}`);
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error(`download exceeds size limit: ${url}`);
	}
	const body = Buffer.from(await response.arrayBuffer());
	if (body.byteLength > maxBytes) throw new Error(`download exceeds size limit: ${url}`);
	return body;
}

function extractArchive(cwd: string, archive: Buffer): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const stream = extract({ cwd, gzip: true });
		stream.once("close", resolvePromise);
		stream.once("error", reject);
		stream.end(archive);
	});
}
