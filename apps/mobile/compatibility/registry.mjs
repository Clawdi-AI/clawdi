import { readFile, writeFile } from "node:fs/promises";

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error("Manifest and output paths are required");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const expoResponse = await fetch("https://registry.npmjs.org/expo", {
	signal: AbortSignal.timeout(30_000),
});
if (!expoResponse.ok) throw new Error(`Expo channel request returned ${expoResponse.status}`);
const expoMetadata = await expoResponse.json();
const packages = {};
for (const [name, pinned] of Object.entries({
	...manifest.dependencies,
	...manifest.devDependencies,
})) {
	const response = await fetch(`https://registry.npmjs.org/${name}/latest`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Registry request for ${name} returned ${response.status}`);
	const metadata = await response.json();
	if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) {
		throw new Error(`Latest for ${name} is not a stable version: ${metadata.version}`);
	}
	packages[name] = {
		pinned,
		latest: metadata.version,
		matchesLatest: pinned === metadata.version,
		peerDependencies: metadata.peerDependencies ?? {},
		peerDependenciesMeta: metadata.peerDependenciesMeta ?? {},
		integrity: metadata.dist?.integrity,
		deprecated: metadata.deprecated ?? null,
	};
}
await writeFile(
	outputPath,
	`${JSON.stringify({ checkedAt: new Date().toISOString(), expoChannels: expoMetadata["dist-tags"], packages }, null, 2)}\n`,
);
if (Object.values(packages).some((metadata) => !metadata.matchesLatest)) {
	throw new Error(
		"Pinned snapshot is no longer all-latest; review registry.json before updating the probe",
	);
}
