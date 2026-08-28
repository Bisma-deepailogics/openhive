// Server-side LiveKit credential resolution.
//
// Credentials can come from two places:
//   1. Per-workspace config saved by admins (workspace_settings table)
//   2. Deployment-level .env.local (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)
//
// Workspace settings take precedence when fully configured; env vars act as a
// global fallback so self-hosted setups configured via the setup wizard work
// without having to re-enter credentials in every workspace's settings.

export interface ResolvedLiveKitConfig {
  url: string | null
  apiKey: string | null
  apiSecret: string | null
  /** True when a usable url + key + secret trio is available */
  configured: boolean
  /** False only when an admin explicitly disabled calls for a DB-configured workspace */
  enabled: boolean
}

export interface LiveKitWorkspaceSettings {
  livekit_url?: string | null
  livekit_api_key?: string | null
  livekit_api_secret?: string | null
  calls_enabled?: boolean | null
}

/** Normalize a LiveKit URL: trim whitespace and fix common scheme mistakes. */
export function normalizeLiveKitUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/^\/+/, '')
  if (!trimmed) return ''

  if (/^wss:\/\//i.test(trimmed)) return trimmed
  if (/^ws:\/\//i.test(trimmed)) return trimmed
  if (/^https:\/\//i.test(trimmed)) return 'wss://' + trimmed.slice(8)
  if (/^http:\/\//i.test(trimmed)) return 'ws://' + trimmed.slice(7)

  // No scheme provided — assume the standard secure websocket scheme.
  return 'wss://' + trimmed
}

const hasValue = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0

/**
 * Resolve effective LiveKit credentials for a workspace.
 * Pass the workspace_settings row (or null when no row exists).
 */
export function resolveLiveKitCredentials(
  settings?: LiveKitWorkspaceSettings | null
): ResolvedLiveKitConfig {
  // 1. Per-workspace configuration wins when complete.
  const dbUrl = hasValue(settings?.livekit_url)
    ? normalizeLiveKitUrl(settings!.livekit_url as string)
    : null
  const dbKey = hasValue(settings?.livekit_api_key) ? settings!.livekit_api_key!.trim() : null
  const dbSecret = hasValue(settings?.livekit_api_secret) ? settings!.livekit_api_secret!.trim() : null

  if (dbUrl && dbKey && dbSecret) {
    return {
      url: dbUrl,
      apiKey: dbKey,
      apiSecret: dbSecret,
      configured: true,
      // Admin explicitly configured this workspace — respect their toggle.
      enabled: settings?.calls_enabled !== false,
    }
  }

  // 2. Fall back to deployment-level environment variables.
  const envUrl = hasValue(process.env.LIVEKIT_URL)
    ? normalizeLiveKitUrl(process.env.LIVEKIT_URL!)
    : null
  const envKey = hasValue(process.env.LIVEKIT_API_KEY) ? process.env.LIVEKIT_API_KEY!.trim() : null
  const envSecret = hasValue(process.env.LIVEKIT_API_SECRET)
    ? process.env.LIVEKIT_API_SECRET!.trim()
    : null

  if (envUrl && envKey && envSecret) {
    return {
      url: envUrl,
      apiKey: envKey,
      apiSecret: envSecret,
      configured: true,
      // The deployment opted into calls globally via environment variables.
      enabled: true,
    }
  }

  return { url: null, apiKey: null, apiSecret: null, configured: false, enabled: false }
}
