export function buildNtfyUrl(server: string, topic: string): string | null {
    const base = (server || "").replace(/\/+$/, "");
    const normalizedTopic = (topic || "").trim();
    if (!base || !normalizedTopic) return null;
    if (!/^https?:\/\//i.test(base)) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalizedTopic)) return null;
    return `${base}/${normalizedTopic}`;
}
