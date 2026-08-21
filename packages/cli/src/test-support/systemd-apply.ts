import type { convergeRuntimeManifest } from "../runtime/manifest";

type ConvergeOptions = NonNullable<Parameters<typeof convergeRuntimeManifest>[2]>;
type SystemdApplyHooks = NonNullable<ConvergeOptions["systemdApply"]>;

export type TestSystemdApplyHooks = Omit<
	SystemdApplyHooks,
	"installOfficialService" | "transactionState"
> & {
	installOfficialService?: SystemdApplyHooks["installOfficialService"];
};

export type TestConvergeOptions = Omit<ConvergeOptions, "systemdApply"> & {
	systemdApply?: TestSystemdApplyHooks;
};

export function withTestSystemdTransaction(hooks: TestSystemdApplyHooks): SystemdApplyHooks {
	let mutated = false;
	return {
		...hooks,
		transactionState: () => (mutated ? "mutated" : "pristine"),
		installOfficialService: (unit, install) => {
			mutated = true;
			return hooks.installOfficialService ? hooks.installOfficialService(unit, install) : install();
		},
		activateEgressPrerequisite: (signal) => {
			mutated = true;
			return hooks.activateEgressPrerequisite(signal);
		},
		activate: (signal) => {
			mutated = true;
			return hooks.activate(signal);
		},
	};
}
