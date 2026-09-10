import { join } from "node:path";
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

export default async function afterPack(context) {
	const mac = context.electronPlatformName === "darwin";
	const productName = context.packager.appInfo.productFilename;
	const executable = mac
		? join(context.appOutDir, `${productName}.app`, "Contents", "MacOS", productName)
		: join(context.appOutDir, context.packager.executableName);
	await flipFuses(executable, {
		version: FuseVersion.V1,
		resetAdHocDarwinSignature: mac,
		strictlyRequireAllFuses: true,
		[FuseV1Options.RunAsNode]: false,
		[FuseV1Options.EnableCookieEncryption]: true,
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
		[FuseV1Options.EnableNodeCliInspectArguments]: false,
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: mac,
		[FuseV1Options.OnlyLoadAppFromAsar]: true,
		[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
		[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
		[FuseV1Options.WasmTrapHandlers]: true,
	});
}
