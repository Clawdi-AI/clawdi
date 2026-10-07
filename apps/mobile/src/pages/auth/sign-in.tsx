import { AuthView } from "@clerk/expo/native";

/**
 * Clerk's default `signInOrUp` mode: native `signIn` mode has no sign-up link, so a
 * new user would be stuck where Web's `<SignIn/>` offers "Sign up".
 */
export default function SignInPage() {
	return <AuthView isDismissible={false} />;
}
