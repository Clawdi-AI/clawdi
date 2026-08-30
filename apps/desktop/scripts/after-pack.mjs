import { join } from "node:path";
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

export default async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;

	const productName = context.packager.appInfo.productFilename;
	const executable = join(
		context.appOutDir,
		`${productName}.app`,
		"Contents",
		"MacOS",
		productName,
	);
	await flipFuses(executable, {
		version: FuseVersion.V1,
		resetAdHocDarwinSignature: true,
		strictlyRequireAllFuses: true,
		[FuseV1Options.RunAsNode]: false,
		[FuseV1Options.EnableCookieEncryption]: true,
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
		[FuseV1Options.EnableNodeCliInspectArguments]: false,
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
		[FuseV1Options.OnlyLoadAppFromAsar]: true,
		[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: true,
		[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
		[FuseV1Options.WasmTrapHandlers]: true,
	});
}
