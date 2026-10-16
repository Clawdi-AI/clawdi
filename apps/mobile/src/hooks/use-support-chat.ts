import { useRouter } from "expo-router";
import { useMemo } from "react";
import { useMobileApi } from "@/lib/api-provider";
import { type SupportChatContext, supportChatParams } from "@/lib/chatwoot";

/**
 * Web's live chat (Chatwoot) for Help and Contact support: opens the identified support chat,
 * optionally with Web's conversation attributes and label. Null where live chat isn't
 * configured, so callers keep their email fallback, as Web does without Chatwoot.
 */
export function useSupportChat(): ((context?: SupportChatContext) => void) | null {
	const router = useRouter();
	const { supportChat } = useMobileApi();
	return useMemo(
		() =>
			supportChat
				? (context?: SupportChatContext) =>
						router.push({ pathname: "/support", params: supportChatParams(context) })
				: null,
		[router, supportChat],
	);
}
