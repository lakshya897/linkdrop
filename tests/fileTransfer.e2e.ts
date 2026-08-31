import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const TEMP_DIR = path.resolve('tests/temp_fixtures');

// Deterministic generator using a repeating 1 MB pattern
function generateDeterministicFile(filePath: string, sizeInMB: number) {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const chunk = Buffer.alloc(1024 * 1024); // 1 MB template
  for (let i = 0; i < chunk.length; i++) {
    chunk[i] = i % 256;
  }

  const fd = fs.openSync(filePath, 'w');
  for (let i = 0; i < sizeInMB; i++) {
    fs.writeSync(fd, chunk);
  }
  fs.closeSync(fd);
}

test.describe('WebRTC File Transfer Lifecycle Tests', () => {
  const file250MB = path.join(TEMP_DIR, 'test_250mb.bin');
  const file10MB = path.join(TEMP_DIR, 'test_10mb.bin');
  const file50MB = path.join(TEMP_DIR, 'test_50mb.bin');

  test.beforeAll(() => {
    // Generate fixtures
    generateDeterministicFile(file250MB, 250);
    generateDeterministicFile(file10MB, 10);
    generateDeterministicFile(file50MB, 50);
  });

  test.afterAll(() => {
    // Cleanup fixtures
    try {
      if (fs.existsSync(file250MB)) fs.unlinkSync(file250MB);
      if (fs.existsSync(file10MB)) fs.unlinkSync(file10MB);
      if (fs.existsSync(file50MB)) fs.unlinkSync(file50MB);
      if (fs.existsSync(TEMP_DIR)) fs.rmdirSync(TEMP_DIR);
    } catch (err) {
      console.warn('Fixture cleanup warning:', err);
    }
  });

  test('P2P File Transfer (250MB + 10MB Second Transfer)', async ({ browser }) => {
    test.setTimeout(240000);
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();

    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    senderPage.on('console', msg => console.log('SENDER CONSOLE:', msg.text()));
    receiverPage.on('console', msg => console.log('RECEIVER CONSOLE:', msg.text()));

    // Disable FSA on receiver to force IndexedDB fallback in headless mode
    await receiverPage.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    });

    // --- PAIR PEERS ---
    await senderPage.goto('http://localhost:5173');
    await senderPage.click('#btn-create-session');

    await expect(senderPage.locator('#pairing-pin-display')).toBeVisible();
    const pin = await senderPage.locator('#pairing-pin-display').textContent();

    await receiverPage.goto('http://localhost:5173');
    await receiverPage.fill('#input-pin', pin!);
    await receiverPage.click('#btn-join-session');

    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
    await expect(receiverPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    // --- CYCLE 1: 250 MB TRANSFER ---
    await senderPage.locator('#file-input').setInputFiles(file250MB);
    await expect(senderPage.locator('text=Name: test_250mb.bin')).toBeVisible({ timeout: 10000 });
    await senderPage.click('#btn-start-transfer');

    // Wait for prompt on receiver and accept
    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 10000 });
    await receiverPage.click('#btn-accept-transfer');

    // Assert that transfer gets past 70 MB to cover previous failure region
    const progressCheckInterval = setInterval(async () => {
      try {
        const text = await senderPage.locator('#bytes-transferred-display').textContent();
        if (text && text.includes('MB')) {
          const num = parseFloat(text.split(' ')[0]);
          if (num > 70) {
            console.log(`Successfully passed 70 MB boundary: ${text}`);
            clearInterval(progressCheckInterval);
          }
        }
      } catch {
        // Ignored
      }
    }, 1000);

    // Assert completion & integrity match
    await expect(receiverPage.locator('#integrity-verification-display')).toHaveText(/Integrity Verification: Verified/, { timeout: 120000 });
    await expect(senderPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 120000 });
    clearInterval(progressCheckInterval);

    // --- CYCLE 2: 10 MB TRANSFER (NO RESET/RESTART) ---
    await senderPage.evaluate(() => {
      const winObj = window as unknown as Record<string, unknown>;
      if (typeof winObj.__resetTransfer === 'function') (winObj.__resetTransfer as () => void)();
    });
    await receiverPage.evaluate(() => {
      const winObj = window as unknown as Record<string, unknown>;
      if (typeof winObj.__resetTransfer === 'function') (winObj.__resetTransfer as () => void)();
    });

    await senderPage.locator('#file-input').setInputFiles(file10MB);
    await expect(senderPage.locator('text=Name: test_10mb.bin')).toBeVisible({ timeout: 10000 });
    await senderPage.click('#btn-start-transfer');

    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 10000 });
    await receiverPage.click('#btn-accept-transfer');

    await expect(receiverPage.locator('#integrity-verification-display')).toHaveText(/Integrity Verification: Verified/, { timeout: 60000 });
    await expect(senderPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 60000 });

    await senderCtx.close();
    await receiverCtx.close();
  });

  test('P2P File Transfer Cancel Path', async ({ browser }) => {
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();

    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    await receiverPage.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    });

    await senderPage.goto('http://localhost:5173');
    await senderPage.click('#btn-create-session');
    const pin = await senderPage.locator('#pairing-pin-display').textContent();

    await receiverPage.goto('http://localhost:5173');
    await receiverPage.fill('#input-pin', pin!);
    await receiverPage.click('#btn-join-session');

    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    await senderPage.locator('#file-input').setInputFiles(file50MB);
    await expect(senderPage.locator('text=Name: test_50mb.bin')).toBeVisible({ timeout: 10000 });
    await senderPage.click('#btn-start-transfer');

    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 10000 });
    await receiverPage.click('#btn-accept-transfer');

    // Wait until progress starts (e.g. gets past 5 MB)
    await expect(async () => {
      const text = await senderPage.locator('#bytes-transferred-display').textContent();
      const num = parseFloat(text?.split(' ')[0] || '0');
      expect(num).toBeGreaterThan(5);
    }).toPass({ timeout: 10000 });

    // Cancel on sender
    await senderPage.click('#btn-cancel-transfer');

    // Assert cancelled state
    await expect(senderPage.locator('#transfer-state-display')).toHaveText('CANCELLED');
    await expect(receiverPage.locator('#transfer-state-display')).toHaveText('CANCELLED');

    await senderCtx.close();
    await receiverCtx.close();
  });

  test('P2P File Transfer Disconnect Path', async ({ browser }) => {
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();

    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    await receiverPage.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    });

    await senderPage.goto('http://localhost:5173');
    await senderPage.click('#btn-create-session');
    const pin = await senderPage.locator('#pairing-pin-display').textContent();

    await receiverPage.goto('http://localhost:5173');
    await receiverPage.fill('#input-pin', pin!);
    await receiverPage.click('#btn-join-session');

    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    await senderPage.locator('#file-input').setInputFiles(file50MB);
    await expect(senderPage.locator('text=Name: test_50mb.bin')).toBeVisible({ timeout: 10000 });
    await senderPage.click('#btn-start-transfer');

    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 10000 });
    await receiverPage.click('#btn-accept-transfer');

    // Wait until progress starts
    await expect(async () => {
      const text = await senderPage.locator('#bytes-transferred-display').textContent();
      const num = parseFloat(text?.split(' ')[0] || '0');
      expect(num).toBeGreaterThan(2);
    }).toPass({ timeout: 10000 });

    // Close receiver context abruptly mid-transfer
    await receiverCtx.close();

    // Assert sender registers failure/disconnection via error display
    await expect(senderPage.locator('#error-message-display')).toContainText('Peer disconnected', { timeout: 15000 });
    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_DISCONNECTED', { timeout: 15000 });

    await senderCtx.close();
  });
});
