'use client'

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import dynamic from 'next/dynamic'
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
  AtSign,
  Plus,
  Mic,
  Video,
  Smile,
  Square,
} from 'lucide-react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAppStore } from '@/lib/store/app-store'
import type { Profile, SlashCommand } from '@/types/database'
import { SlashCommandPicker } from './slash-command-picker'
import { type BuiltinCommand } from '@/lib/slash-commands'
import { ScheduleMessageDialog } from './schedule-message-dialog'

const EmojiPicker = dynamic(() => import('emoji-picker-react'), {
  ssr: false,
})

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
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''

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
        if (el.parentElement?.tagName?.toLowerCase() === 'pre') return children
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
  const resolvedPlaceholder = placeholder || `Message #${channelName}`

  const [sending, setSending] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)

  const [members, setMembers] = useState<Profile[]>([])
  const membersRef = useRef<Profile[]>([])

  const [showSlashPicker, setShowSlashPicker] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashPosition, setSlashPosition] = useState({ left: 0, bottom: 0 })
  const showSlashPickerRef = useRef(false)

  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [showSendMenu, setShowSendMenu] = useState(false)
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false)
  const [showFileSubmenu, setShowFileSubmenu] = useState(false)
  const [showTextSnippet, setShowTextSnippet] = useState(false)
  const [showWorkflow, setShowWorkflow] = useState(false)
  const [snippetText, setSnippetText] = useState('')
  const [workflowText, setWorkflowText] = useState('')
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [showReactionMenu, setShowReactionMenu] = useState(false)
  const [recordingType, setRecordingType] = useState<'audio' | 'video' | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)
  const editorRef = useRef<Editor | null>(null)
  const composerSelectionRef = useRef<number | null>(null)
  const mentionMenuRef = useRef<HTMLDivElement>(null)
  const reactionMenuRef = useRef<HTMLDivElement>(null)
  const attachmentMenuRef = useRef<HTMLDivElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const mediaChunksRef = useRef<Blob[]>([])

  useEffect(() => {
    membersRef.current = members
  }, [members])

  useEffect(() => {
    showSlashPickerRef.current = showSlashPicker
  }, [showSlashPicker])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!mentionMenuRef.current?.contains(target)) setShowMentionMenu(false)
      if (!reactionMenuRef.current?.contains(target)) setShowReactionMenu(false)
      if (!attachmentMenuRef.current?.contains(target)) {
        setShowAttachmentMenu(false)
        setShowFileSubmenu(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  useEffect(() => {
    const client = getSupabaseClient()
    if (!client || !workspace) return

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
              .flatMap((item: Record<string, unknown>) => {
                const profile = item.profile
                if (Array.isArray(profile)) return profile as Profile[]
                return profile ? [profile as Profile] : []
              })
              .filter((profile): profile is Profile => Boolean(profile && profile.id))

            if (!cancelled && profiles.length > 0) {
              setMembers(profiles)
              return
            }
          }
        }

        const { data, error } = await client
          .from('workspace_members')
          .select('profile:profiles(*)')
          .eq('workspace_id', workspace.id)

        if (!error && data && !cancelled) {
          const profiles = data
            .flatMap((item: Record<string, unknown>) => {
              const profile = item.profile
              if (Array.isArray(profile)) return profile as Profile[]
              return profile ? [profile as Profile] : []
            })
            .filter((profile): profile is Profile => Boolean(profile && profile.id))

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

  const handleSend = useCallback(async () => {
    if (!editorRef.current || sending || uploading) return

    const editor = editorRef.current
    const content = htmlToContent(editor.getHTML())

    if (!content.trim() && attachments.length === 0) return

    setSending(true)

    try {
      const attachmentPayloads = attachments.map(
        (attachment) =>
          `${encodeURIComponent(attachment.name)}|${attachment.url}`
      )

      await onSend(content, attachmentPayloads)
      editor.commands.clearContent()
      setAttachments([])
    } catch (error) {
      console.error('Failed to send message:', error)
      alert(error instanceof Error ? error.message : 'Failed to send message')
    } finally {
      setSending(false)
      editor.commands.focus()
    }
  }, [attachments, onSend, sending, uploading])

  const insertMention = useCallback(() => {
    const currentEditor = editorRef.current
    if (!currentEditor) return

    composerSelectionRef.current = currentEditor.state.selection.from
    setShowMentionMenu((open) => !open)
    setMentionQuery('')
    setShowReactionMenu(false)
    setShowAttachmentMenu(false)
    currentEditor.commands.focus()
  }, [])

  const insertSelectedMention = useCallback((member: Profile) => {
    const currentEditor = editorRef.current
    if (!currentEditor) return

    const position = composerSelectionRef.current
    if (position !== null) currentEditor.commands.setTextSelection(position)

    currentEditor.chain().focus().insertContent([
      { type: 'mention', attrs: { id: member.id, label: getDisplayName(member) } },
      { type: 'text', text: ' ' },
    ]).run()

    setShowMentionMenu(false)
    setMentionQuery('')
  }, [])

  const insertReaction = useCallback((emoji: string) => {
    const currentEditor = editorRef.current
    if (!currentEditor) return

    const position = composerSelectionRef.current
    if (position !== null) currentEditor.commands.setTextSelection(position)
    currentEditor.chain().focus().insertContent(emoji).run()
    setShowReactionMenu(false)
  }, [])

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
      Placeholder.configure({ placeholder: resolvedPlaceholder }),
      Mention.configure({
        HTMLAttributes: { class: 'mention' },
        suggestion: {
          items: ({ query }: { query: string }) => {
            const normalizedQuery = query.toLowerCase()

            return membersRef.current
              .filter((member) =>
                getDisplayName(member).toLowerCase().includes(normalizedQuery)
              )
              .slice(0, 8)
          },

          render: () => {
            let popup: HTMLDivElement | null = null
            let selectedIndex = 0
            let items: Profile[] = []
            let command:
              | ((props: { id: string; label: string }) => void)
              | null = null

            const escapeHtml = (value: string): string =>
              value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;')

            const updatePopup = () => {
              if (!popup) return

              popup.innerHTML = items
                .map((item, index) => {
                  const name = getDisplayName(item)
                  const safeName = escapeHtml(name)
                  const initial = escapeHtml(name[0]?.toUpperCase() || '?')
                  const selected = index === selectedIndex ? 'is-selected' : ''

                  return `
                    <button type="button" class="mention-item ${selected}" data-index="${index}">
                      <span class="mention-avatar">${initial}</span>
                      <span>${safeName}</span>
                    </button>
                  `
                })
                .join('')

              popup
                .querySelectorAll<HTMLButtonElement>('.mention-item')
                .forEach((button) => {
                  button.addEventListener('mousedown', (event) => {
                    event.preventDefault()

                    const index = Number.parseInt(button.dataset.index || '0', 10)
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
              if (!popup || !clientRect) return

              const rect = clientRect()
              if (!rect) return

              popup.style.left = `${rect.left}px`
              popup.style.top = `${rect.top - popup.offsetHeight - 8}px`
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
                    selectedIndex = (selectedIndex - 1 + items.length) % items.length
                    updatePopup()
                  }
                  return true
                }

                if (props.event?.key === 'ArrowDown') {
                  if (items.length > 0) {
                    selectedIndex = (selectedIndex + 1) % items.length
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

        const editorEl = updatedEditor.view.dom.closest('.rounded-2xl')

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
      attributes: { class: 'tiptap-editor' },

      handleKeyDown: (_view, event) => {
        if (event.key !== 'Enter' || event.shiftKey) return false
        if (document.querySelector('.mention-popup')) return false
        if (showSlashPickerRef.current) return false

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

  useEffect(() => {
    if (!editor) return

    const placeholderExtension =
      editor.extensionManager.extensions.find(
        (extension) => extension.name === 'placeholder'
      )

    if (placeholderExtension) {
      ;(
        placeholderExtension.options as { placeholder: string }
      ).placeholder = resolvedPlaceholder

      editor.view.dispatch(editor.state.tr)
    }
  }, [resolvedPlaceholder, editor])

  const handleSlashCommand = useCallback(
    (command: BuiltinCommand | SlashCommand) => {
      if (!editor) return

      setShowSlashPicker(false)

      if ('handler' in command) {
        const currentText = editor.getText()
        const args = currentText.slice(command.command.length).trim()
        const result = command.handler(args)

        if (result.type === 'replace') {
          editor.commands.clearContent()
          editor.commands.setContent(`<p>${result.text}</p>`)

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

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const filesToUpload = Array.from(files)

      if (filesToUpload.length === 0 || uploading) return

      setUploading(true)

      try {
        const client = getSupabaseClient()

        if (!client) {
          throw new Error('Supabase client is not available')
        }

        const {
          data: { session },
          error: sessionError,
        } = await client.auth.getSession()

        if (sessionError) throw new Error(sessionError.message)

        if (!session?.access_token) {
          throw new Error('Please sign in before uploading files')
        }

        const uploaded: Attachment[] = []

        for (const file of filesToUpload) {
          try {
            if (file.size === 0) {
              throw new Error('The selected file is empty')
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

            const data = (await response.json().catch(() => null)) as UploadResponse | null

            if (!response.ok) {
              throw new Error(data?.error || `Upload failed (${response.status})`)
            }

            if (!data?.publicUrl) {
              throw new Error('Upload succeeded, but no public URL was returned')
            }

            uploaded.push({
              name: file.name,
              url: data.publicUrl,
            })
          } catch (error) {
            console.error(`Failed to upload "${file.name}":`, error)

            alert(
              `${file.name}: ${
                error instanceof Error ? error.message : 'Upload failed'
              }`
            )
          }
        }

        if (uploaded.length > 0) {
          setAttachments((previous) => [...previous, ...uploaded])
        }
      } catch (error) {
        console.error('File upload error:', error)

        alert(error instanceof Error ? error.message : 'File upload failed')
      } finally {
        setUploading(false)
      }
    },
    [uploading]
  )

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
      return
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
    setRecordingType(null)
  }, [])

  const startRecording = useCallback(async (type: 'audio' | 'video') => {
    if (recordingType || uploading || sending) return

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      alert('Microphone and camera access require a secure connection. Open OpenHive using https:// or http://localhost, then try again.')
      return
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      alert('Recording is not supported by this browser. You can use + to upload a clip instead.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        type === 'audio' ? { audio: true } : { audio: true, video: true }
      )

      const candidates = type === 'video'
        ? ['video/webm;codecs=vp9,opus', 'video/webm']
        : ['audio/webm;codecs=opus', 'audio/webm']
      const mimeType = candidates.find((value) => MediaRecorder.isTypeSupported(value))
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)

      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      mediaChunksRef.current = []
      setRecordingType(type)

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) mediaChunksRef.current.push(event.data)
      }

      recorder.onerror = () => {
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
        mediaStreamRef.current = null
        mediaRecorderRef.current = null
        mediaChunksRef.current = []
        setRecordingType(null)
        alert(`Unable to record ${type} clip.`)
      }

      recorder.onstop = () => {
        // Strip codec parameters ("audio/webm;codecs=opus" -> "audio/webm") so
        // the upload API's MIME allow-list matches the recorded container.
        const rawType = recorder.mimeType || (type === 'video' ? 'video/webm' : 'audio/webm')
        const baseType = rawType.split(';')[0].trim().toLowerCase()
          || (type === 'video' ? 'video/webm' : 'audio/webm')
        const extension = baseType.includes('mp4') ? 'mp4'
          : baseType.includes('ogg') ? 'ogg'
          : 'webm'

        const blob = new Blob(mediaChunksRef.current, { type: baseType })
        const file = new File([blob], `${type}-clip-${Date.now()}.${extension}`, { type: baseType })

        mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
        mediaStreamRef.current = null
        mediaRecorderRef.current = null
        mediaChunksRef.current = []
        setRecordingType(null)

        if (file.size > 0) void uploadFiles([file])
      }

      recorder.start()
    } catch (error) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
      mediaRecorderRef.current = null
      setRecordingType(null)
      console.error('Recording failed:', error)

      const failureName = error instanceof DOMException ? error.name : ''
      if (failureName === 'NotAllowedError' || failureName === 'SecurityError') {
        alert(`Please allow ${type === 'video' ? 'camera and microphone' : 'microphone'} access for this site, then try again.`)
      } else if (failureName === 'NotFoundError' || failureName === 'OverconstrainedError') {
        alert(`No ${type === 'video' ? 'camera or microphone' : 'microphone'} was found on this device. Connect one and try again.`)
      } else if (failureName === 'NotReadableError' || failureName === 'TrackStartError') {
        alert(`Your ${type === 'video' ? 'camera or microphone' : 'microphone'} appears to be busy in another app. Close it and try again.`)
      } else {
        alert(`Unable to start ${type} recording.`)
      }
    }
  }, [recordingType, sending, uploading, uploadFiles])

  useEffect(() => () => {
    mediaRecorderRef.current?.stop()
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])


  useEffect(() => {
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        if (!sending && !uploading) fileInputRef.current?.click()
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Enter') {
        event.preventDefault()
        const currentEditor = editorRef.current
        if (currentEditor) composerSelectionRef.current = currentEditor.state.selection.from
        setShowTextSnippet(true)
        setShowAttachmentMenu(false)
        setShowFileSubmenu(false)
      }
    }

    window.addEventListener('keydown', handleGlobalShortcut)
    return () => window.removeEventListener('keydown', handleGlobalShortcut)
  }, [sending, uploading])

  const insertTextSnippet = () => {
    const currentEditor = editorRef.current
    const value = snippetText.trim()

    if (!currentEditor || !value) return

    const position = composerSelectionRef.current
    if (position !== null) currentEditor.commands.setTextSelection(position)

    currentEditor.chain().focus().insertContent(value).run()
    setSnippetText('')
    setShowTextSnippet(false)
  }

  const insertWorkflow = () => {
    const currentEditor = editorRef.current
    const value = workflowText.trim()

    if (!currentEditor || !value) return

    const position = composerSelectionRef.current
    if (position !== null) currentEditor.commands.setTextSelection(position)

    currentEditor.chain().focus().insertContent(value).run()
    setWorkflowText('')
    setShowWorkflow(false)
  }

  const insertList = () => {
    const currentEditor = editorRef.current
    if (!currentEditor) return

    const position = composerSelectionRef.current
    if (position !== null) currentEditor.commands.setTextSelection(position)

    // StarterKit has bullet lists disabled in this composer, so use
    // a plain-text bullet that works with the existing message format.
    currentEditor.chain().focus().insertContent('• ').run()
    setShowAttachmentMenu(false)
    setShowFileSubmenu(false)
  }

  const handleAttachmentOption = (
    type: 'file' | 'audio' | 'video'
  ) => {
    setShowAttachmentMenu(false)

    if (type === 'file') {
      fileInputRef.current?.click()
      return
    }

    if (type === 'audio') {
      audioInputRef.current?.click()
      return
    }

    videoInputRef.current?.click()
  }

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()

    dragCounterRef.current += 1

    if (event.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()

    dragCounterRef.current -= 1

    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragging(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()

    dragCounterRef.current = 0
    setIsDragging(false)

    if (event.dataTransfer.files.length > 0) {
      void uploadFiles(event.dataTransfer.files)
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments((previous) =>
      previous.filter((_, itemIndex) => itemIndex !== index)
    )
  }

  /*
   * Important fix:
   * Don't calculate isEmpty from editor.getText() directly during render.
   * Tiptap updates its internal state without React necessarily rendering.
   * editor.on('update') below forces a React state update on every keystroke,
   * so the Send button changes immediately.
   */
  const [editorHasText, setEditorHasText] = useState(false)

  useEffect(() => {
    if (!editor) return

    const syncEditorState = () => {
      setEditorHasText(editor.getText().trim().length > 0)
    }

    syncEditorState()
    editor.on('update', syncEditorState)

    return () => {
      editor.off('update', syncEditorState)
    }
  }, [editor])

  const isEmpty = !editorHasText && attachments.length === 0
  const sendDisabled = isEmpty || sending || uploading

  return (
    <div className="px-5 pb-4 pt-2">
      <div
        className={`rounded-2xl transition-all ${
          isDragging
            ? 'border-2 border-[#7C5CFC] bg-[#EDE5FF]'
            : 'border border-[#E5E1EE] shadow-sm'
        }`}
        style={{ background: isDragging ? undefined : '#fff' }}
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

            {recordingType && (
              <div className="px-4 pb-2 text-xs font-medium text-[#D64545]">
                <span className="inline-flex items-center gap-2 rounded-lg bg-[#FFF1F1] px-3 py-1.5">
                  <span className="h-2 w-2 rounded-full bg-[#D64545] animate-pulse" />
                  Recording {recordingType} clip — click the {recordingType === 'video' ? 'video' : 'microphone'} button to stop
                </span>
              </div>
            )}

            {attachments.length > 0 && (
              <div className="px-4 pb-1 flex flex-wrap gap-2">
                {attachments.map((attachment, index) => (
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
                      onClick={() => removeAttachment(index)}
                      className="hover:text-[#E55B5B] ml-1 transition-colors"
                      style={{ color: '#8E8EA0' }}
                      disabled={sending || uploading}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
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
                  onClick={() => editor?.chain().focus().toggleBold().run()}
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
                  onClick={() => editor?.chain().focus().toggleItalic().run()}
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
                  onClick={() => editor?.chain().focus().toggleCode().run()}
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
                  onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
                  title="Code block"
                >
                  <CodeSquare className="h-4 w-4" />
                </button>

                <div className="w-px h-4 mx-1" style={{ background: '#E5E1EE' }} />

                {/* Attachment / plus */}
                <div className="relative" ref={attachmentMenuRef}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setShowAttachmentMenu((open) => !open)
                      setShowMentionMenu(false)
                      setShowReactionMenu(false)
                    }}
                    className="h-8 w-8 rounded-full flex items-center justify-center text-[#6B6878] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]"
                    disabled={uploading || sending}
                    title="Add attachment"
                    aria-label="Add attachment"
                  >
                    <Plus className="h-5 w-5" />
                  </button>
                  {showAttachmentMenu && (
                    <div
                      className="absolute bottom-full left-0 mb-2 w-[270px] rounded-xl border bg-white p-1.5 shadow-xl z-50"
                      style={{ borderColor: '#E5E1EE' }}
                    >
                      <button
                        type="button"
                        onClick={() => setShowFileSubmenu((open) => !open)}
                        className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[#F5F2FF]"
                      >
                        <span className="flex items-center gap-3">
                          <Paperclip className="h-4 w-4 text-[#5F5B6B]" />
                          <span className="text-sm font-medium text-[#2D2B3D]">File</span>
                        </span>
                        <span className="text-xs text-[#8E8EA0]">›</span>
                      </button>

                      {showFileSubmenu && (
                        <div
                          className="ml-8 mb-1 rounded-lg border bg-white p-1 shadow-md"
                          style={{ borderColor: '#E5E1EE' }}
                        >
                          <button
                            type="button"
                            onClick={() => handleAttachmentOption('file')}
                            className="w-full flex items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-[#F5F2FF]"
                          >
                            <span className="text-sm text-[#2D2B3D]">Upload from your computer</span>
                            <span className="text-xs text-[#8E8EA0]">Ctrl+O</span>
                          </button>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={insertList}
                        className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[#F5F2FF]"
                      >
                        <span className="flex items-center gap-3">
                          <span className="text-base leading-none text-[#5F5B6B]">☷</span>
                          <span className="text-sm font-medium text-[#2D2B3D]">List</span>
                        </span>
                        <span className="rounded bg-[#7A3FA3] px-1.5 py-0.5 text-[10px] font-bold text-white">PRO</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          const currentEditor = editorRef.current
                          if (currentEditor) composerSelectionRef.current = currentEditor.state.selection.from
                          setShowAttachmentMenu(false)
                          setShowFileSubmenu(false)
                          setShowTextSnippet(true)
                          setShowReactionMenu(false)
                          setShowMentionMenu(false)
                        }}
                        className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[#F5F2FF]"
                      >
                        <span className="flex items-center gap-3">
                          <CodeSquare className="h-4 w-4 text-[#5F5B6B]" />
                          <span className="text-sm font-medium text-[#2D2B3D]">Text snippet</span>
                        </span>
                        <span className="text-xs text-[#8E8EA0]">Ctrl+Shift+Enter</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          const currentEditor = editorRef.current
                          if (currentEditor) composerSelectionRef.current = currentEditor.state.selection.from
                          setShowAttachmentMenu(false)
                          setShowFileSubmenu(false)
                          setShowWorkflow(true)
                          setShowReactionMenu(false)
                          setShowMentionMenu(false)
                        }}
                        className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[#F5F2FF]"
                      >
                        <span className="text-base leading-none text-[#5F5B6B]">▷</span>
                        <span className="text-sm font-medium text-[#2D2B3D]">Workflow</span>
                      </button>

                      <div className="my-1 border-t" style={{ borderColor: '#F0EDF5' }} />

                      <button
                        type="button"
                        onClick={() => handleAttachmentOption('file')}
                        className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[#F5F2FF]"
                      >
                        <span className="flex items-center gap-3">
                          <Paperclip className="h-4 w-4 text-[#5F5B6B]" />
                          <span className="text-sm font-medium text-[#2D2B3D]">Upload from your computer</span>
                        </span>
                        <span className="text-xs text-[#8E8EA0]">Ctrl+O</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* Emoji / reactions */}
                <div className="relative" ref={reactionMenuRef}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      const currentEditor = editorRef.current
                      if (currentEditor) composerSelectionRef.current = currentEditor.state.selection.from
                      setShowReactionMenu((open) => !open)
                      setShowMentionMenu(false)
                      setShowAttachmentMenu(false)
                    }}
                    className="h-8 w-8 rounded-lg flex items-center justify-center text-[#6B6878] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]"
                    disabled={!editor || sending}
                    title="Add emoji"
                    aria-label="Add emoji"
                  >
                    <Smile className="h-5 w-5" />
                  </button>
                  {showReactionMenu && (
                    <div
                      className="absolute bottom-full left-0 mb-2 z-50 overflow-hidden rounded-xl border bg-white shadow-xl"
                      style={{ borderColor: '#E5E1EE' }}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      <EmojiPicker
                        onEmojiClick={(emojiData) => insertReaction(emojiData.emoji)}
                        width={340}
                        height={420}
                        previewConfig={{ showPreview: false }}
                        searchDisabled={false}
                        skinTonesDisabled={false}
                        lazyLoadEmojis={false}
                      />
                    </div>
                  )}
                </div>

                {/* Mention */}
                <div className="relative" ref={mentionMenuRef}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={insertMention}
                    className={`h-8 w-8 rounded-lg flex items-center justify-center ${showMentionMenu ? 'text-[#7C5CFC] bg-[#EDE5FF]' : 'text-[#6B6878] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'}`}
                    disabled={!editor || sending}
                    title="Mention someone"
                    aria-label="Mention someone"
                  >
                    <AtSign className="h-5 w-5" />
                  </button>
                  {showMentionMenu && (
                    <div className="absolute bottom-full left-0 mb-2 w-[270px] max-h-[300px] overflow-hidden rounded-xl border bg-white shadow-xl z-50" style={{ borderColor: '#E5E1EE' }}>
                      <div className="px-3 pt-3 pb-2 text-sm font-semibold text-[#2D2B3D]">Mention someone</div>
                      <div className="px-2 pb-2">
                        <input
                          autoFocus
                          value={mentionQuery}
                          onChange={(event) => setMentionQuery(event.target.value)}
                          onKeyDown={(event) => { if (event.key === 'Escape') setShowMentionMenu(false) }}
                          placeholder="Search members..."
                          className="w-full rounded-lg border px-2.5 py-2 text-sm outline-none focus:border-[#7C5CFC]"
                          style={{ borderColor: '#E5E1EE' }}
                        />
                      </div>
                      <div className="max-h-[210px] overflow-y-auto px-1 pb-1">
                        {members
                          .filter((member) => getDisplayName(member).toLowerCase().includes(mentionQuery.trim().toLowerCase()))
                          .slice(0, 20)
                          .map((member) => {
                            const name = getDisplayName(member)
                            return (
                              <button
                                key={member.id}
                                type="button"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => insertSelectedMention(member)}
                                className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[#F5F2FF]"
                              >
                                <span className="h-7 w-7 shrink-0 rounded-full bg-[#EDE5FF] text-[#7C5CFC] flex items-center justify-center text-xs font-semibold">{name.charAt(0).toUpperCase()}</span>
                                <span className="min-w-0"><span className="block truncate text-sm font-medium text-[#2D2B3D]">{name}</span><span className="block truncate text-xs text-[#8E8EA0]">@{name}</span></span>
                              </button>
                            )
                          })}
                        {members.filter((member) => getDisplayName(member).toLowerCase().includes(mentionQuery.trim().toLowerCase())).length === 0 && (
                          <div className="px-3 py-4 text-sm text-[#8E8EA0]">No members found.</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Video clip recorder */}
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => recordingType === 'video' ? stopRecording() : void startRecording('video')} className="h-8 w-8 rounded-lg flex items-center justify-center text-[#6B6878] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]" disabled={uploading || sending || (!!recordingType && recordingType !== 'video')} title={recordingType === 'video' ? 'Stop video recording' : 'Record video clip'}>
                  {recordingType === 'video' ? <Square className="h-4 w-4 fill-current" /> : <Video className="h-5 w-5" />}
                </button>

                {/* Audio clip recorder */}
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => recordingType === 'audio' ? stopRecording() : void startRecording('audio')} className="h-8 w-8 rounded-lg flex items-center justify-center text-[#6B6878] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]" disabled={uploading || sending || (!!recordingType && recordingType !== 'audio')} title={recordingType === 'audio' ? 'Stop audio recording' : 'Record audio clip'}>
                  {recordingType === 'audio' ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-5 w-5" />}
                </button>

                </div>

              <div className="flex items-center">
                <button
                  type="button"
                  className={`h-8 w-8 rounded-l-xl flex items-center justify-center transition-all ${
                    sendDisabled
                      ? 'text-[#DDD6F3] cursor-not-allowed'
                      : 'bg-[#7C5CFC] text-white hover:bg-[#6B4EE6] shadow-sm'
                  }`}
                  disabled={sendDisabled}
                  onClick={() => void handleSend()}
                  title={uploading ? 'Uploading...' : 'Send'}
                >
                  <SendHorizonal className="h-4 w-4" />
                </button>

                <div className="relative">
                  <button
                    type="button"
                    className={`h-8 w-5 rounded-r-xl flex items-center justify-center transition-all border-l ${
                      sendDisabled
                        ? 'text-[#DDD6F3] cursor-not-allowed border-[#E5E1EE]'
                        : 'bg-[#7C5CFC] text-white hover:bg-[#6B4EE6] shadow-sm border-[#6B4EE6]'
                    }`}
                    disabled={sendDisabled}
                    onClick={() => setShowSendMenu((open) => !open)}
                    aria-label="More send options"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>

                  {showSendMenu && (
                    <div
                      className="absolute bottom-full right-0 mb-1 py-1 min-w-[180px] rounded-xl border bg-white shadow-lg z-50"
                      style={{ borderColor: '#E5E1EE' }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setShowSendMenu(false)
                          setScheduleOpen(true)
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[#F5F2FF] text-left text-[#2D2B3D]"
                      >
                        <Clock className="h-3.5 w-3.5" style={{ color: '#7C5CFC' }} />
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

      {showTextSnippet && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/20 px-4">
          <div className="w-full max-w-lg rounded-2xl border bg-white p-4 shadow-2xl" style={{ borderColor: '#E5E1EE' }}>
            <div className="mb-3 text-base font-semibold text-[#2D2B3D]">Text snippet</div>
            <textarea
              autoFocus
              value={snippetText}
              onChange={(event) => setSnippetText(event.target.value)}
              placeholder="Write a snippet..."
              className="min-h-[140px] w-full resize-y rounded-xl border p-3 text-sm outline-none focus:border-[#7C5CFC]"
              style={{ borderColor: '#E5E1EE' }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setSnippetText('')
                  setShowTextSnippet(false)
                }}
                className="rounded-lg px-3 py-2 text-sm text-[#5F5B6B] hover:bg-[#F5F2FF]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={insertTextSnippet}
                disabled={!snippetText.trim()}
                className="rounded-lg bg-[#7C5CFC] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Insert snippet
              </button>
            </div>
          </div>
        </div>
      )}

      {showWorkflow && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/20 px-4">
          <div className="w-full max-w-lg rounded-2xl border bg-white p-4 shadow-2xl" style={{ borderColor: '#E5E1EE' }}>
            <div className="mb-1 text-base font-semibold text-[#2D2B3D]">Workflow</div>
            <div className="mb-3 text-xs text-[#8E8EA0]">Add a workflow action to your message.</div>
            <input
              autoFocus
              value={workflowText}
              onChange={(event) => setWorkflowText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  insertWorkflow()
                }
              }}
              placeholder="e.g. Follow up with the customer"
              className="w-full rounded-xl border p-3 text-sm outline-none focus:border-[#7C5CFC]"
              style={{ borderColor: '#E5E1EE' }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setWorkflowText('')
                  setShowWorkflow(false)
                }}
                className="rounded-lg px-3 py-2 text-sm text-[#5F5B6B] hover:bg-[#F5F2FF]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={insertWorkflow}
                disabled={!workflowText.trim()}
                className="rounded-lg bg-[#7C5CFC] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Insert workflow
              </button>
            </div>
          </div>
        </div>
      )}

      {showSlashPicker && (
        <SlashCommandPicker
          query={slashQuery}
          onSelect={handleSlashCommand}
          onClose={() => setShowSlashPicker(false)}
          position={slashPosition}
        />
      )}

      <ScheduleMessageDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        content={editor ? htmlToContent(editor.getHTML()) : ''}
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
          const files = event.target.files ? Array.from(event.target.files) : []
          event.target.value = ''
          if (files.length > 0) void uploadFiles(files)
        }}
      />

      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : []
          event.target.value = ''
          if (files.length > 0) void uploadFiles(files)
        }}
      />

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : []
          event.target.value = ''
          if (files.length > 0) void uploadFiles(files)
        }}
      />
    </div>
  )
}