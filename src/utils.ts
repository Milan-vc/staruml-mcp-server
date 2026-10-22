import fetch from "node-fetch";
import { Agent } from "node:http";

const URL = "http://127.0.0.1";
const HTTP_AGENT = new Agent({
  keepAlive: false,
  maxSockets: 4,
});

type CommandResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

export async function api<T = unknown>(
  port: number,
  slug: string,
  args: unknown = {},
  timeoutMs = 120_000
): Promise<T> {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(`${URL}:${port}${slug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Connection: "close",
      },
      body: JSON.stringify(args),
      signal: controller.signal,
      agent: HTTP_AGENT,
    });

    if (!res.ok) {
      const details = await res.text();

      throw new Error(
        `Failed to execute command (${slug}): HTTP ${res.status}` +
        (details ? ` - ${details}` : "")
      );
    }

    const json = (await res.json()) as CommandResponse<T>;

    if (!json.success) {
      throw new Error(
        `Failed to call API (${slug}): ${json.error || "Unknown error"}`
      );
    }

    return json.data as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `StarUML did not respond to ${slug} within ${timeoutMs}ms. ` +
        "StarUML may be busy generating, laying out, or exporting a diagram."
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
