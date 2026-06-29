import {
	notFound as tanStackNotFound,
	redirect as tanStackRedirect,
	useLocation,
	useMatches,
	useNavigate,
} from "@tanstack/react-router";
import { useMemo } from "react";

type NavigateOptions = {
	scroll?: boolean;
};

export function useRouter() {
	const navigate = useNavigate();
	return useMemo(
		() => ({
			push: (href: string, _options?: NavigateOptions) => {
				void navigate({ to: href });
			},
			replace: (href: string, _options?: NavigateOptions) => {
				void navigate({ to: href, replace: true });
			},
			back: () => {
				window.history.back();
			},
			refresh: () => {
				window.location.reload();
			},
		}),
		[navigate],
	);
}

export function usePathname() {
	return useLocation({ select: (location) => location.pathname });
}

export function useSearchParams() {
	const searchStr = useLocation({ select: (location) => location.searchStr });
	return useMemo(() => new URLSearchParams(searchStr), [searchStr]);
}

export function useParams<
	TParams extends Record<string, string | undefined> = Record<string, string>,
>() {
	const matches = useMatches();
	return useMemo(
		() =>
			Object.assign(
				{},
				...matches.map((match) => match.params as Record<string, string | undefined>),
			) as TParams,
		[matches],
	);
}

export function redirect(href: string): never {
	throw tanStackRedirect({ to: href });
}

export function notFound(): never {
	throw tanStackNotFound();
}
