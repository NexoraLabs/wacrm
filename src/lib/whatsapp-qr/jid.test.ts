import { describe, expect, it } from 'vitest'
import { jidToPhone, phoneToJid, resolveInboundPhone } from './jid'

describe('phoneToJid / jidToPhone', () => {
  it('round-trips a plain phone number', () => {
    expect(jidToPhone(phoneToJid('573001234567'))).toBe('573001234567')
  })

  it('strips a device suffix', () => {
    expect(jidToPhone('573001234567:12@s.whatsapp.net')).toBe('573001234567')
  })
})

describe('resolveInboundPhone', () => {
  it('uses remoteJid directly for a normal phone-number JID', () => {
    expect(resolveInboundPhone({ remoteJid: '573001234567@s.whatsapp.net' })).toBe('573001234567')
  })

  it('prefers remoteJidAlt when remoteJid is a LID', () => {
    expect(
      resolveInboundPhone({
        remoteJid: '191919191919191@lid',
        remoteJidAlt: '573001234567@s.whatsapp.net',
      }),
    ).toBe('573001234567')
  })

  it('falls back to the LID digits if no remoteJidAlt is present (never worse than before)', () => {
    expect(resolveInboundPhone({ remoteJid: '191919191919191@lid' })).toBe('191919191919191')
  })
})
