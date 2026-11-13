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
  deleteJob: (id: string) => request(`/jobs/${idPath(id)}`, OkResponseSchema, undefined, "DELETE"),
  jobDetails: (id: string) => request(`/jobs/${idPath(id)}/details`, {
    parse(value: unknown) {
      const data = value as { script?: unknown; providers?: unknown; model?: unknown };
      if (!data || !(data.script === null || typeof data.script === "string") ||
          !Array.isArray(data.providers) || !data.providers.every((p: unknown) => typeof p === "string") ||
          !(data.model === null || typeof data.model === "string")) throw new Error("Invalid job details");
      return data as { script: string | null; providers: string[]; model: string | null };
    },
  }),
  jobLog: (id: string) =>
    request(`/jobs/${idPath(id)}/log`, {
      parse(value: unknown) {
        const data = value as { available?: unknown; partial?: unknown; entries?: unknown };
        if (
          !data ||
          typeof data.available !== "boolean" ||
          (data.available && typeof data.partial !== "boolean") ||
          !Array.isArray(data.entries) ||
          !data.entries.every(
            (e: unknown) =>
              e &&
              typeof e === "object" &&
              typeof (e as { timestamp?: unknown }).timestamp === "string" &&
              typeof (e as { message?: unknown }).message === "string",
          )
        )
          throw new Error("Invalid progress log");
        return data as { available: boolean; partial?: boolean; entries: { timestamp: string; message: string }[] };
      },
    }),
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
    onLog?: (jobId: string) => void,
  ) => {
    const source = new EventSource("/api/events");
    source.onopen = () => onConnection(true);
    source.onerror = () => onConnection(false);
    source.addEventListener("job-log", (message) => {
      try {
        const value: unknown = JSON.parse(message.data);
        if (
          value &&
          typeof value === "object" &&
          typeof (value as { jobId?: unknown }).jobId === "string"
        )
          onLog?.((value as { jobId: string }).jobId);
      } catch {
        /* Ignore invalid notifications. */
      }
    });
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
