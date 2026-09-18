export interface DispatchInput {
  owner: string;
  repo: string;
  eventType: string;
  token: string;
  payload: Record<string, unknown>;
}

const GITHUB_API_VERSION = "2022-11-28";

export async function dispatchRepositoryEvent(
  input: DispatchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/dispatches`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "nfl-missed-kick-scheduler",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: input.eventType,
      client_payload: input.payload,
    }),
  });

  if (res.status === 204) return;

  let detail = "";
  try {
    const text = await res.text();
    detail = text.slice(0, 400);
  } catch {
    detail = "";
  }
  throw new Error(`GitHub dispatch ${res.status}${detail ? `: ${detail}` : ""}`);
}
