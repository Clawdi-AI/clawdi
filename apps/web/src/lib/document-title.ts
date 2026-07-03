export const APP_TITLE = "Clawdi";

export function formatDocumentTitle(title: string | null | undefined): string {
	const trimmed = title?.trim();
	return trimmed ? `${trimmed} · ${APP_TITLE}` : APP_TITLE;
}

export function routeHeadTitle(title: string) {
	return {
		meta: [{ title: formatDocumentTitle(title) }],
	};
}
