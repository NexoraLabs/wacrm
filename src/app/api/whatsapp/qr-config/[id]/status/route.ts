import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/whatsapp/qr-config/[id]/status
 *
 * Polled by the settings UI every ~2s while pairing. RLS on
 * whatsapp_qr_sessions (joined through whatsapp_config) is the real
 * authorization gate — this route just shapes the response and renders
 * the raw Baileys QR string as a scannable PNG data URL.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: session, error } = await supabase
    .from('whatsapp_qr_sessions')
    .select('status, last_qr, linked_phone_number')
    .eq('whatsapp_config_id', id)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!session) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const qrImageDataUrl = session.last_qr
    ? await QRCode.toDataURL(session.last_qr, { margin: 1, width: 280 })
    : null

  return NextResponse.json({
    status: session.status,
    qr: qrImageDataUrl,
    linked_phone_number: session.linked_phone_number,
  })
}
