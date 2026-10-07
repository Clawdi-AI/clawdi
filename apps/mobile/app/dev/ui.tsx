import { Redirect } from "expo-router";

// Expo folds __DEV__ before collecting dependencies, so gallery imports never enter production.
const DevUiRoute: typeof import("@/pages/dev/ui-page").default = __DEV__
	? require("@/pages/dev/ui-page").default
	: () => <Redirect href="/" />;

export default DevUiRoute;
