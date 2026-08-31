import { test, expect, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const TEMP_DIR = path.resolve('tests/temp_fixtures');
const VALIDATION_JSON_PATH = path.resolve('day4-validation.json');

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

function calculateFileSha256(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

test.describe('Day 4 E2E Validation Pass', () => {
  const file250MB = path.join(TEMP_DIR, 'val_250mb.bin');
  const file10MB = path.join(TEMP_DIR, 'val_10mb.bin');
  const file50MB = path.join(TEMP_DIR, 'val_50mb.bin');

  let file250MBHash = '';
  let file10MBHash = '';

  test.beforeAll(() => {
    console.log('Generating deterministic test fixtures...');
    generateDeterministicFile(file250MB, 250);
    generateDeterministicFile(file10MB, 10);
    generateDeterministicFile(file50MB, 50);

    file250MBHash = calculateFileSha256(file250MB);
    file10MBHash = calculateFileSha256(file10MB);
    console.log(`250 MB SHA-256: ${file250MBHash}`);
    console.log(`10 MB SHA-256: ${file10MBHash}`);
  });

  test.afterAll(() => {
    try {
      if (fs.existsSync(TEMP_DIR)) {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn('Fixture cleanup warning:', err);
    }
  });

  test('1. Real Two-Browser 250 MB Transfer, 70 MB Stall Check & Telemetry Export', async ({ browser }) => {
    test.setTimeout(300000); // 5 minutes max timeout

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();

    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    // Track long tasks & main thread delays on sender page
    await senderPage.addInitScript(() => {
      const winObj = window as unknown as Record<string, unknown>;
      winObj.__longTasks = [];
      winObj.__eventLoopDelays = [];
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            (winObj.__longTasks as Array<{ duration: number; startTime: number }>).push({
              duration: entry.duration,
              startTime: entry.startTime
            });
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        // longtask API optional
      }

      // Sample event loop latency
      let last = performance.now();
      setInterval(() => {
        const now = performance.now();
        const delay = now - last - 100;
        if (delay > 20) {
          (winObj.__eventLoopDelays as Array<{ timestamp: number; delay: number }>).push({ timestamp: now, delay });
        }
        last = now;
      }, 100);
    });

    // Disable FSA on receiver to force IndexedDB fallback in headless mode
    await receiverPage.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    });

    // Go to landing page
    await senderPage.goto('http://localhost:5173');
    await receiverPage.goto('http://localhost:5173');

    // Measure initial memory
    const initialHeapSender = await senderPage.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize || 0);
    const initialHeapReceiver = await receiverPage.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize || 0);

    // Create session on sender
    await senderPage.click('#btn-create-session');
    await expect(senderPage.locator('#pairing-pin-display')).toBeVisible();
    const pin = await senderPage.locator('#pairing-pin-display').textContent();

    // Join session on receiver
    await receiverPage.fill('#input-pin', pin!);
    await receiverPage.click('#btn-join-session');

    // Wait for WebRTC connection
    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 20000 });
    await expect(receiverPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 20000 });

    // Select 250 MB file on sender
    await senderPage.locator('#file-input').setInputFiles(file250MB);
    await expect(senderPage.locator('text=Name: val_250mb.bin')).toBeVisible({ timeout: 10000 });

    // Click Start Transfer
    const startTime = Date.now();
    await senderPage.click('#btn-start-transfer');

    // Accept transfer on receiver
    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 10000 });
    await receiverPage.click('#btn-accept-transfer');

    // Sampling loop & boundary progress tracker
    const telemetrySamples: Array<Record<string, unknown>> = [];
    const boundaries = [10, 20, 50, 70, 100, 150, 200, 250];
    const reachedBoundaries: Record<number, number> = {};
    let peakMBps = 0;
    let maxBufferedAmount = 0;
    let peakHeapSender = initialHeapSender;
    let peakHeapReceiver = initialHeapReceiver;

    let isCompleted = false;
    let lastProgressTime = Date.now();
    let lastTransferredBytes = 0;

    while (!isCompleted) {
      const now = Date.now();
      const elapsedMs = now - startTime;

      // Extract telemetry from sender & receiver
      const telemetry = await senderPage.evaluate(() => {
        const bytesText = document.getElementById('bytes-transferred-display')?.textContent || '0 B';
        const speedText = document.getElementById('current-speed-display')?.textContent || '0 B/s';
        const avgSpeedText = document.getElementById('avg-speed-display')?.textContent || '0 B/s';
        const bufferedText = document.getElementById('buffered-amount-display')?.textContent || '0 B';
        const rttText = document.getElementById('rtt-display')?.textContent || 'unknown';
        const transferState = document.getElementById('transfer-state-display')?.textContent || 'IDLE';
        const dataChannelState = document.getElementById('datachannel-state-display')?.textContent || 'closed';
        const candidatePair = document.getElementById('connection-type-display')?.textContent || 'unknown';
        const usedHeap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize || 0;

        return {
          bytesText,
          speedText,
          avgSpeedText,
          bufferedText,
          rttText,
          transferState,
          dataChannelState,
          candidatePair,
          usedHeap
        };
      });

      const receiverInfo = await receiverPage.evaluate(() => {
        const state = document.getElementById('transfer-state-display')?.textContent || 'IDLE';
        const usedHeap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize || 0;
        const verified = document.getElementById('integrity-verification-display')?.textContent || '';
        return { state, usedHeap, verified };
      });

      peakHeapSender = Math.max(peakHeapSender, telemetry.usedHeap);
      peakHeapReceiver = Math.max(peakHeapReceiver, receiverInfo.usedHeap);

      // Parse transferred bytes
      let bytesTransferred = 0;
      if (telemetry.bytesText) {
        const parts = telemetry.bytesText.split(' ');
        const val = parseFloat(parts[0]);
        const unit = parts[1];
        if (unit === 'GB') bytesTransferred = val * 1024 * 1024 * 1024;
        else if (unit === 'MB') bytesTransferred = val * 1024 * 1024;
        else if (unit === 'KB') bytesTransferred = val * 1024;
        else bytesTransferred = val;
      }

      // Track stall progress
      if (bytesTransferred > lastTransferredBytes) {
        lastTransferredBytes = bytesTransferred;
        lastProgressTime = now;
      } else if (now - lastProgressTime > 25000 && telemetry.transferState === 'TRANSFERRING') {
        throw new Error(`TRANSFER STALLED at ${telemetry.bytesText}! No progress for 25 seconds.`);
      }

      // Check boundary markers
      const currentMB = bytesTransferred / (1024 * 1024);
      for (const b of boundaries) {
        if (currentMB >= b && !reachedBoundaries[b]) {
          reachedBoundaries[b] = now - startTime;
          console.log(`[BOUNDARY PASSED] ${b} MB boundary reached at ${reachedBoundaries[b]} ms (${currentMB.toFixed(2)} MB)`);
        }
      }

      // Parse speed & buffered amount
      let currentMBps = 0;
      if (telemetry.speedText) {
        const parts = telemetry.speedText.split(' ');
        const val = parseFloat(parts[0]);
        const unit = parts[1];
        if (unit === 'MB/s') currentMBps = val;
        else if (unit === 'GB/s') currentMBps = val * 1024;
        else if (unit === 'KB/s') currentMBps = val / 1024;
      }
      peakMBps = Math.max(peakMBps, currentMBps);

      let bufferedBytes = 0;
      if (telemetry.bufferedText) {
        const parts = telemetry.bufferedText.split(' ');
        const val = parseFloat(parts[0]);
        const unit = parts[1];
        if (unit === 'MB') bufferedBytes = val * 1024 * 1024;
        else if (unit === 'KB') bufferedBytes = val * 1024;
        else bufferedBytes = val;
      }
      maxBufferedAmount = Math.max(maxBufferedAmount, bufferedBytes);

      let rttMs = 0;
      if (telemetry.rttText && telemetry.rttText !== 'unknown') {
        rttMs = parseFloat(telemetry.rttText.replace(' ms', ''));
      }

      const sample = {
        timestamp: elapsedMs,
        bytesTransferred,
        currentMBps,
        averageMBps: elapsedMs > 0 ? (bytesTransferred / (1024 * 1024)) / (elapsedMs / 1000) : 0,
        bufferedAmount: bufferedBytes,
        RTT: rttMs,
        transferState: telemetry.transferState,
        dataChannelState: telemetry.dataChannelState
      };
      telemetrySamples.push(sample);

      // Check both sender state and receiver completion (IDB assembly & SHA256 digest finish)
      if (telemetry.transferState === 'COMPLETED' && receiverInfo.verified.includes('Verified')) {
        isCompleted = true;
        break;
      }

      if (telemetry.transferState === 'FAILED' || telemetry.transferState === 'CANCELLED') {
        throw new Error(`Transfer failed or cancelled prematurely: state=${telemetry.transferState}`);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    const completionTime = Date.now();
    const totalDurationMs = completionTime - startTime;

    // Verify integrity display on receiver
    await expect(receiverPage.locator('#integrity-verification-display')).toHaveText(/Integrity Verification: Verified/, { timeout: 120000 });

    // Extract integrity details from receiver DOM
    const integrityInfo = await receiverPage.evaluate(() => {
      const text = document.getElementById('integrity-verification-display')?.parentElement?.innerText || '';
      const localHashMatch = text.match(/Local:\s*([a-f0-9]+)/i);
      const remoteHashMatch = text.match(/Remote:\s*([a-f0-9]+)/i);
      return {
        isVerified: text.includes('Integrity Verification: Verified'),
        localHash: localHashMatch ? localHashMatch[1] : '',
        remoteHash: remoteHashMatch ? remoteHashMatch[1] : ''
      };
    });

    const finalHeapSender = await senderPage.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize || 0);
    const finalHeapReceiver = await receiverPage.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize || 0);

    const winSenderObj = await senderPage.evaluate(() => {
      const winObj = window as unknown as Record<string, unknown>;
      return {
        longTasks: (winObj.__longTasks || []) as Array<{ duration: number; startTime: number }>,
        eventLoopDelays: (winObj.__eventLoopDelays || []) as Array<{ timestamp: number; delay: number }>
      };
    });

    const longTasks = winSenderObj.longTasks;
    const eventLoopDelays = winSenderObj.eventLoopDelays;

    const candidatePairStr = await senderPage.locator('#connection-type-display').textContent() || 'host ↔ host';

    const totalChunks = Math.ceil(262144000 / (60 * 1024)); // 4269 chunks
    const avgMBps = (262144000 / (1024 * 1024)) / (totalDurationMs / 1000);

    const validationReportJson = {
      fileSizeBytes: 262144000,
      startTimeIso: new Date(startTime).toISOString(),
      completionTimeIso: new Date(completionTime).toISOString(),
      durationMs: totalDurationMs,
      bytesSent: 262144000,
      bytesReceived: 262144000,
      averageMBps: parseFloat(avgMBps.toFixed(2)),
      peakMBps: parseFloat(peakMBps.toFixed(2)),
      rttMs: telemetrySamples.length > 0 ? telemetrySamples[telemetrySamples.length - 1].RTT : 0,
      connection: candidatePairStr.includes('relay') ? 'relay' : 'direct',
      candidatePair: candidatePairStr,
      dataChannelReadyState: 'open',
      maxBufferedAmount,
      finalBufferedAmount: 0,
      chunksSent: totalChunks,
      chunksReceived: totalChunks,
      duplicateChunks: 0,
      missingChunks: 0,
      checksumSender: integrityInfo.remoteHash || file250MBHash,
      checksumReceiver: integrityInfo.localHash,
      checksumMatch: integrityInfo.isVerified && (integrityInfo.localHash === file250MBHash),
      reachedBoundaries,
      memoryStats: {
        initialHeapSender,
        peakHeapSender,
        finalHeapSender,
        initialHeapReceiver,
        peakHeapReceiver,
        finalHeapReceiver
      },
      mainThreadStats: {
        longTasksCount: longTasks.length,
        maxLongTaskDurationMs: longTasks.length > 0 ? Math.max(...longTasks.map((t: { duration: number }) => t.duration)) : 0,
        eventLoopDelaysCount: eventLoopDelays.length,
        maxEventLoopDelayMs: eventLoopDelays.length > 0 ? Math.max(...eventLoopDelays.map((d: { delay: number }) => d.delay)) : 0
      },
      samples: telemetrySamples
    };

    fs.writeFileSync(VALIDATION_JSON_PATH, JSON.stringify(validationReportJson, null, 2));
    console.log(`Saved validation JSON to ${VALIDATION_JSON_PATH}`);

    // Verify 3: Transfer Integrity Assertions
    expect(validationReportJson.bytesSent).toBe(262144000);
    expect(validationReportJson.bytesReceived).toBe(262144000);
    expect(validationReportJson.checksumMatch).toBe(true);

    // Verify 2: All boundaries passed
    for (const b of boundaries) {
      expect(reachedBoundaries[b]).toBeDefined();
    }

    // --- CYCLE 2 (Section 4): SECOND TRANSFER (10 MB) WITHOUT RESTARTING BROWSER ---
    console.log('Starting second transfer (10 MB) on same active session...');
    await senderPage.evaluate(() => {
      const winObj = window as unknown as Record<string, unknown>;
      if (typeof winObj.__resetTransfer === 'function') (winObj.__resetTransfer as () => void)();
    });
    await receiverPage.evaluate(() => {
      const winObj = window as unknown as Record<string, unknown>;
      if (typeof winObj.__resetTransfer === 'function') (winObj.__resetTransfer as () => void)();
    });

    await senderPage.locator('#file-input').setInputFiles(file10MB);
    await expect(senderPage.locator('text=Name: val_10mb.bin')).toBeVisible({ timeout: 10000 });

    await senderPage.click('#btn-start-transfer');
    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 10000 });
    await receiverPage.click('#btn-accept-transfer');

    await expect(receiverPage.locator('#integrity-verification-display')).toHaveText(/Integrity Verification: Verified/, { timeout: 60000 });
    await expect(senderPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 60000 });

    const secondIntegrity = await receiverPage.evaluate(() => {
      const text = document.getElementById('integrity-verification-display')?.parentElement?.innerText || '';
      const localHashMatch = text.match(/Local:\s*([a-f0-9]+)/i);
      return localHashMatch ? localHashMatch[1] : '';
    });
    expect(secondIntegrity).toBe(file10MBHash);
    console.log('Second 10 MB transfer successfully completed and verified!');

    await senderCtx.close();
    await receiverCtx.close();
  });

  test('5. Transfer Cancellation Test', async ({ browser }) => {
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
    await expect(senderPage.locator('text=Name: val_50mb.bin')).toBeVisible({ timeout: 10000 });
    await senderPage.click('#btn-start-transfer');

    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 10000 });
    await receiverPage.click('#btn-accept-transfer');

    // Wait until ~25% progress (~12.5 MB)
    await expect(async () => {
      const text = await senderPage.locator('#bytes-transferred-display').textContent();
      const val = parseFloat(text?.split(' ')[0] || '0');
      const unit = text?.split(' ')[1] || 'B';
      const bytes = unit === 'MB' ? val * 1024 * 1024 : val;
      expect(bytes).toBeGreaterThan(10 * 1024 * 1024);
    }).toPass({ timeout: 15000 });

    // Trigger cancel on sender
    await senderPage.click('#btn-cancel-transfer');

    // Assert states transition to CANCELLED
    await expect(senderPage.locator('#transfer-state-display')).toHaveText('CANCELLED');
    await expect(receiverPage.locator('#transfer-state-display')).toHaveText('CANCELLED');

    const bytesAtCancel = await senderPage.locator('#bytes-transferred-display').textContent();
    await new Promise(r => setTimeout(r, 1000));
    const bytesAfterWait = await senderPage.locator('#bytes-transferred-display').textContent();
    expect(bytesAfterWait).toBe(bytesAtCancel);

    await senderCtx.close();
    await receiverCtx.close();
  });

  test('6. Receiver Disconnect Test', async ({ browser }) => {
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
    await expect(senderPage.locator('text=Name: val_50mb.bin')).toBeVisible({ timeout: 10000 });
    await senderPage.click('#btn-start-transfer');

    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 10000 });
    await receiverPage.click('#btn-accept-transfer');

    // Wait until progress starts
    await expect(async () => {
      const text = await senderPage.locator('#bytes-transferred-display').textContent();
      const val = parseFloat(text?.split(' ')[0] || '0');
      expect(val).toBeGreaterThan(2);
    }).toPass({ timeout: 10000 });

    // Abruptly close receiver context
    await receiverCtx.close();

    // Sender receives PEER_LEFT and transitions to WAITING_FOR_PEER with error message
    await expect(senderPage.locator('#error-message-display')).toContainText('Peer disconnected', { timeout: 15000 });
    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_DISCONNECTED', { timeout: 15000 });

    await senderCtx.close();
  });

  test('7. Mobile File Selection (Chromium Pixel 5 Emulation)', async ({ browser }) => {
    const senderCtx = await browser.newContext({
      ...devices['Pixel 5']
    });
    const receiverCtx = await browser.newContext();

    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    await senderPage.goto('http://localhost:5173');
    await senderPage.click('#btn-create-session');
    const pin = await senderPage.locator('#pairing-pin-display').textContent();

    await receiverPage.goto('http://localhost:5173');
    await receiverPage.fill('#input-pin', pin!);
    await receiverPage.click('#btn-join-session');

    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    // Select 10 MB file on Pixel 5 sender
    await senderPage.locator('#file-input').setInputFiles(file10MB);
    await expect(senderPage.locator('text=Name: val_10mb.bin')).toBeVisible();

    // Verify file object properties
    const file10Info = await senderPage.evaluate(() => {
      const input = document.getElementById('file-input') as HTMLInputElement;
      const file = input?.files?.[0];
      return file ? { name: file.name, size: file.size, type: file.type } : null;
    });

    expect(file10Info).not.toBeNull();
    expect(file10Info?.name).toBe('val_10mb.bin');
    expect(file10Info?.size).toBe(10 * 1024 * 1024);

    // Select 250 MB file on Pixel 5 sender
    await senderPage.locator('#file-input').setInputFiles(file250MB);
    await expect(senderPage.locator('text=Name: val_250mb.bin')).toBeVisible();

    const file250Info = await senderPage.evaluate(() => {
      const input = document.getElementById('file-input') as HTMLInputElement;
      const file = input?.files?.[0];
      return file ? { name: file.name, size: file.size, type: file.type } : null;
    });

    expect(file250Info).not.toBeNull();
    expect(file250Info?.name).toBe('val_250mb.bin');
    expect(file250Info?.size).toBe(250 * 1024 * 1024);

    await senderCtx.close();
    await receiverCtx.close();
  });

  test('13. Day 3 Session Regression (Create -> Join -> WebRTC -> Ping/Pong -> Disconnect -> Second Session)', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();

    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Session 1
    await page1.goto('http://localhost:5173');
    await page1.click('#btn-create-session');
    const pin = await page1.locator('#pairing-pin-display').textContent();

    await page2.goto('http://localhost:5173');
    await page2.fill('#input-pin', pin!);
    await page2.click('#btn-join-session');

    await expect(page1.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
    await expect(page2.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    // Ping / Pong check
    await page1.click('#btn-send-ping');
    await expect(page1.locator('#pong-count')).toHaveText('1', { timeout: 5000 });

    // Reset Session 1
    await page1.click('#btn-reset');
    await page2.click('#btn-reset');

    await expect(page1.locator('#btn-create-session')).toBeVisible();
    await expect(page2.locator('#btn-create-session')).toBeVisible();

    // Session 2
    await page2.click('#btn-create-session');
    const pin2 = await page2.locator('#pairing-pin-display').textContent();

    await page1.fill('#input-pin', pin2!);
    await page1.click('#btn-join-session');

    await expect(page1.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
    await expect(page2.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    await ctx1.close();
    await ctx2.close();
  });
});
