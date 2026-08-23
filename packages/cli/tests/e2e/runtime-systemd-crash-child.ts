import { readFileSync } from "node:fs";
import { applyRuntimeManifestLoad } from "../../src/commands/runtime";
import type { RuntimeManifestLoad } from "../../src/runtime/manifest-source";
import { getRuntimePaths } from "../../src/runtime/paths";
import { ensureRuntimeStateDirs } from "../../src/runtime/state";

const loadPath = process.env.CLAWDI_E2E_CRASH_LOAD;
if (!loadPath) throw new Error("CLAWDI_E2E_CRASH_LOAD is required");

const load = JSON.parse(readFileSync(loadPath, "utf8")) as RuntimeManifestLoad;
const paths = getRuntimePaths({ mode: "hosted" });
ensureRuntimeStateDirs(paths);
const result = await applyRuntimeManifestLoad(load, paths);
if (result.kind !== "converged") throw new Error(`unexpected runtime apply result: ${result.kind}`);
const errors = [
	...result.convergence.installErrors,
	...result.convergence.resourceProjectionErrors,
];
if (errors.length > 0) throw new Error(errors.join("; "));
