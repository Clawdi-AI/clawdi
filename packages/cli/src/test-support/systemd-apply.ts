import type { convergeRuntimeManifest } from "../runtime/manifest";

type ConvergeOptions = NonNullable<Parameters<typeof convergeRuntimeManifest>[2]>;
type SystemdApplyHooks = NonNullable<ConvergeOptions["systemdApply"]>;

export type TestSystemdApplyHooks = Omit<
	SystemdApplyHooks,
	"installOfficialService" | "transactionState"
>;

export type TestConvergeOptions = Omit<ConvergeOptions, "systemdApply"> & {
	systemdApply?: TestSystemdApplyHooks;
};

export function withTestSystemdTransaction(hooks: TestSystemdApplyHooks): SystemdApplyHooks {
	let mutated = false;
	return {
		...hooks,
		transactionState: () => (mutated ? "mutated" : "pristine"),
		installOfficialService: (_unit, install) => {
			mutated = true;
			return install();
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
