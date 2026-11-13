import {
  ApiErrorSchema,
  CreateTopicRequestSchema,
  UpdateTopicRequestSchema,
  TopicSchema,
  ListTopicsResponseSchema,
  OkResponseSchema,
  SettingsSchema,
  UpdateSettingsRequestSchema,
  type CreateTopicRequestInput,
  type UpdateTopicRequest,
  type UpdateSettingsRequest,
  CreateJobRequestSchema,
  GetEpisodeResponseSchema,
  JobDetailSchema,
  JobSchema,
  ListEpisodesResponseSchema,
  ListJobsResponseSchema,
  ServerEventSchema,
  type CreateJobRequestInput,
  type ServerEvent,
} from "shared";

async function request<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined && method === "POST"
      ? undefined
      : {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        },
  );
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(json);
    throw new Error(error.success ? error.data.error : `Request failed (${response.status})`);
  }
  return schema.parse(json);
}
const idPath = (id: string) => encodeURIComponent(id);
export const api = {
  topics: () => request("/topics", ListTopicsResponseSchema),
  createTopic: (body: CreateTopicRequestInput) =>
    request("/topics", TopicSchema, CreateTopicRequestSchema.parse(body)),
  updateTopic: (id: string, body: UpdateTopicRequest) =>
    request(`/topics/${idPath(id)}`, TopicSchema, UpdateTopicRequestSchema.parse(body), "PATCH"),
  deleteTopic: (id: string) =>
    request(`/topics/${idPath(id)}`, OkResponseSchema, undefined, "DELETE"),
  settings: () => request("/settings", SettingsSchema),
  updateSettings: (body: UpdateSettingsRequest) =>
    request("/settings", SettingsSchema, UpdateSettingsRequestSchema.parse(body), "PUT"),
  jobs: () => request("/jobs", ListJobsResponseSchema),
  job: (id: string) => request(`/jobs/${idPath(id)}`, JobDetailSchema),
  createJob: (body: CreateJobRequestInput) =>
    request("/jobs", JobSchema, CreateJobRequestSchema.parse(body)),
  retryAsNew: (id: string) =>
    request(`/jobs/${idPath(id)}/retry-as-new`, JobSchema, {}),
  episodes: () => request("/episodes", ListEpisodesResponseSchema),
  episode: (id: string) => request(`/episodes/${idPath(id)}`, GetEpisodeResponseSchema),
  audioUrl: (id: string) => `/api/episodes/${idPath(id)}/audio`,
  subscribe: (
    onEvent: (event: ServerEvent) => void,
    onConnection: (connected: boolean) => void,
  ) => {
    const source = new EventSource("/api/events");
    source.onopen = () => onConnection(true);
    source.onerror = () => onConnection(false);
    source.onmessage = (message) => {
      try {
        const event = ServerEventSchema.safeParse(JSON.parse(message.data));
        if (event.success) onEvent(event.data);
      } catch {
        onConnection(false);
      }
    };
    return () => source.close();
  },
};
