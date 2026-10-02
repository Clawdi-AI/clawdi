import { readFile, writeFile } from "node:fs/promises";

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error("Manifest and output paths are required");
const response = await fetch("https://registry.npmjs.org/expo-template-default/57.0.28", {
	signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Expo template request returned ${response.status}`);
const template = await response.json();
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const overrides = {};
for (const [name, version] of Object.entries(template.dependencies)) {
	if (name in manifest.dependencies) {
		overrides[name] = { from: manifest.dependencies[name], to: version };
		manifest.dependencies[name] = version;
	}
}
overrides["react-native-svg"] = { from: manifest.dependencies["react-native-svg"], to: "15.15.4" };
manifest.dependencies["react-native-svg"] = "15.15.4";
const devOverrides = {
	"@babel/core": "7.29.7",
	"@react-native/metro-config": "0.86.3",
	"@types/react": "~19.2.4",
};
for (const [name, version] of Object.entries(devOverrides)) {
	overrides[name] = { from: manifest.devDependencies[name], to: version };
	manifest.devDependencies[name] = version;
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
	outputPath,
	`${JSON.stringify({ template: template.version, overrides }, null, 2)}\n`,
);
