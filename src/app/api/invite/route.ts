import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(request: NextRequest) {
  try {
    const { email, workspaceId, workspaceName } = await request.json()

    if (!email || !workspaceId) {
      return NextResponse.json(
        { error: 'Missing email or workspaceId' },
        { status: 400 }
      )
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      )
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !serviceRoleKey || !supabaseAnonKey) {
      return NextResponse.json(
        { error: 'Service role key not configured. Add it in workspace settings.' },
        { status: 400 }
      )
    }

    // SECURITY: Verify caller is authenticated and is admin/owner of the workspace
    const authHeader = request.headers.get('authorization')

    if (!authHeader) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      )
    }

    const supabaseAuth = createClient(
      supabaseUrl,
      supabaseAnonKey,
      {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
      }
    )

    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Invalid session' },
        { status: 401 }
      )
    }

    // Create admin client with service_role key
    const supabaseAdmin = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    )

    // Check that caller is admin/owner of the target workspace
    const { data: membership, error: membershipError } = await supabaseAdmin
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('profile_id', user.id)
      .single()

    if (membershipError || !membership) {
      return NextResponse.json(
        { error: 'Only admins can invite members' },
        { status: 403 }
      )
    }

    if (!['owner', 'admin'].includes(membership.role)) {
      return NextResponse.json(
        { error: 'Only admins can invite members' },
        { status: 403 }
      )
    }

    // Check if user already exists
    const { data: existingUsers, error: listUsersError } =
      await supabaseAdmin.auth.admin.listUsers()

    if (listUsersError) {
      throw listUsersError
    }

    const existingUser = existingUsers?.users.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    )

    if (existingUser) {
      // User exists — add them to workspace directly

      // Check if already a member
      const { data: existing, error: existingMemberError } =
        await supabaseAdmin
          .from('workspace_members')
          .select('profile_id')
          .eq('workspace_id', workspaceId)
          .eq('profile_id', existingUser.id)
          .limit(1)

      if (existingMemberError) {
        throw existingMemberError
      }

      if (existing && existing.length > 0) {
        return NextResponse.json(
          {
            error: 'This person is already a member',
            alreadyMember: true,
          },
          { status: 400 }
        )
      }

      // Add to workspace
      const { error: insertMemberError } = await supabaseAdmin
        .from('workspace_members')
        .insert({
          workspace_id: workspaceId,
          profile_id: existingUser.id,
          role: 'member',
        })

      if (insertMemberError) {
        throw insertMemberError
      }

      // Add to all public channels
      const { data: channels, error: channelsError } = await supabaseAdmin
        .from('channels')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('is_private', false)

      if (channelsError) {
        throw channelsError
      }

      if (channels) {
        for (const channel of channels) {
          const { error: channelMemberError } = await supabaseAdmin
            .from('channel_members')
            .insert({
              channel_id: channel.id,
              profile_id: existingUser.id,
            })

          // Ignore duplicate channel membership errors
          if (
            channelMemberError &&
            !channelMemberError.message?.toLowerCase().includes('duplicate')
          ) {
            throw channelMemberError
          }
        }
      }

      const displayName =
        existingUser.user_metadata?.display_name || email

      return NextResponse.json({
        success: true,
        added: true,
        displayName,
      })
    }

    // User doesn't exist — send invite email via Supabase Auth.
    //
    // The emailed link must work on the RECIPIENT'S machine. This server's
    // origin (http://127.0.0.1:<port>) only exists on the sender's computer,
    // so prefer, in order:
    //   1. NEXT_PUBLIC_APP_URL — a shared deployment URL (e.g. Vercel)
    //   2. orbit:// deep link — opens the recipient's installed app
    //      (allowlisted during setup, see provisioner.configureSiteUrl)
    // and fall back to this server's origin if Supabase rejects the deep link.
    const emailParams = `workspace=${workspaceId}&email=${encodeURIComponent(email)}`
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')
    const primaryRedirectTo = appUrl
      ? `${appUrl}/auth?${emailParams}`
      : `orbit://join?${emailParams}`
    const fallbackRedirectTo = `${request.nextUrl.origin}/auth?${emailParams}`

    const inviteData = {
      workspace_id: workspaceId,
      workspace_name: workspaceName || 'Orbit',
      display_name: email.split('@')[0],
    }

    let { error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: primaryRedirectTo,
      data: inviteData,
    })

    if (
      inviteError &&
      primaryRedirectTo !== fallbackRedirectTo &&
      /redirect|allow/i.test(inviteError.message || '')
    ) {
      // Supabase project's redirect allowlist doesn't include the deep-link
      // scheme yet — retry with this server's origin so the invite still goes
      // out (the recipient can also paste the link into their app).
      console.warn('[invite] Deep-link redirect rejected, retrying with server origin:', inviteError.message)
      const retry = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        redirectTo: fallbackRedirectTo,
        data: inviteData,
      })
      inviteError = retry.error
    }

    if (inviteError) {
      // Handle already invited/registered case
      if (
        inviteError.message?.includes('already been registered') ||
        inviteError.message?.includes('already exists')
      ) {
        return NextResponse.json(
          {
            error:
              'This email has already been invited. They should check their inbox.',
            alreadyInvited: true,
          },
          { status: 400 }
        )
      }

      throw inviteError
    }

    return NextResponse.json({
      success: true,
      invited: true,
      message: `Invitation email sent to ${email}`,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to send invite',
      },
      { status: 500 }
    )
  }
}
