'use client'

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import {
  SendHorizonal,
  Paperclip,
  Bold,
  Italic,
  Code,
  CodeSquare,
  ChevronUp,
  Clock,
} from 'lucide-react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAppStore } from '@/lib/store/app-store'
import type { Profile, SlashCommand } from '@/types/database'
import { SlashCommandPicker } from './slash-command-picker'
import { type BuiltinCommand } from '@/lib/slash-commands'
import { ScheduleMessageDialog } from './schedule-message-dialog'

interface MessageInputProps {
  channelId?: string
  channelName: string
  onSend: (content: string, attachments?: string[]) => Promise<void>
  placeholder?: string
}

interface Attachment {
  name: string
  url: string
}

interface MentionSuggestionProps {
  items: Profile[]
  command: (props: { id: string; label: string }) => void
  clientRect?: (() => DOMRect | null) | null
  event?: KeyboardEvent
}

interface UploadResponse {
  success?: boolean
  publicUrl?: string
  error?: string
}

function htmlToContent(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html

  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || ''
    }

    const el = node as HTMLElement
    const tag = el.tagName?.toLowerCase()
    const children = Array.from(el.childNodes).map(walk).join('')

    switch (tag) {
      case 'strong':
      case 'b':
        return `**${children}**`

      case 'em':
      case 'i':
        return `_${children}_`

      case 'code':
        if (el.parentElement?.tagName?.toLowerCase() === 'pre') {
          return children
        }

        return `\`${children}\``

      case 'pre':
        return `\`\`\`\n${children}\n\`\`\``

      case 'p':
        return children + '\n'

      case 'br':
        return '\n'

      case 'span':
        if (el.dataset.type === 'mention') {
          return `@${el.dataset.id || children}`
        }

        return children

      default:
        return children
    }
  }

  return walk(div).replace(/\n+$/, '').trim()
}

function getDisplayName(profile: Profile): string {
  return profile.display_name?.trim() || 'Unknown user'
}

export function MessageInput({
  channelId,
  channelName,
  onSend,
  placeholder,
}: MessageInputProps) {
  const { workspace } = useAppStore()
  const resolvedPlaceholder =
    placeholder || `Message #${channelName}`

  const [sending, setSending] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)

  const [members, setMembers] = useState<Profile[]>([])
  const membersRef = useRef<Profile[]>([])

  const [showSlashPicker, setShowSlashPicker] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashPosition, setSlashPosition] = useState({
    left: 0,
    bottom: 0,
  })

  const showSlashPickerRef = useRef(false)

  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [showSendMenu, setShowSendMenu] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)
  const editorRef = useRef<Editor | null>(null)

  useEffect(() => {
    membersRef.current = members
  }, [members])

  useEffect(() => {
    showSlashPickerRef.current = showSlashPicker
  }, [showSlashPicker])

  /*
   * Load channel/workspace members
   */
  useEffect(() => {
    const client = getSupabaseClient()

    if (!client || !workspace) {
      return
    }

    let cancelled = false

    const loadMembers = async () => {
      try {
        if (channelId) {
          const { data, error } = await client
            .from('channel_members')
            .select('profile:profiles(*)')
            .eq('channel_id', channelId)

          if (!error && data && data.length > 0) {
            const profiles = data
              .map(
                (item: Record<string, unknown>) =>
                  item.profile as Profile
              )
              .filter(Boolean)

            if (!cancelled) {
              setMembers(profiles)
            }

            return
          }
        }

        const { data, error } = await client
          .from('workspace_members')
          .select('profile:profiles(*)')
          .eq('workspace_id', workspace.id)

        if (!error && data && !cancelled) {
          const profiles = data
            .map(
              (item: Record<string, unknown>) =>
                item.profile as Profile
            )
            .filter(Boolean)

          setMembers(profiles)
        }
      } catch (error) {
        console.error('Failed to load members:', error)
      }
    }

    void loadMembers()

    return () => {
      cancelled = true
    }
  }, [workspace, channelId])

  /*
   * Send message
   */
  const handleSend = useCallback(async () => {
    if (!editorRef.current || sending || uploading) {
      return
    }

    const editor = editorRef.current
    const content = htmlToContent(editor.getHTML())

    if (!content.trim() && attachments.length === 0) {
      return
    }

    setSending(true)

    try {
      const attachmentUrls = attachments.map(
        (attachment) => attachment.url
      )

      await onSend(content, attachmentUrls)

      editor.commands.clearContent()
      setAttachments([])
    } catch (error) {
      console.error('Failed to send message:', error)

      alert(
        error instanceof Error
          ? error.message
          : 'Failed to send message'
      )
    } finally {
      setSending(false)
      editor.commands.focus()
    }
  }, [attachments, onSend, sending, uploading])

  /*
   * Tiptap editor
   */
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),

      Placeholder.configure({
        placeholder: resolvedPlaceholder,
      }),

      Mention.configure({
        HTMLAttributes: {
          class: 'mention',
        },

        suggestion: {
          items: ({ query }: { query: string }) => {
            const normalizedQuery = query.toLowerCase()

            return membersRef.current
              .filter((member) =>
                getDisplayName(member)
                  .toLowerCase()
                  .includes(normalizedQuery)
              )
              .slice(0, 8)
          },

          render: () => {
            let popup: HTMLDivElement | null = null
            let selectedIndex = 0
            let items: Profile[] = []

            let command:
              | ((props: {
                  id: string
                  label: string
                }) => void)
              | null = null

            const escapeHtml = (value: string): string =>
              value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;')

            const updatePopup = () => {
              if (!popup) {
                return
              }

              popup.innerHTML = items
                .map((item, index) => {
                  const name = getDisplayName(item)
                  const safeName = escapeHtml(name)
                  const initial = escapeHtml(
                    name[0]?.toUpperCase() || '?'
                  )

                  const selected =
                    index === selectedIndex ? 'is-selected' : ''

                  return `
                    <button
                      type="button"
                      class="mention-item ${selected}"
                      data-index="${index}"
                    >
                      <span class="mention-avatar">${initial}</span>
                      <span>${safeName}</span>
                    </button>
                  `
                })
                .join('')

              popup
                .querySelectorAll<HTMLButtonElement>(
                  '.mention-item'
                )
                .forEach((button) => {
                  button.addEventListener('mousedown', (event) => {
                    event.preventDefault()

                    const index = Number.parseInt(
                      button.dataset.index || '0',
                      10
                    )

                    const item = items[index]

                    if (item && command) {
                      command({
                        id: item.id,
                        label: getDisplayName(item),
                      })
                    }
                  })
                })
            }

            const positionPopup = (
              clientRect?: (() => DOMRect | null) | null
            ) => {
              if (!popup || !clientRect) {
                return
              }

              const rect = clientRect()

              if (!rect) {
                return
              }

              popup.style.left = `${rect.left}px`
              popup.style.top = `${
                rect.top - popup.offsetHeight - 8
              }px`
            }

            return {
              onStart: (props: MentionSuggestionProps) => {
                items = props.items
                command = props.command
                selectedIndex = 0

                popup = document.createElement('div')
                popup.className = 'mention-popup'

                document.body.appendChild(popup)

                updatePopup()
                positionPopup(props.clientRect)
              },

              onUpdate: (props: MentionSuggestionProps) => {
                items = props.items
                selectedIndex = 0

                updatePopup()
                positionPopup(props.clientRect)
              },

              onKeyDown: (props) => {
                if (props.event?.key === 'ArrowUp') {
                  if (items.length > 0) {
                    selectedIndex =
                      (selectedIndex - 1 + items.length) %
                      items.length

                    updatePopup()
                  }

                  return true
                }

                if (props.event?.key === 'ArrowDown') {
                  if (items.length > 0) {
                    selectedIndex =
                      (selectedIndex + 1) % items.length

                    updatePopup()
                  }

                  return true
                }

                if (props.event?.key === 'Enter') {
                  const item = items[selectedIndex]

                  if (item && command) {
                    command({
                      id: item.id,
                      label: getDisplayName(item),
                    })
                  }

                  return true
                }

                return false
              },

              onExit: () => {
                popup?.remove()
                popup = null
              },
            }
          },
        },
      }),
    ],

    onCreate: ({ editor: createdEditor }) => {
      editorRef.current = createdEditor
    },

    onDestroy: () => {
      editorRef.current = null
    },

    onUpdate: ({ editor: updatedEditor }) => {
      const text = updatedEditor.getText()

      if (text.startsWith('/') && !text.includes(' ')) {
        setSlashQuery(text)
        setShowSlashPicker(true)

        const editorEl =
          updatedEditor.view.dom.closest('.rounded-2xl')

        if (editorEl) {
          const rect = editorEl.getBoundingClientRect()

          setSlashPosition({
            left: rect.left + 16,
            bottom: window.innerHeight - rect.top + 8,
          })
        }
      } else {
        setShowSlashPicker(false)
      }
    },

    editorProps: {
      attributes: {
        class: 'tiptap-editor',
      },

      handleKeyDown: (_view, event) => {
        if (event.key !== 'Enter' || event.shiftKey) {
          return false
        }

        if (document.querySelector('.mention-popup')) {
          return false
        }

        if (showSlashPickerRef.current) {
          return false
        }

        event.preventDefault()

        void handleSend()

        return true
      },
    },

    content: '',
    immediatelyRender: false,
  })

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  /*
   * Update placeholder
   */
  useEffect(() => {
    if (!editor) {
      return
    }

    const placeholderExtension =
      editor.extensionManager.extensions.find(
        (extension) => extension.name === 'placeholder'
      )

    if (placeholderExtension) {
      ;(
        placeholderExtension.options as {
          placeholder: string
        }
      ).placeholder =
        resolvedPlaceholder

      editor.view.dispatch(editor.state.tr)
    }
  }, [resolvedPlaceholder, editor])

  /*
   * Slash commands
   */
  const handleSlashCommand = useCallback(
    (command: BuiltinCommand | SlashCommand) => {
      if (!editor) {
        return
      }

      setShowSlashPicker(false)

      if ('handler' in command) {
        const currentText = editor.getText()

        const args = currentText
          .slice(command.command.length)
          .trim()

        const result = command.handler(args)

        if (result.type === 'replace') {
          editor.commands.clearContent()

          editor.commands.setContent(
            `<p>${result.text}</p>`
          )

          window.setTimeout(() => {
            void handleSend()
          }, 50)
        }

        return
      }

      const text = `/${command.command}`

      editor.commands.clearContent()

      editor.commands.setContent(`<p>${text}</p>`)

      window.setTimeout(() => {
        void handleSend()
      }, 50)
    },
    [editor, handleSend]
  )

  /*
   * Upload files
   *
   * IMPORTANT:
   * This is a single useCallback.
   * Do NOT put another useCallback inside it.
   */
  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      console.log('UPLOAD STARTED', files)

      const filesToUpload = Array.from(files)

      if (filesToUpload.length === 0) {
        return
      }

      if (uploading) {
        return
      }

      setUploading(true)

      try {
        const client = getSupabaseClient()

        if (!client) {
          throw new Error(
            'Supabase client is not available'
          )
        }

        const {
          data: { session },
          error: sessionError,
        } = await client.auth.getSession()

        if (sessionError) {
          throw new Error(sessionError.message)
        }

        if (!session?.access_token) {
          throw new Error(
            'Please sign in before uploading files'
          )
        }

        const uploaded: Attachment[] = []

        for (const file of filesToUpload) {
          try {
            console.log(
              'Uploading file:',
              file.name,
              file.size,
              file.type
            )

            if (file.size === 0) {
              throw new Error(
                'The selected file is empty'
              )
            }

            const formData = new FormData()

            formData.append('file', file)
            formData.append('bucket', 'attachments')

            const response = await fetch('/api/upload', {
              method: 'POST',

              headers: {
                Authorization: `Bearer ${session.access_token}`,
              },

              body: formData,
            })

            const data = (await response
              .json()
              .catch(() => null)) as UploadResponse | null

            console.log('Upload response:', {
              status: response.status,
              ok: response.ok,
              data,
            })

            if (!response.ok) {
              throw new Error(
                data?.error ||
                  `Upload failed (${response.status})`
              )
            }

            if (!data?.publicUrl) {
              throw new Error(
                'Upload succeeded, but no public URL was returned'
              )
            }

            uploaded.push({
              name: file.name,
              url: data.publicUrl,
            })
          } catch (error) {
            console.error(
              `Failed to upload "${file.name}":`,
              error
            )

            alert(
              `${file.name}: ${
                error instanceof Error
                  ? error.message
                  : 'Upload failed'
              }`
            )
          }
        }

        if (uploaded.length > 0) {
          setAttachments((previous) => [
            ...previous,
            ...uploaded,
          ])
        }
      } catch (error) {
        console.error('File upload error:', error)

        alert(
          error instanceof Error
            ? error.message
            : 'File upload failed'
        )
      } finally {
        setUploading(false)
      }
    },
    [uploading]
  )

  /*
   * Drag & drop
   */
  const handleDragEnter = (
    event: DragEvent<HTMLDivElement>
  ) => {
    event.preventDefault()
    event.stopPropagation()

    dragCounterRef.current += 1

    if (event.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }

  const handleDragOver = (
    event: DragEvent<HTMLDivElement>
  ) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const handleDragLeave = (
    event: DragEvent<HTMLDivElement>
  ) => {
    event.preventDefault()
    event.stopPropagation()

    dragCounterRef.current -= 1

    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragging(false)
    }
  }

  const handleDrop = (
    event: DragEvent<HTMLDivElement>
  ) => {
    event.preventDefault()
    event.stopPropagation()

    dragCounterRef.current = 0
    setIsDragging(false)

    if (event.dataTransfer.files.length > 0) {
      void uploadFiles(event.dataTransfer.files)
    }
  }

  /*
   * Remove attachment
   */
  const removeAttachment = (index: number) => {
    setAttachments((previous) =>
      previous.filter(
        (_, itemIndex) => itemIndex !== index
      )
    )
  }

  const isEmpty =
    !editor?.getText().trim() &&
    attachments.length === 0

  return (
    <div className="px-5 pb-4 pt-2">
      <div
        className={`rounded-2xl transition-all ${
          isDragging
            ? 'border-2 border-[#7C5CFC] bg-[#EDE5FF]'
            : 'border border-[#E5E1EE] shadow-sm'
        }`}
        style={{
          background: isDragging
            ? undefined
            : '#fff',
        }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div
            className="px-4 py-6 text-center text-sm font-medium"
            style={{ color: '#7C5CFC' }}
          >
            Drop files here to upload
          </div>
        )}

        {!isDragging && (
          <>
            <div className="px-4 pt-3 pb-1">
              <EditorContent editor={editor} />
            </div>

            {attachments.length > 0 && (
              <div className="px-4 pb-1 flex flex-wrap gap-2">
                {attachments.map(
                  (attachment, index) => (
                    <div
                      key={`${attachment.url}-${index}`}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
                      style={{
                        background: '#F5F2FF',
                        color: '#4A4860',
                      }}
                    >
                      <Paperclip className="h-3 w-3" />

                      <span className="truncate max-w-[150px]">
                        {attachment.name}
                      </span>

                      <button
                        type="button"
                        onClick={() =>
                          removeAttachment(index)
                        }
                        className="hover:text-[#E55B5B] ml-1 transition-colors"
                        style={{
                          color: '#8E8EA0',
                        }}
                        disabled={
                          sending || uploading
                        }
                        aria-label={`Remove ${attachment.name}`}
                      >
                        ×
                      </button>
                    </div>
                  )
                )}
              </div>
            )}

            <div className="px-2 pb-2 flex items-center justify-between">
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-all ${
                    editor?.isActive('bold')
                      ? 'text-[#7C5CFC] bg-[#EDE5FF]'
                      : 'text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'
                  }`}
                  onClick={() =>
                    editor
                      ?.chain()
                      .focus()
                      .toggleBold()
                      .run()
                  }
                  title="Bold (Ctrl+B)"
                >
                  <Bold className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-all ${
                    editor?.isActive('italic')
                      ? 'text-[#7C5CFC] bg-[#EDE5FF]'
                      : 'text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'
                  }`}
                  onClick={() =>
                    editor
                      ?.chain()
                      .focus()
                      .toggleItalic()
                      .run()
                  }
                  title="Italic (Ctrl+I)"
                >
                  <Italic className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-all ${
                    editor?.isActive('code')
                      ? 'text-[#7C5CFC] bg-[#EDE5FF]'
                      : 'text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'
                  }`}
                  onClick={() =>
                    editor
                      ?.chain()
                      .focus()
                      .toggleCode()
                      .run()
                  }
                  title="Inline code"
                >
                  <Code className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-all ${
                    editor?.isActive('codeBlock')
                      ? 'text-[#7C5CFC] bg-[#EDE5FF]'
                      : 'text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'
                  }`}
                  onClick={() =>
                    editor
                      ?.chain()
                      .focus()
                      .toggleCodeBlock()
                      .run()
                  }
                  title="Code block"
                >
                  <CodeSquare className="h-4 w-4" />
                </button>

                <div
                  className="w-px h-4 mx-1"
                  style={{
                    background: '#E5E1EE',
                  }}
                />

                <button
                  type="button"
                  className="h-7 w-7 rounded-lg flex items-center justify-center transition-all text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]"
                  onClick={() =>
                    fileInputRef.current?.click()
                  }
                  title={
                    uploading
                      ? 'Uploading...'
                      : 'Attach file'
                  }
                  disabled={
                    uploading || sending
                  }
                >
                  <Paperclip className="h-4 w-4" />
                </button>
              </div>

              <div className="flex items-center">
                <button
                  type="button"
                  className={`h-8 w-8 rounded-l-xl flex items-center justify-center transition-all ${
                    isEmpty ||
                    sending ||
                    uploading
                      ? 'text-[#DDD6F3] cursor-not-allowed'
                      : 'bg-[#7C5CFC] text-white hover:bg-[#6B4EE6] shadow-sm'
                  }`}
                  disabled={
                    isEmpty ||
                    sending ||
                    uploading
                  }
                  onClick={() =>
                    void handleSend()
                  }
                  title={
                    uploading
                      ? 'Uploading...'
                      : 'Send'
                  }
                >
                  <SendHorizonal className="h-4 w-4" />
                </button>

                <div className="relative">
                  <button
                    type="button"
                    className={`h-8 w-5 rounded-r-xl flex items-center justify-center transition-all border-l ${
                      isEmpty ||
                      sending ||
                      uploading
                        ? 'text-[#DDD6F3] cursor-not-allowed border-[#E5E1EE]'
                        : 'bg-[#7C5CFC] text-white hover:bg-[#6B4EE6] shadow-sm border-[#6B4EE6]'
                    }`}
                    disabled={
                      isEmpty ||
                      sending ||
                      uploading
                    }
                    onClick={() =>
                      setShowSendMenu(
                        (open) => !open
                      )
                    }
                    aria-label="More send options"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>

                  {showSendMenu && (
                    <div
                      className="absolute bottom-full right-0 mb-1 py-1 min-w-[180px] rounded-xl border bg-white shadow-lg"
                      style={{
                        borderColor: '#E5E1EE',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setShowSendMenu(false)
                          setScheduleOpen(true)
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[#F5F2FF] text-left text-[#2D2B3D]"
                      >
                        <Clock
                          className="h-3.5 w-3.5"
                          style={{
                            color: '#7C5CFC',
                          }}
                        />

                        Schedule message
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {showSlashPicker && (
        <SlashCommandPicker
          query={slashQuery}
          onSelect={handleSlashCommand}
          onClose={() =>
            setShowSlashPicker(false)
          }
          position={slashPosition}
        />
      )}

      <ScheduleMessageDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        content={
          editor
            ? htmlToContent(editor.getHTML())
            : ''
        }
        channelId={channelId || ''}
        onScheduled={() => {
          editor?.commands.clearContent()
          setAttachments([])
        }}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files
            ? Array.from(event.target.files)
            : []

          event.target.value = ''

          if (files.length > 0) {
            void uploadFiles(files)
          }
        }}
      />
    </div>
  )
}