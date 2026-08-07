export function createSharedShutdown<Arguments extends readonly unknown[]>(
	shutdown: (...args: Arguments) => Promise<void>,
): (...args: Arguments) => Promise<void> {
	let shutdownPromise: Promise<void> | undefined;
	return (...args: Arguments): Promise<void> => {
		shutdownPromise ??= performShutdown(shutdown, args);
		return shutdownPromise;
	};
}

async function performShutdown<Arguments extends readonly unknown[]>(
	shutdown: (...args: Arguments) => Promise<void>,
	args: Arguments,
): Promise<void> {
	await shutdown(...args);
}
