const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

module.exports = withUniwindConfig(getDefaultConfig(__dirname), {
	cssEntryFile: "./global.css",
	dtsFile: "./uniwind-types.d.ts",
});
