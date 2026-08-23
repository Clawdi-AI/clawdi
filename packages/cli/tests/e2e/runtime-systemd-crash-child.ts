import { readFileSync } from "node:fs";
import { convergeRuntimeManifest } from "../../src/runtime/manifest";
import type { RuntimeManifestLoad } from "../../src/runtime/manifest-source";
import { getRuntimePaths } from "../../src/runtime/paths";
import { ensureRuntimeStateDirs } from "../../src/runtime/state";
import {
	applySystemdRuntimeUpdate,
	readSystemdUnitSnapshot,
	SystemdRuntimeTransaction,
} from "../../src/runtime/systemd-transaction";

const loadPath = process.env.CLAWDI_E2E_CRASH_LOAD;
if (!loadPath) throw new Error("CLAWDI_E2E_CRASH_LOAD is required");

const load = JSON.parse(readFileSync(loadPath, "utf8")) as RuntimeManifestLoad;
const paths = getRuntimePaths({ mode: "hosted" });
ensureRuntimeStateDirs(paths);
const before = readSystemdUnitSnapshot(paths);
const transaction = new SystemdRuntimeTransaction();
const result = convergeRuntimeManifest(load, paths, {
	cacheLastGood: false,
	systemdApply: {
		transactionState: () => transaction.state,
		installOfficialService: (unit, install) =>
			transaction.installOfficialService(paths, unit, install),
		quiesce: (units) => transaction.quiesce(paths, units),
		activateEgressPrerequisite: () => ({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: [],
		}),
		activate: (signal) =>
			applySystemdRuntimeUpdate(paths, before, readSystemdUnitSnapshot(paths), {
				transaction,
				stage: "final-activation",
				forceReloadUserUnits: signal.reloadUserUnits,
				forceRestartUserUnits: signal.restartUserUnits,
			}),
		rollback: () => transaction.rollback(paths),
	},
});
if (result.installErrors.length > 0) throw new Error(result.installErrors.join("; "));
