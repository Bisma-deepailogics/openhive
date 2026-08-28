import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveLiveKitCredentials } from '@/lib/server/livekit'

// GET /api/livekit/status?workspaceId=<uuid>
//
// Tells the client whether LiveKit is available for a workspace without
// exposing any secrets. The resolution mirrors /api/livekit/token:
// per-workspace settings first, then deployment-level env fallback.
export async function GET(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
    }

    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    })

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    }

    const workspaceId = request.nextUrl.searchParams.get('workspaceId')
    if (!workspaceId) {
      return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 })
    }

    const { data: settings } = await supabase
      .from('workspace_settings')
      .select('livekit_url, livekit_api_key, livekit_api_secret, calls_enabled')
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    const resolved = resolveLiveKitCredentials(settings)

    // Only expose booleans — never credentials.
    return NextResponse.json({
      configured: resolved.configured,
      enabled: resolved.enabled,
    })
  } catch (error) {
    console.error('LiveKit status error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to check LiveKit status' },
      { status: 500 }
    )
  }
}
