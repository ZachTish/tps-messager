// Generated from settings UI copy. Run npm run settings:search; do not edit.
export const SETTINGS_SEARCH_ROUTES = {
  "delivery": "Delivery",
  "composer": "Composer",
  "diagnostics": "Diagnostics"
} as const;
export const SETTINGS_SEARCH_ENTRIES = [
  {"name":"Enable delivery transport","desc":"Master toggle for outbound notification delivery.","aliases":["Enable delivery transport"],"route":"delivery"},
  {"name":"ntfy Server","desc":"The ntfy server URL (e.g., https://ntfy.sh)","aliases":["ntfy Server","https://ntfy.sh"],"route":"delivery"},
  {"name":"ntfy Topic","desc":"","aliases":["ntfy Topic","my-reminders"],"route":"delivery"},
  {"name":"Priority","desc":"","aliases":["Priority"],"route":"delivery"},
  {"name":"Enable manual composer command","desc":"Registers the “Send Custom Notification” command in the command palette.","aliases":["Enable manual composer command"],"route":"composer"},
  {"name":"Send Test Notification","desc":"","aliases":["Send Test Notification","Send Test","Sending..."],"route":"composer"},
  {"name":"Enable Logging","desc":"","aliases":["Enable Logging"],"route":"diagnostics"},
  {"name":"Dry Run Delivery Setup","desc":"Validate the ntfy URL, headers, priority, and fallback body without sending a network request.","aliases":["Dry Run Delivery Setup","Dry Run"],"route":"diagnostics"},
  {"name":"Delivery","desc":"Open this settings area.","aliases":["Delivery transport is disabled. Enable it above to configure server/topic settings."],"route":"delivery"},
  {"name":"Composer","desc":"Open this settings area.","aliases":["Enable both delivery transport and the manual composer before sending a test notification."],"route":"composer"}
] as const;
