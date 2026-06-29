import { SignIn } from "@clerk/tanstack-react-start";
import { env } from "@/lib/env";
import { DevAuthBypassPage } from "../../dev-auth-bypass-page";

const isDevAuthBypass = env.NEXT_PUBLIC_DEV_AUTH_BYPASS;

export default function SignInPage() {
	if (isDevAuthBypass) return <DevAuthBypassPage mode="sign-in" />;

	return (
		<main className="flex min-h-dvh items-center justify-center">
			<SignIn />
		</main>
	);
}
