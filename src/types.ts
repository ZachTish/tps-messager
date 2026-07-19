import type { TPSNotifierDiagnostic } from './tps-contracts';

export interface TPSNotifierSettings {
    settingsVersion: number;
    enabled: boolean;
    enableManualComposer: boolean;
    ntfyServer: string;
    ntfyTopic: string;
    ntfyPriority: number;
    enableLogging: boolean;
}

export interface TransportSettingsDraft {
    ntfyServer: string;
    ntfyTopic: string;
    ntfyPriority: number;
}

export type NotifierDiagnostic = TPSNotifierDiagnostic;
