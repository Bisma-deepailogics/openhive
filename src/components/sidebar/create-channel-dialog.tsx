'use client'

import Image from 'next/image'
import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Loader2, Hash, Lock, X, Circle } from 'lucide-react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAppStore } from '@/lib/store/app-store'
import type { Channel, Profile } from '@/types/database'

interface CreateChannelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateChannelDialog({
  open,
  onOpenChange,
}: CreateChannelDialogProps) {
  const {
    workspace,
    user,
    addChannel,
    setCurrentChannelId,
    onlineProfileIds,
    seedOnlineProfiles,
  } = useAppStore()

  const isProfileOnline = (profile: Profile) =>
    profile.is_online === true || onlineProfileIds.has(profile.id)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Member invite
  const [allMembers, setAllMembers] = useState<Profile[]>([])
  const [memberSearch, setMemberSearch] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<Profile[]>([])

  // Prevent double-submit even before React state updates
  const creatingRef = useRef(false)

  useEffect(() => {
    if (!open || !workspace) return

    const supabaseClient = getSupabaseClient()
    if (!supabaseClient) return
    const client = supabaseClient

    async function loadMembers() {
      const { data, error: membersError } = await client
        .from('workspace_members')
        .select('profile:profiles(*)')
        .eq('workspace_id', workspace!.id)

      if (membersError) {
        console.error(
          'Failed to load workspace members:',
          membersError
        )
        return
      }

      if (data) {
        const profiles = data
          .map(
            (d: Record<string, unknown>) =>
              d.profile as Profile
          )
          .filter(
            (profile) =>
              profile && profile.id !== user?.id
          )

        setAllMembers(profiles)
        seedOnlineProfiles(profiles)
      }
    }

    loadMembers()
  }, [open, workspace, user])

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setName('')
      setDescription('')
      setIsPrivate(false)
      setSelectedMembers([])
      setMemberSearch('')
      setError(null)
      setLoading(false)

      // Make absolutely sure the creation lock is released
      creatingRef.current = false
    }
  }, [open])

  function formatChannelName(value: string) {
    return value
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  const filteredMembers = allMembers.filter(
    (member) =>
      !selectedMembers.some(
        (selected) => selected.id === member.id
      ) &&
      (member.display_name
        .toLowerCase()
        .includes(memberSearch.toLowerCase()) ||
        member.email
          ?.toLowerCase()
          .includes(memberSearch.toLowerCase()))
  )

  function addMember(member: Profile) {
    setSelectedMembers((prev) => {
      if (prev.some((item) => item.id === member.id)) {
        return prev
      }

      return [...prev, member]
    })

    setMemberSearch('')
  }

  function removeMember(memberId: string) {
    setSelectedMembers((prev) =>
      prev.filter((member) => member.id !== memberId)
    )
  }

  async function handleCreate(
    e: React.FormEvent<HTMLFormElement>
  ) {
    e.preventDefault()
    e.stopPropagation()

    // HARD LOCK:
    // Prevents two create requests from happening at once.
    if (creatingRef.current) {
      return
    }

    const client = getSupabaseClient()

    if (!client || !workspace || !user) {
      setError('Unable to create channel. Please sign in again.')
      return
    }

    const channelName = formatChannelName(name)

    if (!channelName) {
      setError('Please enter a valid channel name.')
      return
    }

    // Lock immediately BEFORE any async operation
    creatingRef.current = true
    setLoading(true)
    setError(null)

    try {
      // -------------------------------------------------------
      // 1. Get authenticated session
      // -------------------------------------------------------
      const {
        data: { session },
        error: sessionError,
      } = await client.auth.getSession()

      if (sessionError) {
        throw sessionError
      }

      if (!session) {
        throw new Error('Not authenticated')
      }

      // -------------------------------------------------------
      // 2. Check if channel already exists
      // -------------------------------------------------------
      const {
        data: existingChannel,
        error: existingChannelError,
      } = await client
        .from('channels')
        .select('*')
        .eq('workspace_id', workspace.id)
        .eq('name', channelName)
        .maybeSingle()

      if (existingChannelError) {
        throw existingChannelError
      }

      if (existingChannel) {
        throw new Error(
          `A channel named "${channelName}" already exists in this workspace.`
        )
      }

      // -------------------------------------------------------
      // 3. Create channel
      // -------------------------------------------------------
      const {
        data: channel,
        error: channelError,
      } = await client
        .from('channels')
        .insert({
          workspace_id: workspace.id,
          name: channelName,
          description:
            description.trim() || null,
          is_private: isPrivate,
          created_by: session.user.id,
        })
        .select()
        .single()

      if (channelError) {
        // Handle duplicate/race-condition errors gracefully
        if (
          channelError.code === '23505' ||
          channelError.message
            ?.toLowerCase()
            .includes('duplicate')
        ) {
          throw new Error(
            `A channel named "${channelName}" already exists.`
          )
        }

        throw channelError
      }

      if (!channel) {
        throw new Error(
          'Channel was not created.'
        )
      }

      // -------------------------------------------------------
      // 4. Add creator as admin
      // -------------------------------------------------------
      const {
        error: creatorMemberError,
      } = await client
        .from('channel_members')
        .insert({
          channel_id: channel.id,
          profile_id: session.user.id,
          role: 'admin',
        })

      if (creatorMemberError) {
        // Channel was created, but membership failed.
        // Try to clean up the channel.
        await client
          .from('channels')
          .delete()
          .eq('id', channel.id)

        throw creatorMemberError
      }

      // -------------------------------------------------------
      // 5. Add selected members
      // -------------------------------------------------------
      if (selectedMembers.length > 0) {
        const memberRows = selectedMembers.map(
          (member) => ({
            channel_id: channel.id,
            profile_id: member.id,
            role: 'member',
          })
        )

        const {
          error: membersError,
        } = await client
          .from('channel_members')
          .insert(memberRows)

        if (membersError) {
          console.error(
            'Failed to add selected members:',
            membersError
          )

          // Keep channel because creator membership exists.
          // User can invite members later.
        }
      }

      // -------------------------------------------------------
      // 6. Update local app state exactly once
      // -------------------------------------------------------
      addChannel(channel as Channel)
      setCurrentChannelId(channel.id)

      // -------------------------------------------------------
      // 7. Close dialog
      // -------------------------------------------------------
      onOpenChange(false)
    } catch (err) {
      console.error(
        'Create channel error:',
        err
      )

      setError(
        err instanceof Error
          ? err.message
          : 'Failed to create channel'
      )
    } finally {
      // Unlock after request completes
      creatingRef.current = false
      setLoading(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Don't allow closing while create is in progress
        if (!nextOpen && creatingRef.current) {
          return
        }

        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Create a channel
          </DialogTitle>

          <DialogDescription>
            Channels are where your team communicates.
            They&apos;re best organized around a topic.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleCreate}
          className="space-y-4"
        >
          {/* Channel name */}
          <div className="space-y-2">
            <Label htmlFor="ch-name">
              Name
            </Label>

            <div className="relative">
              {isPrivate ? (
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              ) : (
                <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              )}

              <Input
                id="ch-name"
                placeholder="e.g. marketing"
                value={name}
                onChange={(e) =>
                  setName(e.target.value)
                }
                className="pl-9"
                required
                disabled={loading}
              />
            </div>

            {name && (
              <p className="text-xs text-muted-foreground">
                Channel will be created as{' '}
                <span className="font-mono">
                  {isPrivate ? '🔒' : '#'}
                  {formatChannelName(name)}
                </span>
              </p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="ch-desc">
              Description{' '}
              <span className="text-muted-foreground">
                (optional)
              </span>
            </Label>

            <Input
              id="ch-desc"
              placeholder="What is this channel about?"
              value={description}
              onChange={(e) =>
                setDescription(e.target.value)
              }
              disabled={loading}
            />
          </div>

          {/* Visibility */}
          <div className="space-y-2">
            <Label>Visibility</Label>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  setIsPrivate(false)
                }
                disabled={loading}
                className={`flex-1 flex items-center gap-2 px-3 py-2.5 rounded-xl border text-[13px] transition-all ${
                  !isPrivate
                    ? 'border-[#7C5CFC] bg-[#EDE5FF]'
                    : 'border-[#E5E1EE] hover:border-[#DDD6F3]'
                }`}
                style={{
                  color: !isPrivate
                    ? '#7C5CFC'
                    : '#4A4860',
                }}
              >
                <Hash className="h-4 w-4" />

                <div className="text-left">
                  <div className="font-medium">
                    Public
                  </div>

                  <div className="text-[11px] opacity-70">
                    Anyone can join
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() =>
                  setIsPrivate(true)
                }
                disabled={loading}
                className={`flex-1 flex items-center gap-2 px-3 py-2.5 rounded-xl border text-[13px] transition-all ${
                  isPrivate
                    ? 'border-[#7C5CFC] bg-[#EDE5FF]'
                    : 'border-[#E5E1EE] hover:border-[#DDD6F3]'
                }`}
                style={{
                  color: isPrivate
                    ? '#7C5CFC'
                    : '#4A4860',
                }}
              >
                <Lock className="h-4 w-4" />

                <div className="text-left">
                  <div className="font-medium">
                    Private
                  </div>

                  <div className="text-[11px] opacity-70">
                    Invite only
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Add members */}
          <div className="space-y-2">
            <Label>
              Add members{' '}
              <span className="text-muted-foreground">
                (optional)
              </span>
            </Label>

            {/* Selected members */}
            {selectedMembers.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {selectedMembers.map(
                  (member) => (
                    <span
                      key={member.id}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-medium"
                      style={{
                        background: '#EDE5FF',
                        color: '#7C5CFC',
                      }}
                    >
                      {member.display_name}

                      <button
                        type="button"
                        onClick={() =>
                          removeMember(
                            member.id
                          )
                        }
                        disabled={loading}
                        className="hover:text-[#E55B5B] transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )
                )}
              </div>
            )}

            <Input
              placeholder="Search members to add..."
              value={memberSearch}
              onChange={(e) =>
                setMemberSearch(
                  e.target.value
                )
              }
              disabled={loading}
            />

            {/* Member suggestions */}
            {memberSearch &&
              filteredMembers.length > 0 && (
                <div className="max-h-32 overflow-y-auto space-y-0.5 rounded-lg border border-[#E5E1EE] p-1">
                  {filteredMembers
                    .slice(0, 6)
                    .map((member) => (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() =>
                          addMember(member)
                        }
                        disabled={loading}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#F5F2FF] transition-colors text-left text-[13px]"
                      >
                        <div className="relative shrink-0">
                          {member.avatar_url ? (
                            <Image
                              src={
                                member.avatar_url
                              }
                              alt=""
                              width={24}
                              height={24}
                              unoptimized
                              className="h-6 w-6 rounded-md object-cover"
                            />
                          ) : (
                            <div
                              className="h-6 w-6 rounded-md flex items-center justify-center text-[10px] font-bold text-white"
                              style={{
                                background:
                                  '#7C5CFC',
                              }}
                            >
                              {member
                                .display_name?.[0]
                                ?.toUpperCase() ||
                                '?'}
                            </div>
                          )}

                          <Circle
                            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 ${
                              isProfileOnline(member)
                                ? 'fill-green-500 text-green-500'
                                : 'fill-gray-300 text-gray-300'
                            }`}
                            strokeWidth={3}
                            stroke="white"
                          />
                        </div>

                        <span
                          style={{
                            color: '#2D2B3D',
                          }}
                        >
                          {member.display_name}
                        </span>

                        {member.email && (
                          <span
                            className="text-[11px] ml-auto"
                            style={{
                              color: '#8E8EA0',
                            }}
                          >
                            {member.email}
                          </span>
                        )}
                      </button>
                    ))}
                </div>
              )}
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-sm text-destructive">
                {error}
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                onOpenChange(false)
              }
              disabled={loading}
            >
              Cancel
            </Button>

            <Button
              type="submit"
              disabled={
                loading ||
                creatingRef.current ||
                !formatChannelName(name)
              }
              style={{
                background: '#7C5CFC',
                color: '#fff',
              }}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="ml-2">
                    Creating...
                  </span>
                </>
              ) : (
                'Create Channel'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}