/**
 * Gets tab id of the active tab in the current window.
 * @returns {Promise<number|undefined>} The ID of the active tab, or undefined if no active tab is found.
 */

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}
/**
 * Sends a message to the active tab to enable or disable the content.js script. 
 * @param {*} enabled 
 */
async function sendEnabledToTab(enabled) {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: "MDE_SET_ENABLED", enabled });
}

/**
 * Event listener for DOMContentLoaded to initialize the popup UI and handle toggle changes.
 */
document.addEventListener("DOMContentLoaded", async () => {
  const toggle = document.getElementById("toggle");
  const prereqToggle = document.getElementById("toggle-prereqs");
  const notesToggle = document.getElementById("toggle-notes");
  // Load saved settings
  const { mdeEnabled = true, mdePrereqsEnabled = true } =
    await chrome.storage.sync.get({ mdeEnabled: true, mdePrereqsEnabled: true });

  // Set initial UI states
  toggle.checked = mdeEnabled;
  prereqToggle.checked = mdePrereqsEnabled;

  // Full name feature toggle
  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked;
    await chrome.storage.sync.set({ mdeEnabled: enabled });
    await sendEnabledToTab(enabled);
  });

  // Prereq feature toggle
  prereqToggle.addEventListener("change", async () => {
    const enabled = prereqToggle.checked;
    await chrome.storage.sync.set({ mdePrereqsEnabled: enabled });

    const tabId = await getActiveTabId();
    if (!tabId) return;

    chrome.tabs.sendMessage(tabId, { type: "MDE_SET_PREREQS_ENABLED", enabled });
  });
  
  //Visibile notes toggle
  const { mdeNotesEnabled = true } = await chrome.storage.sync.get({ mdeNotesEnabled: true });
  notesToggle.checked = mdeNotesEnabled;

  notesToggle.addEventListener("change", async () => {
    const enabled = notesToggle.checked;
    await chrome.storage.sync.set({ mdeNotesEnabled: enabled });

    const tabId = await getActiveTabId();
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: "MDE_SET_NOTES_ENABLED", enabled });
  });

});

