import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode, useCallback } from "react";
import { useRouter } from "@/lib/router-navigation";

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
	href: string;
	children?: ReactNode;
	prefetch?: boolean;
	replace?: boolean;
	scroll?: boolean;
};

function isModifiedEvent(event: MouseEvent<HTMLAnchorElement>) {
	return event.metaKey || event.altKey || event.ctrlKey || event.shiftKey;
}

function isExternalHref(href: string) {
	return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

export function Link({ href, children, onClick, replace = false, target, ...props }: LinkProps) {
	const router = useRouter();
	const handleClick = useCallback(
		(event: MouseEvent<HTMLAnchorElement>) => {
			onClick?.(event);
			if (
				event.defaultPrevented ||
				event.button !== 0 ||
				isModifiedEvent(event) ||
				target === "_blank" ||
				isExternalHref(href)
			) {
				return;
			}
			event.preventDefault();
			if (replace) {
				router.replace(href);
			} else {
				router.push(href);
			}
		},
		[href, onClick, replace, router, target],
	);

	return (
		<a href={href} target={target} onClick={handleClick} {...props}>
			{children}
		</a>
	);
}

export default Link;
