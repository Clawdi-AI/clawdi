import createClient from "openapi-fetch";
import type { paths } from "./api.generated";
import {
	type ApiClientOptions,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export function createProjectSharingClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	return {
		previewLink: (token: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/share/{token}/preview", {
						...init,
						params: { path: { token: readResourceId(token) } },
					}),
				signal,
			),
		joinLink: (token: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/share/{token}/upgrade", {
						...init,
						params: { path: { token: readResourceId(token) } },
						body: { use_as: "attached" },
					}),
				signal,
			),
		listReceivedInvitations: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/me/invitations", init), signal),
		acceptInvitation: (invitationId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/me/invitations/{invitation_id}/accept", {
						...init,
						params: { path: { invitation_id: readResourceId(invitationId) } },
						body: { use_as: "attached" },
					}),
				signal,
			),
		declineInvitation: (invitationId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/me/invitations/{invitation_id}/decline", {
						...init,
						params: { path: { invitation_id: readResourceId(invitationId) } },
					}),
				signal,
			),
		getProject: (projectId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/projects/{project_id}", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
					}),
				signal,
			),
		listLinks: (projectId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/projects/{project_id}/share-links", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
					}),
				signal,
			),
		createLink: (
			projectId: string,
			body: paths["/v1/projects/{project_id}/share-links"]["post"]["requestBody"]["content"]["application/json"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.POST("/v1/projects/{project_id}/share-links", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
						body,
					}),
				signal,
			),
		revokeLink: (projectId: string, resourceId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.DELETE("/v1/projects/{project_id}/share-links/{link_id}", {
						...init,
						params: {
							path: { project_id: readResourceId(projectId), link_id: readResourceId(resourceId) },
						},
					}),
				signal,
			),
		listInvitations: (projectId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/projects/{project_id}/invitations", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
					}),
				signal,
			),
		invite: (
			projectId: string,
			body: paths["/v1/projects/{project_id}/invitations"]["post"]["requestBody"]["content"]["application/json"],
			signal?: AbortSignal,
		) =>
			transport.read(
				(init) =>
					api.POST("/v1/projects/{project_id}/invitations", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
						body,
					}),
				signal,
			),
		cancelInvitation: (projectId: string, resourceId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.DELETE("/v1/projects/{project_id}/invitations/{invitation_id}", {
						...init,
						params: {
							path: {
								project_id: readResourceId(projectId),
								invitation_id: readResourceId(resourceId),
							},
						},
					}),
				signal,
			),
		listMembers: (projectId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/projects/{project_id}/members", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
					}),
				signal,
			),
		removeMember: (projectId: string, resourceId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.DELETE("/v1/projects/{project_id}/members/{member_user_id}", {
						...init,
						params: {
							path: {
								project_id: readResourceId(projectId),
								member_user_id: readResourceId(resourceId),
							},
						},
					}),
				signal,
			),
		stopSharing: (projectId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/projects/{project_id}/unshare", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
					}),
				signal,
			),
		leaveProject: (projectId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.POST("/v1/projects/{project_id}/leave", {
						...init,
						params: { path: { project_id: readResourceId(projectId) } },
					}),
				signal,
			),
	};
}

export type ProjectSharingClient = ReturnType<typeof createProjectSharingClient>;
