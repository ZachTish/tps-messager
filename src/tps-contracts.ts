export const TPS_EVENTS = {
  CONTROLLER_ROLE_CHANGED: "tps:controller-role-changed",
  CONTROLLER_SETTINGS_CHANGED: "tps:controller-settings-changed",
  CALENDAR_SETTINGS_CHANGED: "tps:calendar-settings-changed",
  CALENDAR_SYNC_STARTED: "tps:calendar-sync-started",
  CALENDAR_SYNC_COMPLETED: "tps:calendar-sync-completed",
  REMINDERS_UPDATED: "tps:reminders-updated",
  FILES_UPDATED: "tps:files-updated",
  GCM_EXPLICIT_ACTION: "tps:gcm-explicit-action",
  CALENDAR_EXPLICIT_REFRESH: "tps:calendar-explicit-refresh",
} as const;

export const TPS_LEGACY_EVENTS = {
  CALENDAR_SETTINGS_CHANGED: "tps-calendar-settings-changed",
  GCM_FILES_UPDATED: "tps-gcm-files-updated",
  GCM_EXPLICIT_ACTION: "tps-gcm-explicit-action",
  CALENDAR_EXPLICIT_REFRESH: "tps-calendar-explicit-refresh",
  GCM_DELETE_COMPLETE: "tps-gcm-delete-complete",
} as const;

export type TPSEventName = typeof TPS_EVENTS[keyof typeof TPS_EVENTS];
export type TPSLegacyEventName = typeof TPS_LEGACY_EVENTS[keyof typeof TPS_LEGACY_EVENTS];

export interface TPSEventPayload {
  sourcePluginId: string;
  timestamp: number;
}

export interface TPSFilesUpdatedPayload extends TPSEventPayload {
  paths: string[];
}

export interface TPSControllerRoleChangedPayload extends TPSEventPayload {
  role: "controller" | "user";
}

export interface TPSCalendarSettingsSnapshot<TExternalCalendarConfig = unknown> {
  externalCalendars: TExternalCalendarConfig[];
  externalCalendarFilter: string;
}

export interface TPSControllerApi<TSettings = unknown, TExternalCalendarConfig = unknown> {
  isController?: () => boolean;
  getRole?: () => "controller" | "user";
  getSettings?: () => TSettings;
  getCalendarSettingsSnapshot?: () => TPSCalendarSettingsSnapshot<TExternalCalendarConfig> | Promise<TPSCalendarSettingsSnapshot<TExternalCalendarConfig>>;
}

export interface TPSNotifierDeliveryReceipt {
  readonly outcome: "accepted";
  readonly httpStatus: number;
  readonly providerMessageId: string;
}

export type TPSNotifierErrorCode =
  | "not-ready"
  | "settings-read-only"
  | "delivery-disabled"
  | "delivery-invalidated"
  | "transport-dirty"
  | "invalid-configuration"
  | "invalid-payload"
  | "internal-error"
  | "delivery-busy"
  | "delivery-rejected"
  | "delivery-unconfirmed";

export interface TPSNotifierErrorShape extends Error {
  readonly code: TPSNotifierErrorCode;
  readonly attempted: boolean;
  readonly deliveryState: "not-attempted" | "rejected" | "unconfirmed";
  /** Whether retrying can create a duplicate, not whether the same request will succeed. */
  readonly duplicateSafeToRetry: boolean;
  readonly httpStatus?: number;
}

export interface TPSNotifierDiagnostic {
  readonly valid: true;
  readonly serverHost: string;
  readonly secure: boolean;
  readonly priority: number;
  readonly hasClick: boolean;
  readonly bodyBytes: number;
}

export interface TPSNotifierApi<TFile = unknown> {
  readonly apiVersion: 2;
  readonly capabilities: Readonly<{
    structuredReceipts: true;
    redactedDiagnostics: true;
    stableSequenceIds: false;
  }>;
  send(request: Readonly<{ title?: string; body: string; file?: TFile }>): Promise<TPSNotifierDeliveryReceipt>;
  validate(request: Readonly<{ title?: string; body: string; file?: TFile }>): TPSNotifierDiagnostic;
  sendNotification(title: string, body: string, file?: TFile): Promise<void>;
  sendMessage(text: string, file?: TFile, title?: string): Promise<void>;
  /** @deprecated Sensitive compatibility surface. Prefer validate(). */
  dryRunMessage(text: string, file?: TFile, title?: string): unknown;
}
