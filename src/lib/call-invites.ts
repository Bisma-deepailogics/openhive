// Client-side call inviting.
//
// Rings a specific profile directly using a Supabase Realtime broadcast on a
// per-user channel ("ring-<userId>"). This needs no extra database tables —
// every signed-in client subscribes to its own ring channel and surfaces an
// incoming-call banner, exactly like the realtime row watcher does for
// channel-wide huddles.

import { getSupabaseClient } from '@/lib/supabase/client'

export interface CallInvitePayload {
  callId: string
  channelId: string
  /** LiveKit room name so the receiver can double-check before joining */
  roomName?: string
  isVideo: boolean
  callerName: string
  channelLabel: string
}

/**
 * Send a direct "ring" to a user. Resolves true when the receiving client
 * acknowledged; resolves false when the user is offline / unreachable or on
 * any failure — callers should treat this as best-effort (members can always
 * join themselves via the channel's active-call indicator).
 */
export async function ringProfile(
  profileId: string,
  payload: CallInvitePayload
): Promise<boolean> {
  const client = getSupabaseClient()
  if (!client) return false

  let channel = client.channel(`ring-${profileId}`)

  try {
    const subscribed = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 4000)
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout)
          resolve(true)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timeout)
          resolve(false)
        }
        // 'CLOSED' keeps waiting until the timeout fires.
      })
    })

    if (!subscribed) return false

    // Ask for an ack so we know whether anyone actually heard the ring.
    const result = await channel.send({
      type: 'broadcast',
      event: 'call-invite',
      payload,
    })

    return result === 'ok'
  } catch {
    return false
  } finally {
    try {
      await client.removeChannel(channel)
    } catch {
      // Channel may already be detached; safe to ignore.
    }
  }
}
