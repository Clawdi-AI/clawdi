import { DEFAULT_CONNECTION_CONFIG } from "baileys";

import type { AdvertisedRelease } from "./types.js";

const defaultVersion = DEFAULT_CONNECTION_CONFIG.version;
if (defaultVersion[0] !== 2 || defaultVersion[1] !== 3000 || defaultVersion[2] !== 1035194821) {
	throw new Error(
		"installed Baileys rc13 default advertised version does not match the audited release",
	);
}
const advertisedVersion: [number, number, number] = [
	defaultVersion[0],
	defaultVersion[1],
	defaultVersion[2],
];

export const BAILEYS_RELEASE: AdvertisedRelease = Object.freeze({
	packageName: "@whiskeysockets/baileys",
	packageVersion: "7.0.0-rc13",
	sourceCommit: "8053b086ecc97ec3f78299561de11959bab05d39",
	version: Object.freeze(advertisedVersion),
});
