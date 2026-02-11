/**
 * Feature: titles
 * Adds a permanent, title-cased course name under each course code.
 */
window.MDE.registerFeature({
  id: "titles",

  init() {
    // Matches course codes like "CS 321", "MTH 251", "ECE 271"
    const COURSE_CODE_REGEX = /^[A-Z]{2,4}\s?\d{3}$/;

    /**
     * Converts all-caps course title to title case:
     * - keeps small words lowercase (except at start)
     * - preserves Roman numerals (I, II, III, IV...)
     * - strips leading special characters
     * @param {string} raw
     * @returns {string}
     */
    function formatCourseTitle(raw) {
      const small = new Set(["and", "of", "to"]);

      const s = (raw || "")
        .trim()
        .replace(/^[^A-Za-z0-9]+/, "")
        .replace(/\s+/g, " ");

      if (!s) return s;

      return s
        .toLowerCase()
        .split(" ")
        .map((w, i) => {
          // Roman numerals
          if (/^[ivx]+$/.test(w)) return w.toUpperCase();

          // Keep small words lowercase unless first word
          if (i !== 0 && small.has(w)) return w;

          // Capitalize first letter
          return w.charAt(0).toUpperCase() + w.slice(1);
        })
        .join(" ");
    }

    /**
     * True if this element looks like a course code in MyDegrees:
     * - has an aria-label (used by the site for course title)
     * - textContent matches a course code
     * @param {Element} el
     * @returns {boolean}
     */
    function isCourseCodeElement(el) {
      const aria = el.getAttribute("aria-label");
      if (!aria) return false;

      const text = (el.textContent || "").trim();
      return COURSE_CODE_REGEX.test(text);
    }

    /**
     * Adds a second line under the course code showing the course title.
     * Keeps the title synced even if the DOM node is reused (drag/move/delete).
     * @param {Element} el
     */
    function addCourseTitleLine(el) {
      const aria = el.getAttribute("aria-label");
      if (!aria) return;

      const title = formatCourseTitle(aria.trim());
      if (!title) return;

      // Track which course code this element currently represents
      const courseCode = (el.textContent || "").trim();

      // If we already processed this exact course code, do nothing
      if (el.dataset.mdeProcessed === courseCode) return;

      // If a title line already exists right after this element, update it
      let line = el.nextElementSibling;
      if (line && line.dataset && line.dataset.mdeInjected === "1") {
        line.textContent = title;
      } else {
        // Otherwise create it
        line = document.createElement("div");
        line.textContent = title;
        line.dataset.mdeInjected = "1";
        line.classList.add("mde-course-title");
        el.insertAdjacentElement("afterend", line);
      }

      // Mark processed for this course code (prevents stale titles on reused nodes)
      el.dataset.mdeProcessed = courseCode;
    }

    /**
     * Scans the page for candidate elements and enhances them.
     */
    function processPage() {
      const candidates = document.querySelectorAll("[aria-label]");
      for (const el of candidates) {
        if (isCourseCodeElement(el)) addCourseTitleLine(el);
      }
    }

    /**
     * Enables/disables injected title lines via the root HTML class.
     * @param {boolean} enabled
     */
    function setEnabled(enabled) {
      document.documentElement.classList.toggle("mde-enabled", Boolean(enabled));
    }

    /**
     * Initializes the saved enabled/disabled state on page load.
     */
    async function initEnabledState() {
      const { mdeEnabled = true } = await chrome.storage.sync.get({ mdeEnabled: true });
      setEnabled(mdeEnabled);
    }

    // Start feature
    processPage();
    initEnabledState();

    // Re-run when MyDegrees re-renders content
    const observer = new MutationObserver(() => processPage());
    observer.observe(document.body, { childList: true, subtree: true });

    // Allow popup to toggle without reload
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "MDE_SET_ENABLED") setEnabled(msg.enabled);
    });
  },
});
