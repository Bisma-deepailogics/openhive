'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Phone, Video, X } from 'lucide-react'

import { useAppStore } from '@/lib/store/app-store'
import { getSupabaseClient } from '@/lib/supabase/client'
import type { CallInvitePayload } from '@/lib/call-invites'

import type { ActiveCall } from '@/types/database'

interface IncomingCall {
  call: ActiveCall
  callerName: string
  channelName: string
}

export function IncomingCallBanner() {
  const {
    user,
    isInCall,
    joinCall,
  } = useAppStore()

  const [incomingCall, setIncomingCall] =
    useState<IncomingCall | null>(null)

  const [joining, setJoining] = useState(false)

  const dismissedIdsRef = useRef<Set<string>>(new Set())
  const audioContextRef = useRef<AudioContext | null>(null)
  const ringtoneIntervalRef =
    useRef<ReturnType<typeof setInterval> | null>(null)
  const dismissTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopRingtone = useCallback(() => {
    if (ringtoneIntervalRef.current) {
      clearInterval(ringtoneIntervalRef.current)
      ringtoneIntervalRef.current = null
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
  }, [])

  const startRingtone = useCallback(() => {
    stopRingtone()

    try {
      const AudioContextClass =
        window.AudioContext ||
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext
          }
        ).webkitAudioContext

      if (!AudioContextClass) {
        return
      }

      const ctx = new AudioContextClass()

      audioContextRef.current = ctx

      const beep = () => {
        if (!audioContextRef.current) return

        const oscillator =
          audioContextRef.current.createOscillator()

        const gain =
          audioContextRef.current.createGain()

        oscillator.connect(gain)
        gain.connect(audioContextRef.current.destination)

        oscillator.frequency.value = 520
        oscillator.type = 'sine'

        gain.gain.setValueAtTime(
          0.0001,
          audioContextRef.current.currentTime
        )

        gain.gain.exponentialRampToValueAtTime(
          0.12,
          audioContextRef.current.currentTime + 0.01
        )

        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          audioContextRef.current.currentTime + 0.18
        )

        oscillator.start()
        oscillator.stop(
          audioContextRef.current.currentTime + 0.18
        )
      }

      beep()

      setTimeout(beep, 220)

      ringtoneIntervalRef.current = setInterval(() => {
        beep()
        setTimeout(beep, 220)
      }, 1600)
    } catch (error) {
      console.warn('Could not start ringtone:', error)
    }
  }, [stopRingtone])

  useEffect(() => {
    if (!user || isInCall) {
      setIncomingCall(null)
      stopRingtone()
      return
    }

    const client = getSupabaseClient()

    if (!client) {
      return
    }

    const channel = client
      .channel(`incoming-calls-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'active_calls',
        },
        async (payload) => {
          const call = payload.new as ActiveCall

          if (!call?.id) return

          if (call.started_by === user.id) {
            return
          }

          if (call.ended_at) {
            return
          }

          if (
            dismissedIdsRef.current.has(call.id)
          ) {
            return
          }

          if (
            useAppStore.getState().isInCall
          ) {
            return
          }

          /*
           * Check channel membership.
           */
          const { data: membership } =
            await client
              .from('channel_members')
              .select('profile_id')
              .eq('channel_id', call.channel_id)
              .eq('profile_id', user.id)
              .maybeSingle()

          if (!membership) {
            return
          }

          const { data: caller } = await client
            .from('profiles')
            .select('display_name')
            .eq('id', call.started_by)
            .maybeSingle()

          const state = useAppStore.getState()

          const allChannels = [
            ...state.channels,
            ...state.dmChannels,
          ]

          const channel = allChannels.find(
            (item) => item.id === call.channel_id
          )

          let channelName = 'Unknown'

          if (channel) {
            if (
              channel.name?.startsWith('dm-')
            ) {
              const dm = state.dmChannels.find(
                (item) => item.id === call.channel_id
              )

              channelName =
                dm?.otherUser?.display_name ||
                channel.name
            } else {
              channelName = `#${channel.name}`
            }
          }

          setIncomingCall({
            call,
            callerName:
              caller?.display_name || 'Someone',
            channelName,
          })
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'active_calls',
        },
        (payload) => {
          const call = payload.new as ActiveCall

          if (
            call.ended_at &&
            useAppStore.getState().activeCall?.id === call.id
          ) {
            useAppStore.getState().leaveCall()
          }

          setIncomingCall((current) => {
            if (
              current?.call.id === call.id &&
              call.ended_at
            ) {
              return null
            }

            return current
          })
        }
      )
      .subscribe()

    /*
     * Direct "ring" channel — other members can invite this user into an
     * ongoing call ("Add members" inside the call panel). Uses a Supabase
     * Realtime broadcast, so no database changes are required.
     */
    const ringChannel = client
      .channel(`ring-${user.id}`)
      .on(
        'broadcast',
        { event: 'call-invite' },
        async (message) => {
          const payload = message.payload as Partial<CallInvitePayload>

          if (!payload?.callId) {
            return
          }

          if (dismissedIdsRef.current.has(payload.callId)) {
            return
          }

          if (useAppStore.getState().isInCall) {
            return
          }

          const { data: callRow } = await client
            .from('active_calls')
            .select('*')
            .eq('id', payload.callId)
            .is('ended_at', null)
            .maybeSingle()

          if (!callRow) {
            return
          }

          setIncomingCall({
            call: callRow as ActiveCall,
            callerName: payload.callerName || 'Someone',
            channelName: payload.channelLabel || 'a conversation',
          })
        }
      )
      .subscribe()

    return () => {
      channel.unsubscribe()
      ringChannel.unsubscribe()
    }
  }, [user, isInCall, stopRingtone])

  useEffect(() => {
    if (!incomingCall) {
      stopRingtone()

      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }

      return
    }

    startRingtone()

    dismissTimerRef.current = setTimeout(() => {
      setIncomingCall(null)
      stopRingtone()
    }, 30000)

    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }

      stopRingtone()
    }
  }, [
    incomingCall?.call.id,
    startRingtone,
    stopRingtone,
  ])

  async function handleJoin() {
    if (!incomingCall || !user || joining) {
      return
    }

    setJoining(true)
    stopRingtone()

    try {
      const client = getSupabaseClient()

      if (!client) {
        throw new Error('Supabase is not configured')
      }

      const {
        data: {
          session,
        },
      } = await client.auth.getSession()

      if (!session) {
        throw new Error('Your session has expired')
      }

      /*
       * Check that the call is still active.
       */
      const { data: currentCall } = await client
        .from('active_calls')
        .select('*')
        .eq('id', incomingCall.call.id)
        .is('ended_at', null)
        .maybeSingle()

      if (!currentCall) {
        setIncomingCall(null)
        return
      }

      const callType =
        currentCall.type === 'video_call'
          ? 'video'
          : 'audio'

      await client
        .from('call_participants')
        .upsert(
          {
            call_id: currentCall.id,
            profile_id: user.id,
            joined_at: new Date().toISOString(),
            left_at: null,
            is_muted: false,
            is_camera_on: callType === 'video',
            is_sharing_screen: false,
          },
          {
            onConflict: 'call_id,profile_id',
          }
        )

      const workspace =
        useAppStore.getState().workspace

      const response = await fetch(
        '/api/livekit/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization:
              `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            roomName:
              currentCall.livekit_room_name,
            workspaceId: workspace?.id,
            identity: user.id,
            displayName:
              user.display_name ||
              user.email ||
              user.id,
          }),
        }
      )

      const result = await response.json()

      if (!response.ok) {
        throw new Error(
          result.error ||
            'Failed to get LiveKit token'
        )
      }

      joinCall(
        currentCall,
        result.token,
        result.url,
        // Answering a video invitation starts with the camera on
        { withVideo: currentCall.type === 'video_call' }
      )

      useAppStore
        .getState()
        .setCurrentChannelId(
          currentCall.channel_id
        )

      setIncomingCall(null)
    } catch (error) {
      console.error(
        'Failed to join call:',
        error
      )

      window.alert(
        error instanceof Error
          ? error.message
          : 'Could not join call'
      )
    } finally {
      setJoining(false)
    }
  }

  function handleDismiss() {
    if (incomingCall) {
      dismissedIdsRef.current.add(
        incomingCall.call.id
      )
    }

    setIncomingCall(null)
    stopRingtone()
  }

  if (!incomingCall) {
    return null
  }

  const isVideo =
    incomingCall.call.type === 'video_call'

  return (
    <div className="fixed top-0 left-0 right-0 z-[100]">
      <div
        className="mx-4 mt-3 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl"
        style={{ background: '#7C5CFC' }}
      >
        <div
          className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 animate-pulse"
          style={{
            background:
              'rgba(255,255,255,0.2)',
          }}
        >
          {isVideo ? (
            <Video className="h-5 w-5 text-white" />
          ) : (
            <Phone className="h-5 w-5 text-white" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">
            {incomingCall.callerName}{' '}
            is calling
          </p>

          <p className="text-xs text-white/70 truncate">
            {isVideo ? 'Video call' : 'Voice call'}{' '}
            in {incomingCall.channelName}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDismiss}
            className="h-9 px-4 rounded-lg text-xs font-semibold flex items-center gap-1.5"
            style={{
              background:
                'rgba(255,255,255,0.15)',
              color: '#fff',
            }}
          >
            <X className="h-3.5 w-3.5" />
            Dismiss
          </button>

          <button
            type="button"
            onClick={handleJoin}
            disabled={joining}
            className="h-9 px-4 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60"
            style={{
              background: '#22C55E',
              color: '#fff',
            }}
          >
            {isVideo ? (
              <Video className="h-3.5 w-3.5" />
            ) : (
              <Phone className="h-3.5 w-3.5" />
            )}

            {joining
              ? 'Joining...'
              : 'Join Call'}
          </button>
        </div>
      </div>
    </div>
  )
}