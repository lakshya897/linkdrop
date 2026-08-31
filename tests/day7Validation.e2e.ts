import { test, expect, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const TEMP_DIR = path.resolve('tests/temp_fixtures');
const DAY7_JSON_PATH = path.resolve('docs/reports/day7-benchmark-results.json');

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

function saveResultToJson(key: string, data: unknown) {
  let current: Record<string, unknown> = {};
  if (fs.existsSync(DAY7_JSON_PATH)) {
    try {
      current = JSON.parse(fs.readFileSync(DAY7_JSON_PATH, 'utf-8'));
    } catch {
      current = {};
    }
  }
  current[key] = data;
  const dir = path.dirname(DAY7_JSON_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DAY7_JSON_PATH, JSON.stringify(current, null, 2));
}

test.describe('Day 7 — Real End-to-End Throughput Validation & Final Bottleneck Analysis', () => {
  test.describe.configure({ mode: 'serial' });

  const file250MB = path.join(TEMP_DIR, 'val_day7_250mb.bin');
  const file10MB = path.join(TEMP_DIR, 'val_day7_10mb.bin');
  const file50MB = path.join(TEMP_DIR, 'val_day7_50mb.bin');

  const file900MB = path.join(TEMP_DIR, 'val_day7_900mb.bin');
  let file250MBHash = '';
  let file10MBHash = '';
  let file900MBHash = '';

  test.beforeAll(() => {
    console.log('Generating Day 7 test fixtures...');
    generateDeterministicFile(file250MB, 250);
    generateDeterministicFile(file10MB, 10);
    generateDeterministicFile(file50MB, 50);
    generateDeterministicFile(file900MB, 900);

    file250MBHash = calculateFileSha256(file250MB);
    file10MBHash = calculateFileSha256(file10MB);
    file900MBHash = calculateFileSha256(file900MB);
    console.log(`250 MB Fixture SHA-256: ${file250MBHash}`);
    console.log(`10 MB Fixture SHA-256: ${file10MBHash}`);
    console.log(`900 MB Fixture SHA-256: ${file900MBHash}`);
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

  // --- PHASE 3: RAW WEBRTC (3 RUNS) ---
  test('Phase 3: Test 1 — Raw WebRTC 250 MB Benchmark (3 Runs)', async ({ browser }) => {
    test.setTimeout(300000);

    const runs: number[] = [];
    const runMetricsList: unknown[] = [];

    for (let run = 1; run <= 3; run++) {
      console.log(`\n--- Raw WebRTC Run ${run}/3 ---`);
      const senderCtx = await browser.newContext();
      const receiverCtx = await browser.newContext();
      const senderPage = await senderCtx.newPage();
      const receiverPage = await receiverCtx.newPage();

      senderPage.on('console', msg => console.log('SENDER CONSOLE:', msg.text()));
      receiverPage.on('console', msg => console.log('RECEIVER CONSOLE:', msg.text()));

      await senderPage.goto('http://localhost:5173/benchmark');
      await receiverPage.goto('http://localhost:5173/benchmark');

      await senderPage.waitForSelector('#btn-create-benchmark-session');
      await senderPage.click('#btn-create-benchmark-session');
      await expect(senderPage.locator('#benchmark-pin-display')).toBeVisible({ timeout: 15000 });
      const pin = await senderPage.locator('#benchmark-pin-display').textContent();

      await receiverPage.fill('#input-benchmark-pin', pin!.trim());
      await receiverPage.click('#btn-join-benchmark-session');

      await expect(senderPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });
      await expect(receiverPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });

      await senderPage.click('#btn-raw-webrtc');

      await expect.poll(async () => {
        const text = await senderPage.locator('#benchmark-results').textContent();
        if (!text || text.includes('// Benchmark')) return '';
        try {
          const parsed = JSON.parse(text);
          return parsed.connectionState ? 'COMPLETED' : '';
        } catch {
          return '';
        }
      }, { timeout: 120000, intervals: [1000] }).toBe('COMPLETED');

      const rawText = await senderPage.locator('#benchmark-results').textContent();
      const metrics = JSON.parse(rawText!);
      runs.push(metrics.avgMBps);
      runMetricsList.push(metrics);
      console.log(`Run ${run}: ${metrics.avgMBps.toFixed(2)} MB/s (Peak: ${metrics.peakMBps.toFixed(2)} MB/s, Pause: ${metrics.pauseCount} pauses, ${(metrics.pauseDurationMs / 1000).toFixed(2)} s)`);

      await senderCtx.close();
      await receiverCtx.close();
    }

    const sorted = [...runs].sort((a, b) => a - b);
    const median = sorted[1];
    const avg = runs.reduce((a, b) => a + b, 0) / runs.length;

    const summary = {
      testName: 'RAW_WEBRTC_3RUNS',
      run1: runs[0],
      run2: runs[1],
      run3: runs[2],
      median,
      average: avg,
      detailedRuns: runMetricsList
    };

    saveResultToJson('rawWebRTC_3Runs', summary);
    console.log(`\nRaw WebRTC 3-Run Results: Run1=${runs[0].toFixed(2)}, Run2=${runs[1].toFixed(2)}, Run3=${runs[2].toFixed(2)} -> Median=${median.toFixed(2)} MB/s, Avg=${avg.toFixed(2)} MB/s`);
  });

  // --- PHASE 4: FILE -> WEBRTC (3 RUNS) ---
  test('Phase 4: Test 2 — File -> WebRTC 250 MB Benchmark (3 Runs)', async ({ browser }) => {
    test.setTimeout(300000);

    const runs: number[] = [];
    const runMetricsList: unknown[] = [];

    for (let run = 1; run <= 3; run++) {
      console.log(`\n--- File -> WebRTC Run ${run}/3 ---`);
      const senderCtx = await browser.newContext();
      const receiverCtx = await browser.newContext();
      const senderPage = await senderCtx.newPage();
      const receiverPage = await receiverCtx.newPage();

      await senderPage.goto('http://localhost:5173/benchmark');
      await receiverPage.goto('http://localhost:5173/benchmark');

      await senderPage.waitForSelector('#btn-create-benchmark-session');
      await senderPage.click('#btn-create-benchmark-session');
      await expect(senderPage.locator('#benchmark-pin-display')).toBeVisible({ timeout: 15000 });
      const pin = await senderPage.locator('#benchmark-pin-display').textContent();

      await receiverPage.fill('#input-benchmark-pin', pin!.trim());
      await receiverPage.click('#btn-join-benchmark-session');

      await expect(senderPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });
      await expect(receiverPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });

      await senderPage.click('#btn-file-webrtc');

      await expect.poll(async () => {
        const text = await senderPage.locator('#benchmark-results').textContent();
        if (!text || text.includes('// Benchmark')) return '';
        try {
          const parsed = JSON.parse(text);
          return parsed.mode === 'FILE_WEBRTC' ? 'COMPLETED' : '';
        } catch {
          return '';
        }
      }, { timeout: 120000, intervals: [1000] }).toBe('COMPLETED');

      const fileText = await senderPage.locator('#benchmark-results').textContent();
      const metrics = JSON.parse(fileText!);
      runs.push(metrics.avgMBps);
      runMetricsList.push(metrics);
      console.log(`Run ${run}: ${metrics.avgMBps.toFixed(2)} MB/s`);

      await senderCtx.close();
      await receiverCtx.close();
    }

    const sorted = [...runs].sort((a, b) => a - b);
    const median = sorted[1];
    const avg = runs.reduce((a, b) => a + b, 0) / runs.length;

    const summary = {
      testName: 'FILE_WEBRTC_3RUNS',
      run1: runs[0],
      run2: runs[1],
      run3: runs[2],
      median,
      average: avg,
      detailedRuns: runMetricsList
    };

    saveResultToJson('fileWebRTC_3Runs', summary);
    console.log(`\nFile -> WebRTC 3-Run Results: Run1=${runs[0].toFixed(2)}, Run2=${runs[1].toFixed(2)}, Run3=${runs[2].toFixed(2)} -> Median=${median.toFixed(2)} MB/s, Avg=${avg.toFixed(2)} MB/s`);
  });

  // --- PHASE 5: DIRECT FSA STORAGE BENCHMARK (3 RUNS) ---
  test('Phase 5: Test 3 — Direct FSA 250 MB Benchmark (3 Runs)', async ({ browser }) => {
    test.setTimeout(360000);

    const runs: number[] = [];
    const runMetricsList: unknown[] = [];

    for (let run = 1; run <= 3; run++) {
      console.log(`\n--- Direct FSA Run ${run}/3 ---`);
      const senderCtx = await browser.newContext();
      const receiverCtx = await browser.newContext();
      const senderPage = await senderCtx.newPage();
      const receiverPage = await receiverCtx.newPage();

      // Enable FSA mock in receiver context
      await receiverPage.addInitScript(() => {
        const winObj = window as unknown as Record<string, unknown>;
        winObj.showSaveFilePicker = async () => {
          const root = await navigator.storage.getDirectory();
          return await root.getFileHandle('bench_fsa.bin', { create: true });
        };
      });

      await senderPage.goto('http://localhost:5173/benchmark');
      await receiverPage.goto('http://localhost:5173/benchmark');

      await senderPage.waitForSelector('#btn-create-benchmark-session');
      await senderPage.click('#btn-create-benchmark-session');
      await expect(senderPage.locator('#benchmark-pin-display')).toBeVisible({ timeout: 15000 });
      const pin = await senderPage.locator('#benchmark-pin-display').textContent();

      await receiverPage.fill('#input-benchmark-pin', pin!.trim());
      await receiverPage.click('#btn-join-benchmark-session');

      await expect(senderPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });
      await expect(receiverPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });

      await senderPage.click('#btn-storage-webrtc');

      await expect.poll(async () => {
        const text = await receiverPage.locator('#benchmark-results').textContent();
        if (!text || text.includes('// Benchmark')) return '';
        try {
          const parsed = JSON.parse(text);
          return parsed.mode === 'WEBRTC_STORAGE' ? 'COMPLETED' : '';
        } catch {
          return '';
        }
      }, { timeout: 180000, intervals: [1000] }).toBe('COMPLETED');

      const storageText = await receiverPage.locator('#benchmark-results').textContent();
      const metrics = JSON.parse(storageText!);
      runs.push(metrics.avgMBps);
      runMetricsList.push(metrics);
      console.log(`Direct FSA Run ${run}: Throughput ${metrics.avgMBps.toFixed(2)} MB/s, Backend: ${metrics.storageBackend}, StorageWriteMs: ${metrics.storageWriteMs}`);

      await senderCtx.close();
      await receiverCtx.close();
    }

    const sorted = [...runs].sort((a, b) => a - b);
    const median = sorted[1];
    const avg = runs.reduce((a, b) => a + b, 0) / runs.length;

    const summary = {
      testName: 'DIRECT_FSA_3RUNS',
      run1: runs[0],
      run2: runs[1],
      run3: runs[2],
      median,
      average: avg,
      detailedRuns: runMetricsList
    };

    saveResultToJson('directFSA_3Runs', summary);
    console.log(`\nDirect FSA 3-Run Results: Median=${median.toFixed(2)} MB/s, Avg=${avg.toFixed(2)} MB/s`);
  });

  // --- PHASE 6: 900 MB DIRECT FSA STREAMING ---
  test('Phase 6: Test 4 — 900 MB Direct FSA Large Stream Validation', async ({ browser }) => {
    test.setTimeout(600000); // 10 minutes max timeout for 900 MB payload

    console.log('\n--- Phase 6: 900 MB Direct FSA Transfer Test ---');
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    // Enable FSA mock in receiver
    await receiverPage.addInitScript(() => {
      const winObj = window as unknown as Record<string, unknown>;
      winObj.showSaveFilePicker = async () => {
        const root = await navigator.storage.getDirectory();
        return await root.getFileHandle('bench_900mb.bin', { create: true });
      };
    });

    await senderPage.goto('http://localhost:5173');
    await receiverPage.goto('http://localhost:5173');

    // Create session
    await senderPage.click('#btn-create-session');
    await expect(senderPage.locator('#pairing-pin-display')).toBeVisible({ timeout: 30000 });
    const pin = await senderPage.locator('#pairing-pin-display').textContent();

    await receiverPage.fill('#input-pin', pin!.trim());
    await receiverPage.click('#btn-join-session');

    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
    await expect(receiverPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    // Select file on sender
    await senderPage.locator('#file-input').setInputFiles(file900MB);
    await senderPage.click('#btn-start-transfer');

    // Receiver accepts file
    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 20000 });
    await receiverPage.click('#btn-accept-transfer');

    // Wait for transfer completion
    await expect(senderPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 480000 });
    await expect(receiverPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 480000 });

    const receiverBackend = await receiverPage.locator('#storage-backend-display').textContent();
    const hashMatchText = await receiverPage.locator('#integrity-verification-display').textContent();

    console.log(`900 MB Transfer Completed! Storage Backend: ${receiverBackend}, Integrity: ${hashMatchText}`);
    expect(hashMatchText).toContain('Verified');

    saveResultToJson('test900MB_FSA', {
      testName: '900MB_FSA_STREAM',
      status: 'PASS',
      fileSizeBytes: 900 * 1024 * 1024,
      storageBackend: receiverBackend,
      expectedHash: file900MBHash,
      hashMatch: true
    });

    await senderCtx.close();
    await receiverCtx.close();
  });

  // --- PHASE 7: ANDROID -> DESKTOP (PIXEL 5 EMULATION) ---
  test('Phase 7: Test 5 — Android Device Emulation (250 MB Transfer)', async ({ browser }) => {
    test.setTimeout(300000);

    console.log('\n--- Phase 7: Android Pixel 5 Emulation Test ---');
    const androidCtx = await browser.newContext({
      ...devices['Pixel 5'],
      hasTouch: true,
      isMobile: true
    });
    const desktopCtx = await browser.newContext();

    const androidPage = await androidCtx.newPage();
    const desktopPage = await desktopCtx.newPage();

    // Enable FSA mock on desktop receiver
    await desktopPage.addInitScript(() => {
      const winObj = window as unknown as Record<string, unknown>;
      winObj.showSaveFilePicker = async () => {
        const root = await navigator.storage.getDirectory();
        return await root.getFileHandle('android_rec.bin', { create: true });
      };
    });

    await androidPage.goto('http://localhost:5173');
    await desktopPage.goto('http://localhost:5173');

    // Android acts as sender
    await androidPage.click('#btn-create-session');
    await expect(androidPage.locator('#pairing-pin-display')).toBeVisible({ timeout: 30000 });
    const pin = await androidPage.locator('#pairing-pin-display').textContent();

    await desktopPage.fill('#input-pin', pin!.trim());
    await desktopPage.click('#btn-join-session');

    await expect(androidPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
    await expect(desktopPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    // Select 250 MB file on Android
    await androidPage.locator('#file-input').setInputFiles(file250MB);
    await androidPage.click('#btn-start-transfer');

    // Desktop accepts
    await expect(desktopPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 15000 });
    await desktopPage.click('#btn-accept-transfer');

    // Progress boundaries check: 70MB, 100MB, 200MB, 250MB
    const boundaries = [70, 100, 200, 250];
    for (const b of boundaries) {
      await expect.poll(async () => {
        const text = await androidPage.locator('#bytes-transferred-display').textContent();
        if (!text) return 0;
        return parseFloat(text.split(' ')[0]) || 0;
      }, { timeout: 180000, intervals: [1000] }).toBeGreaterThanOrEqual(b);
      console.log(`Android -> Desktop Boundary Crossed: ${b} MB`);
    }

    await expect(androidPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 60000 });
    await expect(desktopPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 60000 });

    const hashMatchText = await desktopPage.locator('#integrity-verification-display').textContent();
    expect(hashMatchText).toContain('Verified');

    saveResultToJson('androidToDesktop_250MB', {
      testName: 'ANDROID_PIXEL5_EMULATION',
      status: 'PASS',
      fileSizeBytes: 250 * 1024 * 1024,
      device: 'Pixel 5 (Chromium Emulation)',
      hashMatch: true
    });

    await androidCtx.close();
    await desktopCtx.close();
  });

  // --- PHASE 8: SECOND TRANSFER (250 MB -> 10 MB) ---
  test('Phase 8: Test 6 — Sequential Transfers (250 MB -> 10 MB)', async ({ browser }) => {
    test.setTimeout(360000);

    console.log('\n--- Phase 8: Second Transfer Test (250 MB -> 10 MB) ---');
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    await receiverPage.addInitScript(() => {
      const winObj = window as unknown as Record<string, unknown>;
      let count = 0;
      winObj.showSaveFilePicker = async () => {
        count++;
        const root = await navigator.storage.getDirectory();
        return await root.getFileHandle(`seq_transfer_${count}.bin`, { create: true });
      };
    });

    await senderPage.goto('http://localhost:5173');
    await receiverPage.goto('http://localhost:5173');

    await senderPage.click('#btn-create-session');
    await expect(senderPage.locator('#pairing-pin-display')).toBeVisible({ timeout: 30000 });
    const pin = await senderPage.locator('#pairing-pin-display').textContent();

    await receiverPage.fill('#input-pin', pin!.trim());
    await receiverPage.click('#btn-join-session');

    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
    await expect(receiverPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    // Transfer 1: 250 MB
    console.log('Initiating Transfer 1 (250 MB)...');
    await senderPage.locator('#file-input').setInputFiles(file250MB);
    await senderPage.click('#btn-start-transfer');
    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 15000 });
    await receiverPage.click('#btn-accept-transfer');

    await expect(senderPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 180000 });
    await expect(receiverPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 180000 });
    console.log('Transfer 1 (250 MB) Completed!');

    // Reset UI for Transfer 2 without refresh
    await senderPage.evaluate(() => (window as unknown as { __resetTransfer: () => void }).__resetTransfer());
    await receiverPage.evaluate(() => (window as unknown as { __resetTransfer: () => void }).__resetTransfer());

    // Transfer 2: 10 MB
    console.log('Initiating Transfer 2 (10 MB)...');
    await senderPage.locator('#file-input').setInputFiles(file10MB);
    await senderPage.click('#btn-start-transfer');
    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 15000 });
    await receiverPage.click('#btn-accept-transfer');

    await expect(senderPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 60000 });
    await expect(receiverPage.locator('#transfer-state-display')).toHaveText('COMPLETED', { timeout: 60000 });
    console.log('Transfer 2 (10 MB) Completed!');

    const hashMatchText = await receiverPage.locator('#integrity-verification-display').textContent();
    expect(hashMatchText).toContain('Verified');

    saveResultToJson('secondTransfer_Seq', {
      testName: 'SEQUENTIAL_TRANSFERS_250MB_10MB',
      status: 'PASS',
      transfer1: '250 MB COMPLETED',
      transfer2: '10 MB COMPLETED',
      hashMatch: true
    });

    await senderCtx.close();
    await receiverCtx.close();
  });

  // --- PHASE 9: CANCEL TEST ---
  test('Phase 9: Test 7 — Cancel Transfer Mid-Flight (~25%)', async ({ browser }) => {
    test.setTimeout(180000);

    console.log('\n--- Phase 9: Cancel Transfer Test ---');
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    await receiverPage.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    });

    await senderPage.goto('http://localhost:5173');
    await receiverPage.goto('http://localhost:5173');

    await senderPage.click('#btn-create-session');
    await expect(senderPage.locator('#pairing-pin-display')).toBeVisible({ timeout: 30000 });
    const pin = await senderPage.locator('#pairing-pin-display').textContent();

    await receiverPage.fill('#input-pin', pin!.trim());
    await receiverPage.click('#btn-join-session');

    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
    await expect(receiverPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    await senderPage.locator('#file-input').setInputFiles(file50MB);
    await senderPage.click('#btn-start-transfer');
    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 15000 });
    await receiverPage.click('#btn-accept-transfer');

    // Wait until progress starts
    await expect(async () => {
      const text = await senderPage.locator('#bytes-transferred-display').textContent();
      const num = parseFloat(text?.split(' ')[0] || '0');
      expect(num).toBeGreaterThan(5);
    }).toPass({ timeout: 20000 });

    console.log('Progress started. Clicking Cancel Transfer...');
    await senderPage.click('#btn-cancel-transfer');

    await expect(senderPage.locator('#transfer-state-display')).toHaveText('CANCELLED', { timeout: 15000 });
    await expect(receiverPage.locator('#transfer-state-display')).toHaveText('CANCELLED', { timeout: 15000 });

    console.log('Cancel Transfer Test Passed!');
    saveResultToJson('cancelTest', {
      testName: 'CANCEL_MID_FLIGHT',
      status: 'PASS'
    });

    await senderCtx.close();
    await receiverCtx.close();
  });

  // --- PHASE 10: DISCONNECT TEST ---
  test('Phase 10: Test 8 — Peer Disconnect Mid-Flight (~25%)', async ({ browser }) => {
    test.setTimeout(180000);

    console.log('\n--- Phase 10: Disconnect Test ---');
    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    await receiverPage.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    });

    await senderPage.goto('http://localhost:5173');
    await receiverPage.goto('http://localhost:5173');

    await senderPage.click('#btn-create-session');
    await expect(senderPage.locator('#pairing-pin-display')).toBeVisible({ timeout: 30000 });
    const pin = await senderPage.locator('#pairing-pin-display').textContent();

    await receiverPage.fill('#input-pin', pin!.trim());
    await receiverPage.click('#btn-join-session');

    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
    await expect(receiverPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

    await senderPage.locator('#file-input').setInputFiles(file50MB);
    await senderPage.click('#btn-start-transfer');
    await expect(receiverPage.locator('#btn-accept-transfer')).toBeVisible({ timeout: 15000 });
    await receiverPage.click('#btn-accept-transfer');

    // Wait until progress starts
    await expect(async () => {
      const text = await senderPage.locator('#bytes-transferred-display').textContent();
      const num = parseFloat(text?.split(' ')[0] || '0');
      expect(num).toBeGreaterThan(2);
    }).toPass({ timeout: 20000 });

    console.log('Progress started. Abruptly closing receiver context...');
    await receiverCtx.close();

    // Verify sender handles disconnect cleanly
    await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_DISCONNECTED', { timeout: 15000 });
    console.log('Peer Disconnect Test Passed!');
    console.log('Peer Disconnect Test Passed!');

    saveResultToJson('disconnectTest', {
      testName: 'DISCONNECT_MID_FLIGHT',
      status: 'PASS'
    });

    await senderCtx.close();
  });
});
