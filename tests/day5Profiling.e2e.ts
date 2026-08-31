import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BENCHMARK_JSON_PATH = path.resolve('docs/reports/day5-benchmark-results.json');

export interface BenchmarkMetrics {
  mode: string;
  totalBytes: number;
  durationMs: number;
  avgMBps: number;
  peakMBps: number;
  currentMBps: number;
  rttMs: number | null;
  bufferedAmount: number;
  maxBufferedAmount: number;
  chunksSent: number;
  chunksReceived: number;
  duplicateChunks: number;
  missingChunks: number;
  candidatePair: string;
  connectionState: string;
  iceConnectionState: string;
  networkReceiveTimeMs?: number;
  storageWriteTimeMs?: number;
  totalStorageTimeMs?: number;
  sha256MainThreadMs?: number;
  sha256ThroughputMBps?: number;
  yieldCount?: number;
  maxEventLoopDelayMs?: number;
  longTaskCount?: number;
  maxLongTaskDurationMs?: number;
  highWatermarkCount?: number;
  lowWatermarkCount?: number;
  totalPauseDurationMs?: number;
  fileOverheadRatio?: number;
}

function updateSummaryJson(key: string, data: unknown) {
  let current: Record<string, unknown> = {};
  if (fs.existsSync(BENCHMARK_JSON_PATH)) {
    try {
      current = JSON.parse(fs.readFileSync(BENCHMARK_JSON_PATH, 'utf-8'));
    } catch {
      current = {};
    }
  }
  current[key] = data;
  const dir = path.dirname(BENCHMARK_JSON_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BENCHMARK_JSON_PATH, JSON.stringify(current, null, 2));
}

test.describe('Day 5 — WebRTC Throughput Profiling & Bottleneck Isolation', () => {

  test('Phase 1 & 2: Raw WebRTC vs File->WebRTC Benchmark', async ({ browser }) => {
    test.setTimeout(180000);

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    await senderPage.goto('http://localhost:5173/benchmark');
    await receiverPage.goto('http://localhost:5173/benchmark');

    await senderPage.click('#btn-create-benchmark-session');
    await expect(senderPage.locator('#benchmark-pin-display')).toBeVisible();
    const pin = await senderPage.locator('#benchmark-pin-display').textContent();

    await receiverPage.fill('#input-benchmark-pin', pin!.trim());
    await receiverPage.click('#btn-join-benchmark-session');

    await expect(senderPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });
    await expect(receiverPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });

    // --- PHASE 1: RAW WEBRTC BENCHMARK ---
    console.log('\n--- Phase 1: Running Raw WebRTC Benchmark (250 MB In-Memory) ---');
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
    const rawMetrics: BenchmarkMetrics = JSON.parse(rawText!);
    updateSummaryJson('rawWebRTC', rawMetrics);
    console.log(`Raw WebRTC Throughput: ${rawMetrics.avgMBps.toFixed(2)} MB/s (Peak: ${rawMetrics.peakMBps.toFixed(2)} MB/s, Duration: ${(rawMetrics.durationMs / 1000).toFixed(2)} s)`);

    // --- PHASE 2: FILE → WEBRTC BENCHMARK ---
    console.log('\n--- Phase 2: Running File → WebRTC Benchmark (250 MB Blob.slice) ---');
    await senderPage.click('#btn-file-webrtc');

    await expect.poll(async () => {
      const text = await senderPage.locator('#benchmark-results').textContent();
      if (!text) return '';
      try {
        const parsed = JSON.parse(text);
        return parsed.mode === 'FILE_WEBRTC' ? 'COMPLETED' : '';
      } catch {
        return '';
      }
    }, { timeout: 120000, intervals: [1000] }).toBe('COMPLETED');

    const fileText = await senderPage.locator('#benchmark-results').textContent();
    const fileMetrics: BenchmarkMetrics = JSON.parse(fileText!);
    fileMetrics.fileOverheadRatio = rawMetrics.avgMBps / fileMetrics.avgMBps;
    updateSummaryJson('fileWebRTC', fileMetrics);
    console.log(`File → WebRTC Throughput: ${fileMetrics.avgMBps.toFixed(2)} MB/s (File Overhead Ratio: ${fileMetrics.fileOverheadRatio.toFixed(2)}x)`);

    await senderCtx.close();
    await receiverCtx.close();
  });

  test('Phase 3: WebRTC → Storage Benchmark (IndexedDB Fallback)', async ({ browser }) => {
    test.setTimeout(240000); // 4 minutes timeout for IDB writes

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    // Disable FSA on receiver to force IndexedDB fallback
    await receiverPage.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    });

    await senderPage.goto('http://localhost:5173/benchmark');
    await receiverPage.goto('http://localhost:5173/benchmark');

    await senderPage.click('#btn-create-benchmark-session');
    await expect(senderPage.locator('#benchmark-pin-display')).toBeVisible();
    const pin = await senderPage.locator('#benchmark-pin-display').textContent();

    await receiverPage.fill('#input-benchmark-pin', pin!.trim());
    await receiverPage.click('#btn-join-benchmark-session');

    await expect(senderPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });
    await expect(receiverPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });

    console.log('\n--- Phase 3: Running WebRTC → Storage Benchmark (IndexedDB) ---');
    await senderPage.click('#btn-storage-webrtc');

    await expect.poll(async () => {
      const text = await receiverPage.locator('#benchmark-results').textContent();
      if (!text) return '';
      try {
        const parsed = JSON.parse(text);
        return parsed.mode === 'WEBRTC_STORAGE' ? 'COMPLETED' : '';
      } catch {
        return '';
      }
    }, { timeout: 180000, intervals: [1000] }).toBe('COMPLETED');

    const storageText = await receiverPage.locator('#benchmark-results').textContent();
    const storageMetrics: BenchmarkMetrics = JSON.parse(storageText!);
    updateSummaryJson('storageWebRTC', storageMetrics);
    console.log(`Storage Benchmark: Network Receive Time: ${((storageMetrics.networkReceiveTimeMs || 0) / 1000).toFixed(2)} s, Storage Write Time: ${((storageMetrics.storageWriteTimeMs || 0) / 1000).toFixed(2)} s, Total Storage Time: ${((storageMetrics.totalStorageTimeMs || 0) / 1000).toFixed(2)} s`);

    await senderCtx.close();
    await receiverCtx.close();
  });

  test('Phase 4: SHA-256 Hashing Benchmark', async ({ page }) => {
    test.setTimeout(60000);

    await page.goto('http://localhost:5173/benchmark');
    // SHA-256 Benchmark does not require WebRTC session
    await page.click('#btn-hash-bench');

    await expect.poll(async () => {
      const text = await page.locator('#benchmark-results').textContent();
      if (!text) return '';
      try {
        const parsed = JSON.parse(text);
        return parsed.mode === 'HASH_BENCHMARK' ? 'COMPLETED' : '';
      } catch {
        return '';
      }
    }, { timeout: 30000, intervals: [500] }).toBe('COMPLETED');

    const hashText = await page.locator('#benchmark-results').textContent();
    const hashMetrics: BenchmarkMetrics = JSON.parse(hashText!);
    updateSummaryJson('hashSHA256', hashMetrics);
    console.log(`SHA-256 Hashing Time: ${(hashMetrics.sha256MainThreadMs! / 1000).toFixed(2)} s (Throughput: ${hashMetrics.sha256ThroughputMBps?.toFixed(2)} MB/s)`);
  });

  test('Phase 5: Event Loop Yield Frequency Experiments', async ({ browser }) => {
    test.setTimeout(240000);

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const senderPage = await senderCtx.newPage();
    const receiverPage = await receiverCtx.newPage();

    await senderPage.goto('http://localhost:5173/benchmark');
    await receiverPage.goto('http://localhost:5173/benchmark');

    await senderPage.click('#btn-create-benchmark-session');
    await expect(senderPage.locator('#benchmark-pin-display')).toBeVisible();
    const pin = await senderPage.locator('#benchmark-pin-display').textContent();

    await receiverPage.fill('#input-benchmark-pin', pin!.trim());
    await receiverPage.click('#btn-join-benchmark-session');

    await expect(senderPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });
    await expect(receiverPage.locator('text=WEBRTC_CONNECTED')).toBeVisible({ timeout: 15000 });

    // Test yieldInterval = 0 (No Yield)
    console.log('\n--- Phase 5: Yield = 0 (No Yield) Experiment ---');
    await senderPage.evaluate(() => (window as unknown as { __setYieldInterval: (n: number) => void }).__setYieldInterval(0));
    await senderPage.click('#btn-raw-webrtc');

    await expect.poll(async () => {
      const text = await senderPage.locator('#benchmark-results').textContent();
      if (!text) return '';
      try {
        const parsed = JSON.parse(text);
        return parsed.yieldCount === 0 ? 'COMPLETED' : '';
      } catch {
        return '';
      }
    }, { timeout: 120000, intervals: [1000] }).toBe('COMPLETED');

    const noYieldText = await senderPage.locator('#benchmark-results').textContent();
    const noYieldMetrics: BenchmarkMetrics = JSON.parse(noYieldText!);
    updateSummaryJson('yieldExperiment_0', noYieldMetrics);
    console.log(`Yield = 0: Throughput ${noYieldMetrics.avgMBps.toFixed(2)} MB/s, Max Delay: ${noYieldMetrics.maxEventLoopDelayMs?.toFixed(1)} ms`);

    // Test yieldInterval = 512
    console.log('\n--- Phase 5: Yield = 512 Experiment ---');
    await senderPage.evaluate(() => (window as unknown as { __setYieldInterval: (n: number) => void }).__setYieldInterval(512));
    await senderPage.click('#btn-raw-webrtc');

    await expect.poll(async () => {
      const text = await senderPage.locator('#benchmark-results').textContent();
      if (!text) return '';
      try {
        const parsed = JSON.parse(text);
        return parsed.yieldCount! > 0 ? 'COMPLETED' : '';
      } catch {
        return '';
      }
    }, { timeout: 120000, intervals: [1000] }).toBe('COMPLETED');

    const yield512Text = await senderPage.locator('#benchmark-results').textContent();
    const yield512Metrics: BenchmarkMetrics = JSON.parse(yield512Text!);
    updateSummaryJson('yieldExperiment_512', yield512Metrics);
    console.log(`Yield = 512: Throughput ${yield512Metrics.avgMBps.toFixed(2)} MB/s, Max Delay: ${yield512Metrics.maxEventLoopDelayMs?.toFixed(1)} ms`);

    await senderCtx.close();
    await receiverCtx.close();
  });
});
