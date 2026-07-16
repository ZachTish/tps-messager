export interface TPSNotifierSettings {
    settingsVersion: number;
    enabled: boolean;
    enableManualComposer: boolean;
    ntfyServer: string;
    ntfyTopic: string;
    ntfyPriority: number;
    enableLogging: boolean;
}

/** @deprecated Use TPSNotifierSettings. */
export type TPSMessagerSettings = TPSNotifierSettings;
