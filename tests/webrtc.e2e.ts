import { test, expect } from '@playwright/test';

test('WebRTC connection, Ping/Pong, and reconnect lifecycle', async ({ browser }) => {
  // Create two separate browser contexts
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();

  const senderPage = await senderContext.newPage();
  const receiverPage = await receiverContext.newPage();

  // --- CYCLE 1: Connect, Ping/Pong, Disconnect ---
  await senderPage.goto('http://localhost:5173');
  await senderPage.click('#btn-create-session');

  // Wait for PIN
  await expect(senderPage.locator('#pairing-pin-display')).toBeVisible();
  const pinText = await senderPage.locator('#pairing-pin-display').textContent();

  // Receiver joins
  await receiverPage.goto('http://localhost:5173');
  await receiverPage.fill('#input-pin', pinText!);
  await receiverPage.click('#btn-join-session');

  // Wait for WebRTC connection to succeed
  await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
  await expect(receiverPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

  // Control channel opens
  await expect(senderPage.locator('#datachannel-state-display')).toHaveText('open');
  await expect(receiverPage.locator('#datachannel-state-display')).toHaveText('open');

  // Send Ping
  await senderPage.click('#btn-send-ping');

  // Check Pong received and RTT measured
  await expect(senderPage.locator('#pong-count')).toHaveText('1');
  const rttText = await senderPage.locator('#rtt-display').textContent();
  expect(rttText).toContain('ms');

  // Receiver disconnects (closes tab)
  await receiverPage.close();

  // Sender registers disconnection
  await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_DISCONNECTED', { timeout: 10000 });

  // Reset sender
  await senderPage.click('#btn-reset');
  await expect(senderPage.locator('#btn-create-session')).toBeVisible();

  // --- CYCLE 2: Second pairing to verify no stale connection objects ---
  const receiverPage2 = await receiverContext.newPage();

  // Sender creates new session
  await senderPage.click('#btn-create-session');
  await expect(senderPage.locator('#pairing-pin-display')).toBeVisible();
  const pinText2 = await senderPage.locator('#pairing-pin-display').textContent();

  // Receiver 2 joins
  await receiverPage2.goto('http://localhost:5173');
  await receiverPage2.fill('#input-pin', pinText2!);
  await receiverPage2.click('#btn-join-session');

  // WebRTC pairs successfully again
  await expect(senderPage.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });
  await expect(receiverPage2.locator('#webrtc-state-display')).toHaveText('WEBRTC_CONNECTED', { timeout: 15000 });

  await expect(senderPage.locator('#datachannel-state-display')).toHaveText('open');
  await expect(receiverPage2.locator('#datachannel-state-display')).toHaveText('open');

  // Second ping/pong
  await senderPage.click('#btn-send-ping');
  await expect(senderPage.locator('#pong-count')).toHaveText('1');

  // Clean up
  await receiverPage2.close();
  await senderContext.close();
  await receiverContext.close();
});
