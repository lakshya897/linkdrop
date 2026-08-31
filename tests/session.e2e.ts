import { test, expect } from '@playwright/test';

test('Sender and Receiver pairing flow', async ({ browser }) => {
  // 1. Create two distinct browser contexts (simulating two different users)
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();

  const senderPage = await senderContext.newPage();
  const receiverPage = await receiverContext.newPage();

  // 2. Sender goes to homepage and creates session
  await senderPage.goto('http://localhost:5173');
  await expect(senderPage.locator('h1')).toHaveText('LINKDROP');
  
  await senderPage.click('#btn-create-session');
  
  // Wait for the status to show CREATED/WAITING_FOR_PEER
  await expect(senderPage.locator('#session-status-text')).toContainText(/CREATED|WAITING_FOR_PEER/);

  // Retrieve PIN
  const pinText = await senderPage.locator('#pairing-pin-display').textContent();
  expect(pinText).toHaveLength(6);
  expect(/^\d{6}$/.test(pinText!)).toBe(true);

  // 3. Receiver goes to homepage, inputs PIN, and joins session
  await receiverPage.goto('http://localhost:5173');
  await receiverPage.fill('#input-pin', pinText!);
  await receiverPage.click('#btn-join-session');

  // 4. Verify successful pairing
  await expect(senderPage.locator('#peer-connected-indicator')).toContainText('Peer connected');
  await expect(receiverPage.locator('#peer-connected-indicator')).toContainText('Peer connected');

  await expect(senderPage.locator('#session-status-text')).toHaveText('PAIRED');
  await expect(receiverPage.locator('#session-status-text')).toHaveText('PAIRED');

  // 5. Close receiver page
  await receiverPage.close();

  // 6. Verify sender page detects disconnect
  await expect(senderPage.locator('#session-status-text')).toHaveText('WAITING_FOR_PEER');

  // Clean up
  await senderContext.close();
  await receiverContext.close();
});
