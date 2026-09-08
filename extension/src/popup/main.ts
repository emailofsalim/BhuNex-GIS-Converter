/**
 * Toolbar popup — a launcher only.
 *
 * The conversion workspace needs room for a queue, an inspector, a preview and a
 * settings panel; a toolbar popup has none of it, so the popup opens the full
 * page instead of trying to be it (instruction §11.1).
 */

import { checkNativeHealth, NATIVE_STATUS_LABEL } from '../adapters/native-messaging/client';

// From the manifest, not written out here: the root manifest and the one in
// dist/ point at this page from different depths, and only the browser knows
// which one it loaded. See the note in background/service-worker.ts.
const WORKSPACE_PATH = chrome.runtime.getManifest().options_page ?? 'src/workspace/index.html';

document.getElementById('openWorkspace')?.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL(WORKSPACE_PATH) });
  window.close();
});

document.getElementById('openSidePanel')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  }
});

void (async () => {
  const badge = document.getElementById('nativeBadge');
  if (!badge) return;
  const health = await checkNativeHealth();
  badge.textContent = NATIVE_STATUS_LABEL[health.status];
  badge.className = `badge badge--${health.status === 'READY' ? 'ok' : health.status === 'NOT_INSTALLED' ? 'muted' : 'warn'}`;
  badge.title = health.message;
})();
