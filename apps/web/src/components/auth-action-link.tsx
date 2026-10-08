import { useAuth, useClerk } from "@clerk/tanstack-react-start";
import type { ComponentProps } from "react";
import { sanitizeAuthRedirectPath, signInActionHref } from "@/lib/auth-redirect";
import { env } from "@/lib/env";

type AuthActionLinkProps = ComponentProps<"a"> & { href: string };

export function AuthActionLink({ href, ...props }: AuthActionLinkProps) {
	const destination = sanitizeAuthRedirectPath(href);
	if (env.VITE_DEV_AUTH_BYPASS) return <a {...props} href={destination} />;
	return <ClerkAuthActionLink {...props} href={destination} />;
}

function ClerkAuthActionLink({ href, onClick, ...props }: AuthActionLinkProps) {
	const { isLoaded, isSignedIn } = useAuth();
	const clerk = useClerk();
	return (
		<a
			{...props}
			href={isLoaded && isSignedIn ? href : signInActionHref(href)}
			onClick={(event) => {
				onClick?.(event);
				if (
					event.defaultPrevented ||
					!isLoaded ||
					isSignedIn ||
					event.button !== 0 ||
					event.metaKey ||
					event.ctrlKey ||
					event.shiftKey ||
					event.altKey ||
					(props.target && props.target !== "_self") ||
					props.download != null
				)
					return;
				event.preventDefault();
				try {
					clerk.openSignIn({ forceRedirectUrl: href, signUpForceRedirectUrl: href });
				} catch {
					window.location.assign(event.currentTarget.href);
				}
			}}
		/>
	);
}
