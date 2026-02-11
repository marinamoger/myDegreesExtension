window.MDE.registerFeature({
  id: "notes",

  async init() {
    /***********************
     * Config
     ***********************/
    const NOTES_ENABLED_KEY = "mdeNotesEnabled";
    const NOTES_CACHE_KEY = "mdeNotesCache_v1"; // local-only cache: { "CS 325": "this is a note" }
    const NOTE_CLASS = "mde-note-inline";
    const NOTE_BTN_SELECTOR = 'button[aria-label$=" Notes"]';

    let notesEnabled = true;

    /***********************
     * Enable/disable wiring (popup toggle)
     ***********************/
    function setNotesEnabled(enabled) {
      notesEnabled = Boolean(enabled);

      if (!notesEnabled) {
        // Hide immediately: remove any injected note boxes
        document.querySelectorAll(`.${NOTE_CLASS}`).forEach((n) => n.remove());
      } else {
        // Re-render notes from cache
        scheduleTick();
      }
    }

    async function initNotesEnabledState() {
      const { mdeNotesEnabled = true } = await chrome.storage.sync.get({
        mdeNotesEnabled: true,
      });
      setNotesEnabled(mdeNotesEnabled);
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "MDE_SET_NOTES_ENABLED") {
        setNotesEnabled(msg.enabled);
      }
    });

    /***********************
     * Cache helpers
     ***********************/
    /** @returns {Promise<Record<string,string>>} */
    async function loadNotesCache() {
      const obj = (await chrome.storage.local.get(NOTES_CACHE_KEY))[NOTES_CACHE_KEY];
      return obj && typeof obj === "object" ? obj : {};
    }

    /** @param {Record<string,string>} obj */
    async function saveNotesCache(obj) {
      await chrome.storage.local.set({ [NOTES_CACHE_KEY]: obj });
    }

    /**
     * Extract "CS 325" from aria-label="CS 325 Notes"
     * @param {string} aria
     * @returns {string|null}
     */
    function courseCodeFromNotesAria(aria) {
      const m = String(aria || "").match(/^([A-Z]{2,4}\s?\d{3}[A-Za-z]?)\s+Notes$/);
      if (!m) return null;
      // normalize to "CS 325"
      return m[1].replace(/\s+/g, " ").trim();
    }

    /**
     * Find the note dialog if it exists.
     * MUI uses: role="dialog"
     * @returns {Element|null}
     */
    function findOpenNoteDialog() {
      return document.querySelector('div[role="dialog"]');
    }

    /**
     * Pull note text from the open dialog.
     * Your screenshot shows the note displayed as a <p> that equals the note text.
     * We also try textarea/input in case the dialog is in edit mode.
     * @param {Element} dialogEl
     * @returns {string}
     */
    function readNoteTextFromDialog(dialogEl) {
    // 1. Prefer editable controls 
    const textarea = dialogEl.querySelector("textarea");
    if (textarea && typeof textarea.value === "string") {
        return textarea.value.trim();
    }

    const input = dialogEl.querySelector('input[type="text"], input:not([type])');
    if (input && typeof input.value === "string") {
        return input.value.trim();
    }

    // 2. Look for note text AFTER the divider
    const divider = dialogEl.querySelector(".MuiDivider-root");

    if (divider) {
        let el = divider.nextElementSibling;
        while (el) {
        if (el.tagName === "P") {
            const text = (el.textContent || "").trim();
            if (text) return text;
        }
        el = el.nextElementSibling;
        }
    }

    // 3. Final fallback (very conservative)
    const paragraphs = Array.from(dialogEl.querySelectorAll("p"));
    const last = paragraphs[paragraphs.length - 1];
    return last ? (last.textContent || "").trim() : "";
    }


    /**
     * Show inline note on a card (bottom-left area under divider).
     * We position it absolutely so we don't have to perfectly match their internal layout.
     * @param {Element} cardEl
     * @param {string} text
     */
    function upsertInlineNote(cardEl, text) {
      // Ensure positioning context
      if (getComputedStyle(cardEl).position === "static") cardEl.style.position = "relative";

      let box = cardEl.querySelector(`.${NOTE_CLASS}`);
      if (!text) {
        if (box) box.remove();
        return;
      }

      if (!box) {
        box = document.createElement("div");
        box.className = NOTE_CLASS;
        box.dataset.mdeInjected = "1";
        cardEl.appendChild(box);
      }

      box.textContent = text;
    }

    /**
     * Get all course cards on the planner (draggable=true in your HTML).
     * @returns {Element[]}
     */
    function getPlannerCards() {
      return Array.from(document.querySelectorAll('div[draggable="true"]'));
    }

    /**
     * For each card, if we have a cached note for its course code, show it.
     */
    async function renderNotesFromCache() {
      if (!notesEnabled) return;

      const cache = await loadNotesCache();

      for (const card of getPlannerCards()) {
        const btn = card.querySelector(NOTE_BTN_SELECTOR);
        if (!btn) continue;

        const code = courseCodeFromNotesAria(btn.getAttribute("aria-label") || "");
        if (!code) continue;

        const note = (cache[code] || "").trim();
        upsertInlineNote(card, note);
      }
    }

    /***********************
     * Capture notes whenever user opens/closes/edits the dialog
     ***********************/
    let lastClickedCourse = null;

    // Track which course's note dialog we opened by listening to clicks on note buttons
    document.addEventListener("click", (e) => {
      const btn = e.target?.closest?.(NOTE_BTN_SELECTOR);
      if (!btn) return;

      const code = courseCodeFromNotesAria(btn.getAttribute("aria-label") || "");
      if (code) lastClickedCourse = code;
    });

    /**
     * When a dialog is open, read its note text and store it for lastClickedCourse.
     * This is intentionally simple and runs on a debounce.
     */
    async function syncFromOpenDialogIfAny() {
      if (!notesEnabled) return;
      if (!lastClickedCourse) return;

      const dialog = findOpenNoteDialog();
      if (!dialog) return;

      const text = readNoteTextFromDialog(dialog);

      const cache = await loadNotesCache();

      if (text) {
        cache[lastClickedCourse] = text;
      } else {
        // If note is empty, remove it from cache
        delete cache[lastClickedCourse];
      }

      await saveNotesCache(cache);

      // Update cards immediately
      await renderNotesFromCache();
    }

    /***********************
     * Debounced tick wiring
     ***********************/
    let timer = null;

    function scheduleTick() {
      if (!notesEnabled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        await renderNotesFromCache();
        await syncFromOpenDialogIfAny();
      }, 250);
    }

    /***********************
     * Start
     ***********************/
    await initNotesEnabledState();
    await renderNotesFromCache();

    const obs = new MutationObserver(scheduleTick);
    obs.observe(document.body, { childList: true, subtree: true });
  },
});
