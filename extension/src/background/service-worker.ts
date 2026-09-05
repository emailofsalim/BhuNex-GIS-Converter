/**
 * MV3 service worker.
 *
 * Deliberately thin: conversions run in the workspace and its worker, where the
 * memory and the DOM APIs are. A service worker is terminated aggressively when
 * idle, so putting a long conversion here would mean losing it halfway.
 *
 * Its jobs are: open the workspace, keep the side panel wired to the toolbar,
 * and show the first-run page after install.
 */

const WORKSPACE_PATH = 'src/workspace/index.html';

chrome.runtime.onInstalled.addListener(async (details) => {
  // The side panel opens from the toolbar icon without a separate click target.
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {
    // Older Chrome builds without the sidePanel behaviour API: the popup's
    // explicit "Open side panel" button still works.
  }

  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL(WORKSPACE_PATH) });
  }
});

/**
 * Opens the workspace on the keyboard command, reusing an existing tab rather
 * than stacking duplicates — a converter with a loaded queue should be returned
 * to, not replaced.
 */
chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'open-workspace') return;
  const url = chrome.runtime.getURL(WORKSPACE_PATH);
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0 && existing[0].id !== undefined) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId !== undefined) await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
});

/** The workspace asks for the extension id so Settings can show it verbatim. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'get-extension-id') {
    sendResponse({ id: chrome.runtime.id, workspaceUrl: chrome.runtime.getURL(WORKSPACE_PATH) });
    return true;
  }
  return false;
});
