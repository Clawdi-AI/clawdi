// Response shapes returned by the Clawdi Cloud backend.
// Keep these in sync with backend/app/routes/ and backend/app/services/.

export interface MemoryRecord {
	id: string;
	content: string;
	category: string;
	source: string;
	tags: string[] | null;
	access_count: number;
	created_at: string;
}

export interface SkillRecord {
	id: string;
	skill_key: string;
	name: string;
	description: string | null;
	version: number;
	source: string;
	source_repo: string | null;
	agent_types: string[] | null;
	file_count: number;
	content_hash: string | null;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

export interface SkillSummary {
	skill_key: string;
	name: string;
}
