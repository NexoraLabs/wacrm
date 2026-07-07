import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots')

const BASE = process.env.WACRM_BASE_URL ?? 'http://localhost:3000'
const EMAIL = process.env.WACRM_EMAIL
const PASSWORD = process.env.WACRM_PASSWORD
const target = process.argv[2] ?? '/dashboard'

if (!EMAIL || !PASSWORD) {
  console.error('Set WACRM_EMAIL and WACRM_PASSWORD (a real Supabase user on the connected project — there is no seed/test user) before running this driver.')
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
  const errors = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))
  page.on('response', (res) => {
    if (res.url().includes('auth') || res.url().includes('token')) {
      console.log('AUTH RESPONSE:', res.status(), res.url())
    }
  })

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  // First hit of a route on a cold `next dev` server can take 10s+ to
  // compile, and fill()-ing before React hydrates gets silently wiped
  // when hydration commits the initial (empty) useState value — the
  // DOM still *looks* filled but the controlled state isn't. Waiting
  // for networkidle (Next's hydration JS has landed and run) avoids it.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  const emailInput = page.locator('input[type="email"], input[name="email"]').first()
  await emailInput.fill(EMAIL)
  // Confirm the controlled value actually stuck before moving on.
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

  await page.goto(`${BASE}${target}`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1000)
  console.log('navigated to:', page.url())
  await shot(page, target.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'dashboard')

  console.log('console errors:', errors)
  await browser.close()
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
