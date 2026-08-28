'use client'

import { useEffect } from 'react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAppStore } from '@/lib/store/app-store'

const HEARTBEAT_INTERVAL = 15_000 // 15 seconds

export function usePresence() {
  const { user } = useAppStore()

  useEffect(() => {
    if (!user) return

    const client = getSupabaseClient()
    if (!client) return

    let isCleaningUp = false

    // -----------------------------------------
    // Set user ONLINE (DB + local store)
    // -----------------------------------------
    const setOnline = async () => {
      if (isCleaningUp) return

      try {
        await client
          .from('profiles')
          .update({
            is_online: true,
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', user.id)

        if (isCleaningUp) return

        // Sync local presence state so the green
        // status dot updates instantly (no refresh)
        const state = useAppStore.getState()
        state.setProfileOnline(user.id, true)

        if (state.user?.id === user.id && !state.user.is_online) {
          state.setUser({ ...state.user, is_online: true })
        }
      } catch (error) {
        console.error('Failed to set user online:', error)
      }
    }

    // -----------------------------------------
    // Set user OFFLINE (DB + local store)
    // -----------------------------------------
    const setOffline = async () => {
      try {
        await client
          .from('profiles')
          .update({
            is_online: false,
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', user.id)

        useAppStore.getState().setProfileOnline(user.id, false)
      } catch (error) {
        console.error('Failed to set user offline:', error)
      }
    }

    // -----------------------------------------
    // HEARTBEAT
    // Keeps the user online while the app is
    // open, regardless of tab focus
    // -----------------------------------------
    const heartbeat = async () => {
      if (isCleaningUp) return

      try {
        await client
          .from('profiles')
          .update({
            is_online: true,
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', user.id)
      } catch (error) {
        console.error('Presence heartbeat failed:', error)
      }
    }

    // -----------------------------------------
    // TAB VISIBILITY
    // When the user returns to the app, refresh
    // their online status right away.
    // NOTE: switching tabs no longer marks the
    // user offline - online means "app is open".
    // -----------------------------------------
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setOnline()
      }
    }

    // -----------------------------------------
    // Browser close / refresh / navigation
    // -----------------------------------------
    const handlePageHide = () => {
      // Best effort.
      // Browser can terminate async requests during page unload.
      client
        .from('profiles')
        .update({
          is_online: false,
          last_seen_at: new Date().toISOString(),
        })
        .eq('id', user.id)
    }

    // -----------------------------------------
    // Initial state
    // -----------------------------------------
    setOnline()

    // -----------------------------------------
    // Realtime presence for ALL members.
    // Updates the shared online set so every
    // member list, DM, search result and profile
    // panel shows live green/gray status.
    // -----------------------------------------
    const presenceSub = client
      .channel('global-presence-watcher')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
        },
        (payload) => {
          const updatedProfile = payload.new as {
            id?: string
            is_online?: boolean
          }

          if (!updatedProfile.id) return

          useAppStore
            .getState()
            .setProfileOnline(
              updatedProfile.id,
              updatedProfile.is_online === true
            )
        }
      )
      .subscribe()

    // -----------------------------------------
    // Start heartbeat
    // -----------------------------------------
    const interval = setInterval(
      heartbeat,
      HEARTBEAT_INTERVAL
    )

    // Event listeners
    document.addEventListener(
      'visibilitychange',
      handleVisibilityChange
    )

    window.addEventListener(
      'pagehide',
      handlePageHide
    )

    // -----------------------------------------
    // Cleanup
    // -----------------------------------------
    return () => {
      isCleaningUp = true

      clearInterval(interval)

      presenceSub.unsubscribe()

      document.removeEventListener(
        'visibilitychange',
        handleVisibilityChange
      )

      window.removeEventListener(
        'pagehide',
        handlePageHide
      )

      // Normal React cleanup
      setOffline()
    }
  }, [user])
}
