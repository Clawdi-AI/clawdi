import { AuthView } from "@clerk/expo/native";

/**
 * Serves /sign-in and /sign-up with Clerk's default `signInOrUp` mode: the native
 * `signIn`/`signUp` modes offer no switch, so a new user on /sign-in or an existing
 * user on /sign-up (e.g. a Web /sign-up link) would be stuck.
 */
export default function SignInPage() {
	return <AuthView isDismissible={false} />;
}
