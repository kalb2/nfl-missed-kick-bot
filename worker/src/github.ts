export interface DispatchInput {
  owner: string;
  repo: string;
  eventType: string;
  token: string;
  payload: Record<string, unknown>;
}

const GITHUB_API_VERSION = "2022-11-28";

/** Strip credentials so Worker HTTP/logs never echo a PAT. */
export function sanitizePublicText(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+/g, "[redacted-token]");
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof Error) return sanitizePublicText(error.message);
  return "Unknown error";
}

export class GitHubDispatchError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    const cleanDetail = sanitizePublicText(detail);
    super(sanitizePublicText(`GitHub dispatch ${status}${cleanDetail ? `: ${cleanDetail}` : ""}`));
    this.name = "GitHubDispatchError";
    this.status = status;
    this.detail = cleanDetail;
  }
}

export function isGitHubDispatchError(error: unknown): error is GitHubDispatchError {
  return error instanceof GitHubDispatchError;
}

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
  throw new GitHubDispatchError(res.status, detail);
}
