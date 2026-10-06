const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const { withUniwindConfig } = require("uniwind/metro");

module.exports = withUniwindConfig(getSentryExpoConfig(__dirname, { includeWebReplay: false }), {
	cssEntryFile: "./global.css",
	dtsFile: "./uniwind-types.d.ts",
});
