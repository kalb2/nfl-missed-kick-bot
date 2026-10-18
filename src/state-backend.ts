import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where the handled-plays list lives. The Actions cache is NOT a backend for
 * it any more: GitHub evicts caches (7 days idle / 10 GB), and a cache miss
 * used to look exactly like "nothing handled yet".
 */
export interface StateSnapshot {
  /** Parsed JSON document. */
  data: unknown;
  /** Opaque version used for optimistic writes (git blob sha for GitHub). */
  version?: string;
}

export interface StateBackend {
  readonly description: string;
  /** Resolves to null only when the state document definitely does not exist (404 / ENOENT). Throws on any other failure. */
  read(): Promise<StateSnapshot | null>;
  /** Writes the document; `version` is the value read() returned (undefined = create). Returns the new version. */
  write(data: unknown, version: string | undefined, message: string): Promise<string | undefined>;
}

export class StateUnavailableError extends Error {
  constructor(message: string, readonly missing = false) {
    super(message);
    this.name = "StateUnavailableError";
  }
}

export class FileStateBackend implements StateBackend {
  constructor(readonly filePath: string) {}

  get description(): string {
    return `file ${this.filePath}`;
  }

  async read(): Promise<StateSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return { data: JSON.parse(raw) };
  }

  async write(data: unknown): Promise<string | undefined> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return undefined;
  }
}

export interface GitHubStateOptions {
  /** owner/name */
  repo: string;
  token: string;
  /** Dedicated branch that only ever holds bot state, e.g. "bot-state". */
  branch: string;
  /** Path of the JSON file on that branch. */
  filePath: string;
  fetchImpl?: typeof fetch;
}

/**
 * A JSON file committed to a dedicated branch through the GitHub contents API.
 * Survives Actions cache eviction, runner restarts, Worker redeploys and repo
 * re-clones, and every change is an auditable commit. Writes carry the blob
 * sha so a concurrent writer fails (409) instead of silently clobbering.
 */
export class GitHubBranchStateBackend implements StateBackend {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: GitHubStateOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get description(): string {
    return `github ${this.opts.repo}@${this.opts.branch}:${this.opts.filePath}`;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.opts.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  private url(pathname: string): string {
    return `https://api.github.com/repos/${this.opts.repo}${pathname}`;
  }

  private contentsPath(): string {
    return `/contents/${this.opts.filePath.split("/").map(encodeURIComponent).join("/")}`;
  }

  async read(): Promise<StateSnapshot | null> {
    const res = await this.fetchImpl(
      this.url(`${this.contentsPath()}?ref=${encodeURIComponent(this.opts.branch)}`),
      { headers: this.headers() },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET state: HTTP ${res.status}`);
    const body = (await res.json()) as { content?: string; encoding?: string; sha?: string };
    if (body.encoding !== "base64" || typeof body.content !== "string") {
      throw new Error("GitHub GET state: unexpected encoding (file over 1 MB?)");
    }
    const raw = Buffer.from(body.content, "base64").toString("utf8");
    return { data: JSON.parse(raw), version: body.sha };
  }

  async write(data: unknown, version: string | undefined, message: string): Promise<string | undefined> {
    if (version === undefined) await this.ensureBranch();
    const res = await this.fetchImpl(this.url(this.contentsPath()), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        message,
        branch: this.opts.branch,
        content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8").toString("base64"),
        ...(version ? { sha: version } : {}),
      }),
    });
    if (!res.ok) throw new Error(`GitHub PUT state: HTTP ${res.status}`);
    const body = (await res.json()) as { content?: { sha?: string } };
    return body.content?.sha;
  }

  /** Bootstrap only: create the state branch as an orphan commit with no other files. */
  private async ensureBranch(): Promise<void> {
    const ref = await this.fetchImpl(this.url(`/git/ref/heads/${encodeURIComponent(this.opts.branch)}`), {
      headers: this.headers(),
    });
    if (ref.ok) return;
    if (ref.status !== 404) throw new Error(`GitHub GET ref: HTTP ${ref.status}`);
    const post = async (pathname: string, payload: unknown): Promise<{ sha: string }> => {
      const res = await this.fetchImpl(this.url(pathname), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`GitHub POST ${pathname}: HTTP ${res.status}`);
      return (await res.json()) as { sha: string };
    };
    const readme =
      "Bot state for the missed-kick poller. Written by .github/workflows/poll.yml; do not merge into main.\n";
    const tree = await post("/git/trees", {
      tree: [{ path: "README.md", mode: "100644", type: "blob", content: readme }],
    });
    const commit = await post("/git/commits", { message: "Create bot-state branch", tree: tree.sha, parents: [] });
    await post("/git/refs", { ref: `refs/heads/${this.opts.branch}`, sha: commit.sha });
  }
}
