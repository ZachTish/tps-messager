/**
 * type-guards.ts — Safe typed accessor for Obsidian's private plugin registry.
 */
import type { App, Plugin } from 'obsidian';

interface AppWithPluginsRegistry extends App {
    plugins?: {
        getPlugin?: (id: string) => Plugin | null;
        plugins?: Record<string, Plugin>;
    };
}

/**
 * Look up a community plugin by its manifest ID.
 * Returns null when the plugin is not installed or not yet loaded.
 */
export function getPluginById<T extends Plugin = Plugin>(
    app: App,
    pluginId: string,
): T | null {
    const reg = app as AppWithPluginsRegistry;
    const direct = reg.plugins?.getPlugin?.(pluginId);
    if (direct) return direct as T;
    return (reg.plugins?.plugins?.[pluginId] as T) ?? null;
}

/** Returns true when `value` is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
