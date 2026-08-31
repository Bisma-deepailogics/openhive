'use client'

import {
  useEffect,
  useState,
  useRef,
  useCallback,
} from 'react'

import {
  X,
  Loader2,
} from 'lucide-react'

import { getSupabaseClient } from '@/lib/supabase/client'

import { useAppStore } from '@/lib/store/app-store'

import { MessageBubble } from './message-bubble'

import { MessageInput } from './message-input'

import type { Message } from '@/types/database'

export function ThreadPanel() {
  const {
    threadParentMessage,
    closeThread,
    user,
  } = useAppStore()

  const [replies, setReplies] =
    useState<Message[]>([])

  const [loading, setLoading] =
    useState(true)

  const bottomRef =
    useRef<HTMLDivElement>(null)

  const scrollToBottom =
    useCallback(() => {
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({
          behavior: 'smooth',
        })
      }, 50)
    }, [])

  /*
   * Message deleted event
   */
  useEffect(() => {
    function handleMessageDeleted(
      event: Event
    ) {
      const customEvent =
        event as CustomEvent<{
          messageId?: string
          parentId?: string | null
        }>

      const messageId =
        customEvent.detail?.messageId

      if (!messageId) return

      setReplies((prev) =>
        prev.filter(
          (reply) =>
            reply.id !== messageId
        )
      )
    }

    window.addEventListener(
      'message-deleted',
      handleMessageDeleted
    )

    return () => {
      window.removeEventListener(
        'message-deleted',
        handleMessageDeleted
      )
    }
  }, [])

  /*
   * Report the live reply count (deleted replies are excluded) so the
   * channel list's "N replies" indicator on the parent stays accurate
   * even after replies are deleted.
   */
  useEffect(() => {
    if (!threadParentMessage) return

    const count = replies.filter(
      (reply) => !reply.is_deleted
    ).length

    window.dispatchEvent(
      new CustomEvent('thread-reply-count', {
        detail: {
          parentId: threadParentMessage.id,
          count,
        },
      })
    )
  }, [replies, threadParentMessage])

  /*
   * Load thread replies + realtime
   */
  useEffect(() => {
    if (!threadParentMessage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting panel state when the thread closes
      setReplies([])
      setLoading(false)
      return
    }

    /*
     * Keep a stable reference to the parent message.
     */
    const parentMessage =
      threadParentMessage

    /*
     * Get Supabase client once.
     */
    const client =
      getSupabaseClient()

    /*
     * getSupabaseClient() can return null.
     * Check it BEFORE using it anywhere below.
     */
    if (!client) {
      console.error(
        'Supabase client is not available'
      )

      setReplies([])
      setLoading(false)

      return
    }

    let cancelled = false

    /*
     * Fetch a single reply.
     *
     * IMPORTANT:
     * The client is passed into this function
     * after it has already been checked.
     */
    async function fetchReply(
      supabaseClient: NonNullable<
        ReturnType<typeof getSupabaseClient>
      >,
      messageId: string
    ): Promise<Message | null> {
      const {
        data,
        error,
      } = await supabaseClient
        .from('messages')
        .select(
          '*, sender:profiles(*)'
        )
        .eq(
          'id',
          messageId
        )
        .single()

      if (error) {
        console.error(
          'Failed to fetch thread reply:',
          error
        )

        return null
      }

      return data as Message
    }

    /*
     * Load all replies
     */
    async function loadReplies() {
      if (cancelled) return

      setLoading(true)

      const {
        data,
        error,
      } = await client
        .from('messages')
        .select(
          '*, sender:profiles(*)'
        )
        .eq(
          'parent_id',
          parentMessage.id
        )
        .eq(
          'is_deleted',
          false
        )
        .order(
          'created_at',
          {
            ascending: true,
          }
        )

      if (cancelled) return

      if (error) {
        console.error(
          'Failed to load thread replies:',
          error
        )

        setReplies([])
        setLoading(false)

        return
      }

      setReplies(
        (data ?? []) as Message[]
      )

      setLoading(false)

      scrollToBottom()
    }

    loadReplies()

    /*
     * Supabase Realtime channel
     */
    const channel =
      client.channel(
        `thread:${parentMessage.id}`
      )

    /*
     * INSERT
     */
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter:
          `parent_id=eq.${parentMessage.id}`,
      },
      async (payload) => {
        if (cancelled) return

        const newMessage =
          payload.new as {
            id?: string
            is_deleted?: boolean
          }

        if (
          !newMessage.id ||
          newMessage.is_deleted
        ) {
          return
        }

        const newReply =
          await fetchReply(
            client,
            newMessage.id
          )

        if (
          !newReply ||
          cancelled
        ) {
          return
        }

        setReplies((prev) => {
          /*
           * Prevent duplicate realtime messages.
           */
          if (
            prev.some(
              (message) =>
                message.id ===
                newReply.id
            )
          ) {
            return prev
          }

          return [
            ...prev,
            newReply,
          ]
        })

        scrollToBottom()
      }
    )

    /*
     * UPDATE
     */
    channel.on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter:
          `parent_id=eq.${parentMessage.id}`,
      },
      async (payload) => {
        if (cancelled) return

        const updatedMessage =
          payload.new as {
            id?: string
            is_deleted?: boolean
          }

        if (
          !updatedMessage.id
        ) {
          return
        }

        /*
         * Soft delete
         */
        if (
          updatedMessage.is_deleted
        ) {
          setReplies((prev) =>
            prev.filter(
              (message) =>
                message.id !==
                updatedMessage.id
            )
          )

          return
        }

        /*
         * Normal update/edit
         */
        const updatedReply =
          await fetchReply(
            client,
            updatedMessage.id
          )

        if (
          !updatedReply ||
          cancelled
        ) {
          return
        }

        setReplies((prev) =>
          prev.map(
            (message) =>
              message.id ===
              updatedReply.id
                ? updatedReply
                : message
          )
        )
      }
    )

    /*
     * DELETE
     */
    channel.on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'messages',
        filter:
          `parent_id=eq.${parentMessage.id}`,
      },
      (payload) => {
        if (cancelled) return

        const deletedMessage =
          payload.old as {
            id?: string
          }

        if (
          !deletedMessage.id
        ) {
          return
        }

        setReplies((prev) =>
          prev.filter(
            (message) =>
              message.id !==
              deletedMessage.id
          )
        )
      }
    )

    /*
     * Subscribe
     */
    channel.subscribe(
      (status) => {
        console.log(
          `Thread realtime status: ${status}`
        )
      }
    )

    /*
     * Cleanup
     */
    return () => {
      cancelled = true

      client.removeChannel(
        channel
      )
    }
  }, [
    threadParentMessage,
    scrollToBottom,
  ])

  if (!threadParentMessage) {
    return null
  }

  /*
   * Build message content
   * with attachment links.
   */
  function buildMessageContent(
    content: string,
    attachments?: string[]
  ): string {
    if (
      !attachments ||
      attachments.length === 0
    ) {
      return content
    }

    const attachmentLines =
      attachments.map(
        (attachment) => {
          const splitIndex =
            attachment.indexOf('|')

          const hasEmbeddedName =
            splitIndex > 0

          const rawName =
            hasEmbeddedName
              ? attachment.slice(
                  0,
                  splitIndex
                )
              : ''

          const url =
            hasEmbeddedName
              ? attachment.slice(
                  splitIndex + 1
                )
              : attachment

          const fallbackName =
            decodeURIComponent(
              url
                .split('?')[0]
                .split('/')
                .pop() ||
                'attachment'
            )

          const fileName =
            rawName
              ? decodeURIComponent(
                  rawName
                )
              : fallbackName

          return `📎 [${fileName}](${url})`
        }
      )

    const trimmed =
      content.trim()

    return trimmed
      ? `${trimmed}\n\n${attachmentLines.join(
          '\n'
        )}`
      : attachmentLines.join('\n')
  }

  /*
   * Send thread reply
   */
  async function handleSendReply(
    content: string,
    attachments?: string[]
  ) {
    const client =
      getSupabaseClient()

    /*
     * Check all required values
     * before using them.
     */
    if (
      !client ||
      !user ||
      !threadParentMessage
    ) {
      return
    }

    const finalContent =
      buildMessageContent(
        content,
        attachments
      )

    const {
      error,
    } = await client
      .from('messages')
      .insert({
        channel_id:
          threadParentMessage.channel_id,
        sender_id:
          user.id,
        content:
          finalContent,
        parent_id:
          threadParentMessage.id,
      })

    if (error) {
      console.error(
        'Failed to send thread reply:',
        error
      )
    }
  }

  return (
    <div
      className="w-96 min-w-0 flex flex-col h-full overflow-hidden"
      style={{
        background: '#ffffff',
        borderLeft:
          '1px solid #E5E1EE',
      }}
    >
      {/* HEADER */}
      <div
        className="px-5 py-3 flex items-center justify-between shrink-0"
        style={{
          borderBottom:
            '1px solid #E5E1EE',
        }}
      >
        <h3
          className="font-bold text-[17px]"
          style={{
            color: '#2D2B3D',
          }}
        >
          Thread
        </h3>

        <button
          className="h-8 w-8 rounded-lg flex items-center justify-center hover:bg-[#F5F2FF] transition-colors"
          onClick={closeThread}
        >
          <X
            className="h-4 w-4"
            style={{
              color: '#8E8EA0',
            }}
          />
        </button>
      </div>

      {/* PARENT MESSAGE */}
      <div
        className="px-4 pt-3 pb-2"
        style={{
          borderBottom:
            '1px solid #E5E1EE',
        }}
      >
        <MessageBubble
          message={
            threadParentMessage
          }
          showHeader
          isOwn={
            threadParentMessage.sender_id ===
            user?.id
          }
          isThread
        />
      </div>

      {/* REPLY COUNT */}
      <div
        className="px-5 py-2 text-xs font-medium"
        style={{
          color: '#8E8EA0',
          borderBottom:
            '1px solid #E5E1EE',
        }}
      >
        {replies.length}{' '}
        {replies.length === 1
          ? 'reply'
          : 'replies'}
      </div>

      {/* REPLIES */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4">
        <div className="py-2 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2
                className="h-5 w-5 animate-spin"
                style={{
                  color: '#7C5CFC',
                }}
              />
            </div>
          ) : replies.length === 0 ? (
            <div
              className="flex items-center justify-center py-10 text-sm"
              style={{
                color: '#8E8EA0',
              }}
            >
              No replies yet
            </div>
          ) : (
            replies.map(
              (
                reply,
                i
              ) => {
                const prev =
                  i > 0
                    ? replies[i - 1]
                    : null

                const showHeader =
                  !prev ||
                  prev.sender_id !==
                    reply.sender_id ||
                  new Date(
                    reply.created_at
                  ).getTime() -
                    new Date(
                      prev.created_at
                    ).getTime() >
                    5 * 60 * 1000

                return (
                  <MessageBubble
                    key={reply.id}
                    message={reply}
                    showHeader={
                      showHeader
                    }
                    isOwn={
                      reply.sender_id ===
                      user?.id
                    }
                    isThread
                  />
                )
              }
            )
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* REPLY INPUT */}
      <MessageInput
        channelId={
          threadParentMessage.channel_id
        }
        channelName="thread"
        onSend={
          handleSendReply
        }
        placeholder="Reply..."
      />
    </div>
  )
}