import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from '@/types/database'

/**
 * Canonical channel name for a 1-on-1 DM between two profiles.
 */
export function dmChannelName(userAId: string, userBId: string): string {
  const ids = [userAId, userBId].sort()
  return `dm-${ids[0].slice(0, 8)}-${ids[1].slice(0, 8)}`
}

/**
 * Find the existing 1-on-1 DM channel between two profiles or create it
 * (channel + both channel_members rows). Returns the channel id.
 */
export async function findOrCreateDmChannel(
  client: SupabaseClient,
  workspaceId: string,
  user: Profile,
  otherUser: Profile
): Promise<string> {
  const dmName = dmChannelName(user.id, otherUser.id)

  const { data: existing } = await client
    .from('channels')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('name', dmName)
    .limit(1)

  if (existing && existing.length > 0) {
    return existing[0].id as string
  }

  const id = crypto.randomUUID()

  const { error } = await client.from('channels').insert({
    id,
    workspace_id: workspaceId,
    name: dmName,
    description: `Direct message between ${user.display_name} and ${otherUser.display_name}`,
    is_private: true,
    created_by: user.id,
  })
  if (error) throw error

  const { error: memberError } = await client.from('channel_members').insert([
    { channel_id: id, profile_id: user.id, role: 'admin' },
    { channel_id: id, profile_id: otherUser.id, role: 'admin' },
  ])
  if (memberError) throw memberError

  return id
}