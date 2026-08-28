import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { AccessToken } from 'livekit-server-sdk'
import { resolveLiveKitCredentials } from '@/lib/server/livekit'

export async function POST(request: NextRequest) {
  try {
    const { roomName, workspaceId, identity, displayName } = await request.json()

    if (!roomName || !workspaceId || !identity) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
    }

    // Use the user's auth token to verify identity
    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    })

    // Verify user session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    }

    // Look up workspace settings for LiveKit credentials (row may not exist)
    const { data: settings } = await supabase
      .from('workspace_settings')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    // Resolve credentials: per-workspace settings take precedence,
    // deployment-level .env.local values (LIVEKIT_URL / LIVEKIT_API_KEY /
    // LIVEKIT_API_SECRET) act as a global fallback.
    const livekit = resolveLiveKitCredentials(settings)

    if (!livekit.configured || !livekit.url || !livekit.apiKey || !livekit.apiSecret) {
      return NextResponse.json(
        { error: 'LiveKit is not configured. Add credentials in Workspace Settings → Calls, or set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env.local.' },
        { status: 400 }
      )
    }

    if (!livekit.enabled) {
      return NextResponse.json({ error: 'Calls are disabled for this workspace' }, { status: 400 })
    }

    // SECURITY: Use verified user.id as identity (not client-supplied value)
    // This prevents identity spoofing — the client can suggest a displayName
    // but the identity is always the authenticated user's ID
    const token = new AccessToken(livekit.apiKey, livekit.apiSecret, {
      identity: user.id,
      name: displayName || user.email || user.id,
    })

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    })

    const jwt = await token.toJwt()

    return NextResponse.json({
      token: jwt,
      url: livekit.url,
    })
  } catch (error) {
    console.error('LiveKit token error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate token' },
      { status: 500 }
    )
  }
}
