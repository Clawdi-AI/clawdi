import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import {
	FRAMEWORK_BRAND_ICON_IDS,
	PROVIDER_BRAND_ICON_IDS,
} from "@/components/entity-brand-icon-ids";
import { EntityIcon } from "@/components/entity-icon";
import "@/styles/globals.css";

function GalleryCell({
	kind,
	id,
	surface,
	children,
}: {
	kind: "framework" | "provider";
	id: string;
	surface: string;
	children: ReactNode;
}) {
	return (
		<div
			data-brand-cell
			data-brand-kind={kind}
			data-brand-id={id}
			data-brand-surface={surface}
			className="flex min-h-20 items-center gap-3 rounded-lg border border-border bg-background p-3"
		>
			{children}
			<span className="text-xs text-muted-foreground">
				{id} · {surface}
			</span>
		</div>
	);
}

function BrandIconGallery() {
	return (
		<main className="min-h-screen bg-background p-6 text-foreground">
			<section className="grid grid-cols-3 gap-3" aria-label="Framework brand icon geometry">
				{FRAMEWORK_BRAND_ICON_IDS.flatMap((id) => [
					<GalleryCell key={`${id}-rail`} kind="framework" id={id} surface="sidebar-rail">
						<AgentIcon agent={id} size="rail" />
					</GalleryCell>,
					<GalleryCell key={`${id}-card`} kind="framework" id={id} surface="agent-card">
						<AgentIcon agent={id} size="lg" />
					</GalleryCell>,
					<GalleryCell key={`${id}-deploy`} kind="framework" id={id} surface="deploy-card">
						<EntityIcon kind="framework" id={id} size="md" />
					</GalleryCell>,
				])}
			</section>

			<section className="mt-6 grid grid-cols-4 gap-3" aria-label="Provider brand icon geometry">
				{PROVIDER_BRAND_ICON_IDS.flatMap((id) => [
					<GalleryCell key={`${id}-card`} kind="provider" id={id} surface="provider-card">
						<EntityIcon kind="provider" id={id} size="sm" />
					</GalleryCell>,
					<GalleryCell key={`${id}-model`} kind="provider" id={id} surface="model-card">
						<EntityIcon kind="provider" id={id} size="sm" />
					</GalleryCell>,
				])}
			</section>
		</main>
	);
}

const galleryRoot = document.querySelector("#brand-icon-gallery");
if (!(galleryRoot instanceof HTMLElement)) {
	throw new Error("Brand icon gallery root is missing.");
}

createRoot(galleryRoot).render(<BrandIconGallery />);
