import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots')

const BASE = process.env.WACRM_BASE_URL ?? 'http://localhost:3000'
const EMAIL = process.env.WACRM_EMAIL
const PASSWORD = process.env.WACRM_PASSWORD
const LABEL = process.argv[2] ?? 'Test reconnect'

if (!EMAIL || !PASSWORD) {
  console.error('Set WACRM_EMAIL and WACRM_PASSWORD')
  process.exit(1)
}

async function shot(page, name) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log('screenshot:', file)
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const page = await (await browser.newContext()).newPage()
  page.on('dialog', (dialog) => dialog.accept())

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  const emailInput = page.locator('input[type="email"], input[name="email"]').first()
  await emailInput.fill(EMAIL)
  await page.waitForFunction(
    (val) => document.querySelector('input[type="email"]')?.value === val,
    EMAIL,
    { timeout: 5000 },
  )
  await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {}),
    page.locator('button[type="submit"]').first().click(),
  ])
  await page.waitForLoadState('networkidle').catch(() => {})
  console.log('logged in, at:', page.url())

  await page.goto(`${BASE}/settings?tab=whatsapp`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1500)

  // Disconnect any existing QR number card, if present.
  const disconnectBtn = page.getByRole('button', { name: 'Disconnect' })
  const hasExisting = await disconnectBtn.count()
  if (hasExisting > 0) {
    console.log('found existing QR card, disconnecting...')
    await disconnectBtn.first().click()
    await page.waitForTimeout(2000)
    await shot(page, 'settings-whatsapp-after-disconnect')
  } else {
    console.log('no existing QR card to disconnect')
  }

  await page.getByRole('button', { name: /Add number \(QR/i }).click()
  await page.waitForTimeout(500)

  const labelInput = page.locator('input[placeholder="e.g. Product test"]')
  await labelInput.fill(LABEL)

  await page.getByRole('button', { name: 'Generate QR' }).click()

  const qrImg = page.locator('img[alt="Scan with WhatsApp"]')
  await qrImg.waitFor({ state: 'visible', timeout: 20000 })
  await page.waitForTimeout(1000)

  await shot(page, 'settings-whatsapp-qr-reconnect')
  console.log('QR generated and screenshotted.')

  await browser.close()
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
