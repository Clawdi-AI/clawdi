// TODO (2026-10-08): Remove after 2026-11-08; retained for Desktop beta.1–7.
export function DesktopWindowDragRegion() {
	return (
		<div
			aria-hidden="true"
			data-clawdi-window-drag-region
			className="fixed inset-x-0 top-0 z-50 h-10"
		/>
	);
}
