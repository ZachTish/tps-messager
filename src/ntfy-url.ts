export type NtfyTargetValidation =
    | { ok: true; url: string }
    | {
        ok: false;
        reason:
            | 'server-required'
            | 'server-invalid'
            | 'server-too-long'
            | 'protocol-unsupported'
            | 'credentials-unsupported'
            | 'query-unsupported'
            | 'fragment-unsupported'
            | 'topic-invalid';
    };

export function validateNtfyTarget(server: unknown, topic: unknown): NtfyTargetValidation {
    const base = typeof server === 'string' ? server.trim() : '';
    const normalizedTopic = typeof topic === 'string' ? topic.trim() : '';
    if (!base) return { ok: false, reason: 'server-required' };
    if (base.length > 2048) return { ok: false, reason: 'server-too-long' };
    if (!/^[-_A-Za-z0-9]{1,64}$/.test(normalizedTopic)) {
        return { ok: false, reason: 'topic-invalid' };
    }
    if (/[\u0000-\u001F\u007F-\u009F\\]/.test(base)) {
        return { ok: false, reason: 'server-invalid' };
    }
    if (base.includes('?')) return { ok: false, reason: 'query-unsupported' };
    if (base.includes('#')) return { ok: false, reason: 'fragment-unsupported' };

    let parsed: URL;
    try {
        parsed = new URL(base);
    } catch {
        return { ok: false, reason: 'server-invalid' };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { ok: false, reason: 'protocol-unsupported' };
    }
    if (!parsed.hostname) return { ok: false, reason: 'server-invalid' };
    if (parsed.username || parsed.password) {
        return { ok: false, reason: 'credentials-unsupported' };
    }
    if (parsed.search) return { ok: false, reason: 'query-unsupported' };
    if (parsed.hash) return { ok: false, reason: 'fragment-unsupported' };

    const basePath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${basePath}/${normalizedTopic}`;
    return { ok: true, url: parsed.toString() };
}

export function buildNtfyUrl(server: unknown, topic: unknown): string | null {
    const validation = validateNtfyTarget(server, topic);
    return validation.ok ? validation.url : null;
}
