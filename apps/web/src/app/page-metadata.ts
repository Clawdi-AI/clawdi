export type PageMetadata = {
	title: string;
	description: string;
	openGraph: {
		title: string;
		description: string;
	};
	twitter: {
		card: "summary";
		title: string;
		description: string;
	};
};

export function pageMetadata(title: string, description: string): PageMetadata {
	return {
		title,
		description,
		openGraph: {
			title,
			description,
		},
		twitter: {
			card: "summary",
			title,
			description,
		},
	};
}
