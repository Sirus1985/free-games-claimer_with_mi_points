import { chromium } from 'playwright-extra'

import { resolve, jsonDb, datetime, stealth, notify } from './src/util.js';
import { existsSync } from 'fs';
import { cfg } from './src/config.js';

// WICHTIG: Das Stealth-Plugin aktivieren!
// Das hat im vorherigen Code gefehlt, weshalb du sofort erkannt wurdest.
chromium.use(stealth);

const EMAIL = cfg.mi_email
const PASSWORD = cfg.mi_password
const COOKIE_FILE = resolve('data/mi-cookies.json');

if (!EMAIL || !PASSWORD) {
  console.error('ERROR: Please set MI_EMAIL and MI_PASSWORD.');
  process.exit(1);
}

(async () => {

  const browser = await chromium.launch({ 
    headless: false,  
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-blink-features=AutomationControlled', 
      '--window-position=0,0',
      '--window-size=1920,1080'
    ]
  });
  
  const contextOptions = {
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  };

  // Cookies laden
  if (existsSync(COOKIE_FILE)) {
    console.log(`🍪 Loading cookies...`);
    contextOptions.storageState = COOKIE_FILE;
  }

  const context = await browser.newContext(contextOptions);
  
  // HINWEIS: Wir brauchen hier keine manuellen 'navigator.webdriver' Hacks mehr,
  // weil 'chromium.use(stealth)' das jetzt professionell für uns macht.

  const page = await context.newPage();

  try {
    console.log('--- Xiaomi Points Claimer Start ---');
    
    // 1. ZIEL: Points-Center
    console.log('Navigating to Points-Center...');
    
    // Wir fangen Fehler beim Laden ab (falls Access Denied kommt)
    const response = await page.goto('https://www.mi.com/de/points-center', { waitUntil: 'domcontentloaded' });
    
    // Status-Check direkt nach dem Laden
    if (response && response.status() === 403) {
        console.error('🚨 403 FORBIDDEN - Sofort geblockt. Deine IP oder der Browser-Fingerprint mag Xiaomi nicht.');
        await page.screenshot({ path: 'xiaomi-blocked.png' });
        process.exit(1);
    }

    // Menschliches Warten
    await page.waitForTimeout(3000);

    const title = await page.title();
    if (title.includes('Access Denied')) {
        console.error('🚨 Access Denied im Titel erkannt.');
        await page.screenshot({ path: 'xiaomi-blocked.png' });
        process.exit(1);
    }

    // 2. STATUS & LOGIN CHECK
    const currentUrl = page.url();
    
    if (currentUrl.includes('account.xiaomi.com') || currentUrl.includes('login')) {
        console.log('🔒 Login page detected.');
        await performLogin(page, context); 
    } else {
        // Cookie Banner wegklicken
        try {
            const cookieBtn = page.locator('#truste-consent-button');
            if (await cookieBtn.isVisible({ timeout: 5000 })) {
                await cookieBtn.click();
                await page.waitForTimeout(1000);
            }
        } catch (e) {}

        // Prüfen ob wir eingeloggt sind (Nach "Anmelden" suchen)
        const loginBtn = page.getByText(/Anmelden|Sign in/i).first();
        if (await loginBtn.isVisible()) {
            console.log('🔒 Not logged in. Going to login...');
            await loginBtn.click();
            await page.waitForURL(url => url.toString().includes('account.xiaomi.com'), { timeout: 60000 });
            await performLogin(page, context); 
        }
    }

    // 3. CLAIMEN
    console.log('Searching for claim button...');
    
    // Button suchen (mit Warten)
    const claimButton = page.locator('.points-task__info .mi-btn--primary').first();
    try {
        await claimButton.waitFor({ state: 'visible', timeout: 10000 });
    } catch(e) {
        console.log('⚠️ Button not found immediately.');
    }

    if (await claimButton.isVisible()) {
        const classAttribute = await claimButton.getAttribute('class');
        if (classAttribute && classAttribute.includes('mi-btn--disabled')) {
            console.log('🛑 Already claimed today (Button disabled).');
        } else {
            console.log('🔘 Clicking claim button...');
            await claimButton.click();
            
            // Prüfen ob Login kommt
            try {
                await page.waitForURL(url => url.toString().includes('account.xiaomi.com'), { timeout: 5000 });
                console.log('🔒 Click triggered login.');
                await performLogin(page, context);
                // Nach Login nochmal probieren
                await page.goto('https://www.mi.com/de/points-center', { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(4000);
                const retryBtn = page.locator('.points-task__info .mi-btn--primary').first();
                if (await retryBtn.isVisible()) {
                    await retryBtn.click();
                    console.log('✅ Clicked after login.');
                }
            } catch (e) {
                console.log('✅ Click successful (no redirect).');
            }
            await page.waitForTimeout(5000);
            await page.screenshot({ path: 'xiaomi-success.png' });
        }
    } else {
        console.log('ℹ️ No button found. Checking for "Checked in" status...');
        if (await page.getByText(/Eingecheckt|Checked in/i).first().isVisible()) {
            console.log('✅ "Checked in" text found. All good.');
        } else {
            await page.screenshot({ path: 'xiaomi-status.png' });
        }
    }

    // Speichern
    await context.storageState({ path: COOKIE_FILE });
    console.log(`💾 Session saved.`);

  } catch (error) {
    console.error('❌ Error:', error);
    await page.screenshot({ path: 'xiaomi-error.png' });
  } finally {
    await browser.close();
  }
})();

async function performLogin(page, context) {
    await page.waitForSelector('input[name="account"], input[id="username"]', { timeout: 30000 });
    console.log('✍️ Logging in...');
    await page.fill('input[name="account"], input[id="username"]', EMAIL);
    await page.fill('input[name="password"], input[id="pwd"]', PASSWORD);
    
    const agreement = page.locator('.agreement-checkbox');
    if (await agreement.isVisible()) await agreement.check();

    await page.click('button[type="submit"]');
    await page.waitForURL(url => !url.toString().includes('account.xiaomi.com'), { timeout: 30000 });
    console.log('Login successful.');
    
    await context.storageState({ path: COOKIE_FILE });
}
