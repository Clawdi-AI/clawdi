import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Output path is required");
const require = createRequire(path.join(process.cwd(), "package.json"));
const semver = require("semver");
const manifest = require("./package.json");
const declared = { ...manifest.dependencies, ...manifest.devDependencies };
const installed = {};
const peerConflicts = [];
const invalidPeerRanges = [];
for (const name of Object.keys(declared)) {
	const metadata = JSON.parse(
		readFileSync(path.join("node_modules", name, "package.json"), "utf8"),
	);
	installed[name] = metadata.version;
	for (const [peer, range] of Object.entries(metadata.peerDependencies ?? {})) {
		if (!(peer in declared)) continue;
		const peerMetadata = JSON.parse(
			readFileSync(path.join("node_modules", peer, "package.json"), "utf8"),
		);
		if (!semver.validRange(range)) {
			invalidPeerRanges.push({ package: name, peer, range, installed: peerMetadata.version });
			continue;
		}
		if (!semver.satisfies(peerMetadata.version, range)) {
			peerConflicts.push({ package: name, peer, range, installed: peerMetadata.version });
		}
	}
}

const identities = {};
for (const name of ["expo", "react-native", "@clerk/expo", "heroui-native", "expo-router"]) {
	const packageRequire = createRequire(path.resolve("node_modules", name, "package.json"));
	identities[name] = packageRequire.resolve("react");
}
const metroRequire = createRequire(require.resolve("@expo/metro-config"));
const polyfillsPath = path.resolve("node_modules/react-native/rn-get-polyfills.js");
const sourceFiles = [
	"node_modules/@expo/metro-config/build/ExpoMetroConfig.js",
	"node_modules/react-native/package.json",
	"node_modules/react-native/React/Base/RCTVersion.m",
	"node_modules/react-native/ReactAndroid/gradle.properties",
	"node_modules/react-native/gradle/libs.versions.toml",
	"node_modules/react-native/scripts/cocoapods/helpers.rb",
	"node_modules/expo/ios/Expo.podspec",
	"node_modules/expo/Expo.podspec",
	"node_modules/expo-modules-core/ios/ExpoModulesCore.podspec",
	"node_modules/expo-modules-core/ExpoModulesCore.podspec",
	"node_modules/@expo/ui/ios/ExpoUI.podspec",
	"node_modules/@expo/ui/ExpoUI.podspec",
];
const sourceExcerpts = {};
for (const filename of sourceFiles) {
	if (!existsSync(filename)) continue;
	sourceExcerpts[filename] = readFileSync(filename, "utf8")
		.split("\n")
		.filter((line) =>
			/rn-get-polyfills|react-native-strict-api|ios.*(?:15|16)|deployment_target|minSdk|compileSdk|targetSdk|return '15\.1'|return '16\.1'/.test(
				line,
			),
		);
}
const audit = {
	installed,
	expoSupported: require("expo/bundledNativeModules.json"),
	peerConflicts,
	invalidPeerRanges,
	reactIdentity: identities,
	singleReactIdentity: new Set(Object.values(identities)).size === 1,
	rnGetPolyfillsExists: existsSync(polyfillsPath),
	expoMetroBabelVersion: metroRequire("@babel/core/package.json").version,
	rootBabelVersion: require("@babel/core/package.json").version,
	sourceExcerpts,
	nativeCompile: {
		android: "not run: compatibility gate blocked; no Android SDK in this container",
		ios: "not run: Linux container has no Xcode/Apple build runner",
	},
};
writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
console.log(
	JSON.stringify({ peerConflicts, singleReactIdentity: audit.singleReactIdentity }, null, 2),
);
