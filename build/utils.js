import fetch from "node-fetch";
import { Agent } from "node:http";
const URL = "http://127.0.0.1";
const HTTP_AGENT = new Agent({
    keepAlive: false,
    maxSockets: 4,
});
export async function api(port, slug, args = {}, timeoutMs = 120_000) {
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
            throw new Error(`Failed to execute command (${slug}): HTTP ${res.status}` +
                (details ? ` - ${details}` : ""));
        }
        const json = (await res.json());
        if (!json.success) {
            throw new Error(`Failed to call API (${slug}): ${json.error || "Unknown error"}`);
        }
        return json.data;
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`StarUML did not respond to ${slug} within ${timeoutMs}ms. ` +
                "StarUML may be busy generating, laying out, or exporting a diagram.");
        }
        throw error;
    }
    finally {
        clearTimeout(timeout);
    }
}
