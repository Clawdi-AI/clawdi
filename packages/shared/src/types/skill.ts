export interface Skill {
	id: string;
	userId: string;
	skillKey: string;
	name: string;
	description: string | null;
	version: number;
	source: "local" | "catalog" | "custom";
	agentTypes: string[];
	contentHash: string;
	fileKey: string | null;
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
}
