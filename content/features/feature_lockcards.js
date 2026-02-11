/**
 * Feature: lockcards
 * Adds a lock icon on planner course cards. When locked, a card cannot be dragged
 * (draggable="false") until unlocked.
 */
window.MDE.registerFeature({
  id: "lockcards",

  async init() {
    /***********************
     * Toggle state (popup)
     ***********************/
    const ICON_LOCKED = chrome.runtime.getURL("assets/lock.png");
    const ICON_UNLOCKED = chrome.runtime.getURL("assets/unlock.png");

    let lockEnabled = true;

    /**
     * Debounce re-processing when the DOM changes.
     * Defined early because setLockEnabled() can call schedule().
     */
    let timer = null;

    function schedule() {
      if (!lockEnabled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => processPage(), 200);
    }

    /**
     * Apply enable/disable immediately:
     * - disabled: remove injected buttons + restore dragging
     * - enabled: schedule a pass
     * @param {boolean} enabled
     */
    function setLockEnabled(enabled) {
      lockEnabled = Boolean(enabled);

      if (!lockEnabled) {
        // Remove injected buttons and restore dragging
        document.querySelectorAll(".mde-lock-btn").forEach((btn) => btn.remove());

        document
          .querySelectorAll("#term-container div.MuiCard-root[draggable]")
          .forEach((card) => {
            card.setAttribute("draggable", "true");
            card.classList.remove("mde-card-locked");
          });

        return;
      }

      schedule();
    }

    /**
     * Initialize toggle state on page load from sync storage.
     */
    async function initLockEnabledState() {
      const { mdeLockCardsEnabled = true } = await chrome.storage.sync.get({
        mdeLockCardsEnabled: true,
      });
      setLockEnabled(mdeLockCardsEnabled);
    }

    /**
     * Live updates from popup without reload.
     */
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "MDE_SET_LOCKCARDS_ENABLED") {
        setLockEnabled(msg.enabled);
      }
    });

    await initLockEnabledState();

    /***********************
     * Storage + DOM helpers
     ***********************/
    const LOCK_MAP_KEY = "mdeLockedCards_v1"; // chrome.storage.local
    const BTN_CLASS = "mde-lock-btn";
    const LOCKED_CLASS = "mde-card-locked";

    /**
     * Load lock map: { [cardId: string]: true }
     * @returns {Promise<Record<string, boolean>>}
     */
    async function loadLockMap() {
      const obj = (await chrome.storage.local.get(LOCK_MAP_KEY))[LOCK_MAP_KEY];
      return obj && typeof obj === "object" ? obj : {};
    }

    /**
     * Save lock map
     * @param {Record<string, boolean>} obj
     */
    async function saveLockMap(obj) {
      await chrome.storage.local.set({ [LOCK_MAP_KEY]: obj });
    }

    /**
     * Each card has a stable id embedded in the "More options..." button.
     * Example: aria-controls="action-menu-plan-requirement-CL-4bfff70e..."
     * We'll use the "CL-..." part as the unique key.
     * @param {Element} cardEl
     * @returns {string|null}
     */
    function getCardId(cardEl) {
      const btn = cardEl.querySelector('button[aria-controls^="action-menu-plan-requirement-"]');
      const controls = btn?.getAttribute("aria-controls") || "";
      const m = controls.match(/\b(CL-[A-Za-z0-9]+)\b/);
      return m ? m[1] : null;
    }

    /**
     * Apply lock state to a card by toggling draggable.
     * @param {Element} cardEl
     * @param {boolean} locked
     */
    function applyLockedState(cardEl, locked) {
      cardEl.setAttribute("draggable", locked ? "false" : "true");
      cardEl.classList.toggle(LOCKED_CLASS, locked);
    }

    /**
     * Update lock icon visual (PNG).
     * @param {Element} btn
     * @param {boolean} locked
     */
    function setButtonVisual(btn, locked) {
      let img = btn.querySelector("img");

      if (!img) {
        img = document.createElement("img");
        img.alt = "";
        img.className = "mde-lock-icon";
        btn.textContent = "";
        btn.appendChild(img);
      }

      img.src = locked ? ICON_LOCKED : ICON_UNLOCKED;
      btn.setAttribute("data-locked", locked ? "1" : "0");
    }

    /**
     * Create or update the lock button on the card.
     * @param {Element} cardEl
     * @param {string} cardId
     * @param {boolean} locked
     */
    function upsertLockButton(cardEl, cardId, locked) {
      let btn = cardEl.querySelector(`.${BTN_CLASS}`);

      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = BTN_CLASS;
        btn.dataset.mdeInjected = "1";
        btn.dataset.mdeCardId = cardId;
        btn.setAttribute("aria-label", "Lock/unlock this course card");

        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();

          const id = btn.dataset.mdeCardId;
          if (!id) return;

          const map = await loadLockMap();
          const nextLocked = !Boolean(map[id]);

          if (nextLocked) map[id] = true;
          else delete map[id];

          await saveLockMap(map);

          // Update UI immediately
          setButtonVisual(btn, nextLocked);
          applyLockedState(cardEl, nextLocked);
        });

        cardEl.appendChild(btn);
      }

      // Keep button state in sync
      btn.dataset.mdeCardId = cardId;
      setButtonVisual(btn, locked);
    }

    /**
     * Process all planner course cards:
     * - inject lock button
     * - enforce draggable based on stored lock state
     */
    async function processPage() {
      if (!lockEnabled) return;

      const map = await loadLockMap();

      // Narrow scope: only cards in planner columns
      const termContainer = document.querySelector("#term-container");
      if (!termContainer) return;

      const cards = Array.from(termContainer.querySelectorAll('div.MuiCard-root[draggable]'));

      for (const cardEl of cards) {
        // Extra narrowing: must have action-menu button (real course card)
        const cardId = getCardId(cardEl);
        if (!cardId) continue;

        const locked = Boolean(map[cardId]);
        upsertLockButton(cardEl, cardId, locked);
        applyLockedState(cardEl, locked);
      }
    }

    /***********************
     * Start
     ***********************/

    await processPage();

    // Warmup: MyDegrees renders asynchronously; retry briefly
    let tries = 0;
    const maxTries = 10; // ~2 seconds total
    const intervalMs = 200;

    const warmup = setInterval(async () => {
      tries++;
      await processPage();

      if (document.querySelectorAll(".mde-lock-btn").length > 0 || tries >= maxTries) {
        clearInterval(warmup);
      }
    }, intervalMs);

    const obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true });
  },
});
