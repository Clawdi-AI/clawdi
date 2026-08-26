export type AdapterModule = "sessions" | "skills";

const LEGACY_CONNECTED_MODULES: readonly AdapterModule[] = ["sessions", "skills"];

/** Legacy Connected rows predate adapter_modules and supported both modules. */
export function connectedAdapterModules(
	modules: readonly AdapterModule[] | null | undefined,
): readonly AdapterModule[] {
	return modules ?? LEGACY_CONNECTED_MODULES;
}

export function connectedAdapterHasModule(
	modules: readonly AdapterModule[] | null | undefined,
	module: AdapterModule,
): boolean {
	return connectedAdapterModules(modules).includes(module);
}
