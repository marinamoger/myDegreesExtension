/**
 * Gets the tab ID of the active tab in the current window.
 * @returns {Promise<number|undefined>} Active tab ID, or undefined if not found.
 */
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/**
 * Sends a message to the active tab (if one exists).
 * @param {string} type Message type (e.g., "MDE_SET_ENABLED")
 * @param {boolean} enabled Toggle value to send
 */
async function sendToActiveTab(type, enabled) {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type, enabled });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Grab UI elements
  const toggleTitles = document.getElementById("toggle");
  const togglePrereqs = document.getElementById("toggle-prereqs");
  const toggleNotes = document.getElementById("toggle-notes");
  const toggleLocks = document.getElementById("toggle-lockcards");

  // Load saved settings (defaults = ON)
  const {
    mdeEnabled = true,
    mdePrereqsEnabled = true,
    mdeNotesEnabled = true,
    mdeLockCardsEnabled = true,
  } = await chrome.storage.sync.get({
    mdeEnabled: true,
    mdePrereqsEnabled: true,
    mdeNotesEnabled: true,
    mdeLockCardsEnabled: true,
  });

  // Initialize checkbox states
  toggleTitles.checked = mdeEnabled;
  togglePrereqs.checked = mdePrereqsEnabled;
  toggleNotes.checked = mdeNotesEnabled;
  toggleLocks.checked = mdeLockCardsEnabled;

  // Full course titles toggle
  toggleTitles.addEventListener("change", async () => {
    const enabled = toggleTitles.checked;
    await chrome.storage.sync.set({ mdeEnabled: enabled });
    await sendToActiveTab("MDE_SET_ENABLED", enabled);
  });

  // Prerequisite warnings toggle
  togglePrereqs.addEventListener("change", async () => {
    const enabled = togglePrereqs.checked;
    await chrome.storage.sync.set({ mdePrereqsEnabled: enabled });
    await sendToActiveTab("MDE_SET_PREREQS_ENABLED", enabled);
  });

  // Notes visibility toggle
  toggleNotes.addEventListener("change", async () => {
    const enabled = toggleNotes.checked;
    await chrome.storage.sync.set({ mdeNotesEnabled: enabled });
    await sendToActiveTab("MDE_SET_NOTES_ENABLED", enabled);
  });

  // Lock cards toggle
  toggleLocks.addEventListener("change", async () => {
    const enabled = toggleLocks.checked;
    await chrome.storage.sync.set({ mdeLockCardsEnabled: enabled });
    await sendToActiveTab("MDE_SET_LOCKCARDS_ENABLED", enabled);
  });
});
