export interface PaginatedPage<T> {
	items: T[];
	total?: number;
	page?: number;
	page_size?: number;
}

export interface FetchAllPagesOptions {
	pageSize?: number;
	maxPages?: number;
	resourceName?: string;
}

export async function fetchAllPages<T>(
	fetchPage: (page: number, pageSize: number) => Promise<PaginatedPage<T>>,
	options: FetchAllPagesOptions = {},
): Promise<Required<Pick<PaginatedPage<T>, "items" | "total" | "page" | "page_size">>> {
	const pageSize = options.pageSize ?? 200;
	const maxPages = options.maxPages ?? 50;
	const resourceName = options.resourceName ?? "resources";
	const items: T[] = [];
	let page = 1;
	let total = 0;

	while (true) {
		const result = await fetchPage(page, pageSize);
		items.push(...result.items);
		total = result.total ?? items.length;

		if (items.length >= total || result.items.length === 0) {
			return { items, total, page: 1, page_size: pageSize };
		}

		page += 1;
		if (page > maxPages) {
			throw new Error(
				`Too many ${resourceName} pages to load safely. Narrow the view and try again.`,
			);
		}
	}
}
