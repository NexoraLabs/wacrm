import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { startSession, stopSession } from '@/lib/whatsapp-qr/session-manager'

/** Shared with the Cloud API route — a WhatsApp number, either
 *  provider, counts against the same per-account cap. */
const MAX_NUMBERS_PER_ACCOUNT = 4

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * POST /api/whatsapp/qr-config
 * Body: { label?: string }
 *
 * Creates a new QR-linked whatsapp_config row + its whatsapp_qr_sessions
 * row, and kicks off the Baileys session (async — the pairing QR shows
 * up moments later via GET .../status). RLS's admin-only INSERT policy
 * on whatsapp_config (mirrored on whatsapp_qr_sessions) is the real
 * authorization gate here; this route just shapes the response.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { count, error: countError } = await supabase
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (countError) {
      return NextResponse.json({ error: 'Failed to check number limit' }, { status: 500 })
    }
    if ((count ?? 0) >= MAX_NUMBERS_PER_ACCOUNT) {
      return NextResponse.json(
        { error: `You can connect at most ${MAX_NUMBERS_PER_ACCOUNT} WhatsApp numbers per account.` },
        { status: 400 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 60) : null

    const { data: config, error: insertError } = await supabase
      .from('whatsapp_config')
      .insert({
        account_id: accountId,
        user_id: user.id,
        provider: 'qr',
        status: 'disconnected',
        label,
        is_default: (count ?? 0) === 0,
      })
      .select()
      .single()

    if (insertError || !config) {
      return NextResponse.json(
        { error: insertError?.message ?? 'Failed to create WhatsApp connection' },
        { status: 500 },
      )
    }

    const { error: sessionError } = await supabase
      .from('whatsapp_qr_sessions')
      .insert({ whatsapp_config_id: config.id, status: 'qr_pending' })

    if (sessionError) {
      await supabase.from('whatsapp_config').delete().eq('id', config.id)
      return NextResponse.json({ error: sessionError.message }, { status: 500 })
    }

    startSession(config.id, accountId, user.id).catch((err) =>
      console.error('[whatsapp-qr] startSession failed:', err),
    )

    return NextResponse.json({ id: config.id })
  } catch (error) {
    console.error('Error creating QR WhatsApp config:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/qr-config?id=<uuid>
 * Logs the Baileys session out, wipes the local auth folder + stored
 * snapshot, then deletes the whatsapp_config row (cascades to
 * whatsapp_qr_sessions).
 */
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('id, account_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    await stopSession(id)

    const { error: deleteError } = await supabase.from('whatsapp_config').delete().eq('id', id)
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting QR WhatsApp config:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
