window.MDE.registerFeature({
  id: "titles",
  init() {
    const COURSE_CODE_REGEX = /^[A-Z]{2,4}\s?\d{3}$/;

    /**
     * Converts all-caps course title to title case, ignoring small words
     * and stripping special characters
     * @param {string} s 
     * @returns {string} title-cased version of string s
     */
    function formatCourseTitle(raw) {
      const small = new Set(["and", "of", "to"]);
      let s = (raw || "").trim().replace(/^[^A-Za-z0-9]+/, "").replace(/\s+/g, " ");
      if (!s) return s;

      return s
        .toLowerCase()
        .split(" ")
        .map((w, i) => {
          if (/^[ivx]+$/.test(w)) return w.toUpperCase();   //roman numerals
          if (i !== 0 && small.has(w)) return w;            //small words
          return w.charAt(0).toUpperCase() + w.slice(1);    //capatalize first letter
        })
        .join(" ");
    }

    /**
     * Determines whether a DOM element (el) represents a course code in the myDegrees UI.
     * @param {Element} el 
     * @returns {boolean}
     */
    function isCourseCodeElement(el) {
      const aria = el.getAttribute("aria-label"); //"aria-label" is the attribute attached to course codes
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

      // Mark processed *for this course code* (not just "1")
      // This prevents stale titles when the DOM node gets reused for a different course.
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
     * Enables or disables extension styles and behavior
     * @param {boolean} enabled 
     */
    function setEnabled(enabled) {
      document.documentElement.classList.toggle("mde-enabled", Boolean(enabled));
    }

    // Initializes the enabled/disabled state of the extension on page load.
    async function initEnabledState() {
      const { mdeEnabled = true } = await chrome.storage.sync.get({ mdeEnabled: true });
      setEnabled(mdeEnabled);
    }

    // Start feature
    processPage();
    initEnabledState();

    // Keep applying when myDegrees updates
    const observer = new MutationObserver(() => processPage());
    observer.observe(document.body, { childList: true, subtree: true });
    
    // Allow popup to toggle without reloading the page
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "MDE_SET_ENABLED") setEnabled(msg.enabled);
    });
  }
});
