import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Model Providers",
	"Managed AI by default, plus your own OpenAI, Anthropic, OpenRouter, Gemini, Mistral, or custom providers.",
);

export default function AiProvidersLayout({ children }: { children: React.ReactNode }) {
	return children;
}
