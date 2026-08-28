import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const ALLOWED_BUCKETS = ['avatars', 'attachments'] as const
type Bucket = (typeof ALLOWED_BUCKETS)[number]

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',

  'application/pdf',
  'text/plain',
  'text/csv',

  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',

  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  'application/zip',
  'application/gzip',

  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',

  'video/mp4',
  'video/webm',

  'application/json',
  'application/xml',
  'text/html',
  'text/css',
  'text/javascript',
])

const MAX_FILE_SIZE = 50 * 1024 * 1024
const MAX_AVATAR_SIZE = 5 * 1024 * 1024

function getExtension(fileName: string): string {
  const parts = fileName.split('.')
  if (parts.length < 2) return 'bin'

  const extension = parts.pop()?.toLowerCase() || 'bin'

  // Only allow safe filename extensions.
  if (!/^[a-z0-9]+$/.test(extension)) {
    return 'bin'
  }

  return extension
}

export async function POST(request: NextRequest) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!url || !anonKey || !serviceKey) {
      console.error('Missing Supabase environment variables')

      return NextResponse.json(
        {
          error:
            'Supabase environment variables are missing. Check .env.local',
        },
        { status: 500 }
      )
    }

    // ---------------------------------------------------------
    // 1. Authenticate user
    // ---------------------------------------------------------

    const authorization = request.headers.get('authorization')

    if (!authorization?.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Not authenticated. Missing Bearer token.' },
        { status: 401 }
      )
    }

    const authClient = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          Authorization: authorization,
        },
      },
    })

    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser()

    if (userError || !user) {
      console.error('Authentication error:', userError)

      return NextResponse.json(
        { error: 'Invalid or expired session. Please sign in again.' },
        { status: 401 }
      )
    }

    // ---------------------------------------------------------
    // 2. Read multipart/form-data
    // ---------------------------------------------------------

    const formData = await request.formData()

    const file = formData.get('file')

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'No file was provided' },
        { status: 400 }
      )
    }

    // ---------------------------------------------------------
    // 3. Validate bucket
    // ---------------------------------------------------------

    const bucketValue = formData.get('bucket')

    const bucket: Bucket =
      typeof bucketValue === 'string' &&
      ALLOWED_BUCKETS.includes(bucketValue as Bucket)
        ? (bucketValue as Bucket)
        : 'attachments'

    // ---------------------------------------------------------
    // 4. Validate file
    // ---------------------------------------------------------

    if (file.size === 0) {
      return NextResponse.json(
        { error: 'The uploaded file is empty' },
        { status: 400 }
      )
    }

    const maxSize =
      bucket === 'avatars' ? MAX_AVATAR_SIZE : MAX_FILE_SIZE

    if (file.size > maxSize) {
      return NextResponse.json(
        {
          error: `File too large. Maximum size is ${
            maxSize / 1024 / 1024
          } MB`,
        },
        { status: 400 }
      )
    }

    // Compare against the base type only ("audio/webm;codecs=opus" ->
    // "audio/webm") so browser-recorded clips that carry codec parameters
    // pass the allow-list check instead of being rejected.
    const baseMimeType = file.type.split(';')[0].trim().toLowerCase()

    if (file.type && !ALLOWED_MIME_TYPES.has(baseMimeType)) {
      return NextResponse.json(
        {
          error: `File type "${file.type}" is not allowed`,
        },
        { status: 400 }
      )
    }

    // ---------------------------------------------------------
    // 5. Generate SAFE storage path on server
    // ---------------------------------------------------------

    const extension = getExtension(file.name)

    const safeFileName = `${crypto.randomUUID()}.${extension}`

    const folder =
      bucket === 'avatars'
        ? `users/${user.id}`
        : `users/${user.id}/uploads`

    const storagePath = `${folder}/${safeFileName}`

    // ---------------------------------------------------------
    // 6. Create Supabase admin client
    // ---------------------------------------------------------

    const supabase = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })

    // ---------------------------------------------------------
    // 7. Upload to Supabase Storage
    // ---------------------------------------------------------

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(storagePath, buffer, {
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
        upsert: false,
      })

    if (uploadError) {
      console.error('Supabase upload error:', uploadError)

      return NextResponse.json(
        {
          error: `Storage upload failed: ${uploadError.message}`,
        },
        { status: 500 }
      )
    }

    // ---------------------------------------------------------
    // 8. Get public URL
    // ---------------------------------------------------------

    const {
      data: { publicUrl },
    } = supabase.storage
      .from(bucket)
      .getPublicUrl(storagePath)

    if (!publicUrl) {
      return NextResponse.json(
        { error: 'File uploaded but public URL could not be generated' },
        { status: 500 }
      )
    }

    // ---------------------------------------------------------
    // 9. Return result
    // ---------------------------------------------------------

    return NextResponse.json({
      success: true,
      publicUrl,
      path: storagePath,
      bucket,
      fileName: file.name,
      size: file.size,
      contentType: file.type,
    })
  } catch (error) {
    console.error('Upload API error:', error)

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unexpected upload error',
      },
      { status: 500 }
    )
  }
}