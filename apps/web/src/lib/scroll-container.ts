export function findScrollableContainer(node: Element | null): HTMLElement | Window {
	let current = node instanceof HTMLElement ? node : node?.parentElement;
	while (current) {
		const overflow = getComputedStyle(current).overflowY;
		if (overflow === "auto" || overflow === "scroll") return current;
		current = current.parentElement;
	}
	return window;
}
