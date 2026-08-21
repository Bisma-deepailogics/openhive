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
    // Set user ONLINE
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
      } catch (error) {
        console.error('Failed to set user online:', error)
      }
    }

    // -----------------------------------------
    // Set user OFFLINE
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
      } catch (error) {
        console.error('Failed to set user offline:', error)
      }
    }

    // -----------------------------------------
    // HEARTBEAT
    // User is actively using the app
    // -----------------------------------------
    const heartbeat = async () => {
      if (isCleaningUp) return

      // If tab is not visible, don't keep user online
      if (document.visibilityState !== 'visible') return

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
    // -----------------------------------------
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        // User came back to the app
        await setOnline()
      } else {
        // User switched/minimized the tab
        await setOffline()
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
    // Start heartbeat
    // -----------------------------------------
    const interval = setInterval(
      heartbeat,
      HEARTBEAT_INTERVAL
    )

    // -----------------------------------------
    // Event listeners
    // -----------------------------------------
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