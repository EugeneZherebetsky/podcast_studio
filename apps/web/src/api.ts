import {
  ApiErrorSchema,
  CreateJobRequestSchema,
  GetEpisodeResponseSchema,
  JobDetailSchema,
  JobSchema,
  ListEpisodesResponseSchema,
  ListJobsResponseSchema,
  RetryJobRequestSchema,
  ServerEventSchema,
  type CreateJobRequestInput,
  type ServerEvent,
} from "shared";

async function request<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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
  jobs: () => request("/jobs", ListJobsResponseSchema),
  job: (id: string) => request(`/jobs/${idPath(id)}`, JobDetailSchema),
  createJob: (body: CreateJobRequestInput) =>
    request("/jobs", JobSchema, CreateJobRequestSchema.parse(body)),
  retryJob: (id: string) =>
    request(`/jobs/${idPath(id)}/retry`, JobSchema, RetryJobRequestSchema.parse({})),
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
