/**
 * Feature: Prerequisite warnings
 * - Fetches your class history (via /users/myself + /audit)
 * - Fetches prereqs for scheduled courses (via /course-link/term)
 * - Adds a "!" badge to any course card whose prereqs are missing/out of order
 * - Can be toggled on/off from the popup, and the saved toggle state is applied on page load
 */
window.MDE.registerFeature({
  id: "prereqs",

  // NOTE: init is async so we can read storage + fetch history/prereqs.
  async init() {
    /***********************
     * Config + Toggle State
     ***********************/

    // Matches things like "CS 352", "ECE 271", "CS 261H"
    const COURSE_CODE_REGEX = /^[A-Z]{2,4}\s?\d{3}[A-Za-z]?$/;

    // CSS class used by our badge element
    const BADGE_CLASS = "mde-prereq-badge";

    // Feature toggle controlled by the popup
    let prereqsEnabled = true;

    // Storage keys
    const HISTORY_KEY = "mdeHistoryCourses_v2";
    const HISTORY_META_KEY = "mdeHistoryMeta_v2"; // { studentId, savedAt }
    const PREREQ_KEY = "mdePrereqCache_v5";

    // Refresh class history at most once per 24 hours
    const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

    /**
     * Apply enable/disable immediately:
     * - When disabled: remove any existing badges
     * - When enabled: schedule a fresh run (tick)
     */
    function setPrereqsEnabled(enabled) {
      prereqsEnabled = Boolean(enabled);

      if (!prereqsEnabled) {
        // If user turns this off, clean up the UI right away.
        document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
        return;
      }

      // If user turns this on, compute warnings again.
      scheduleTick();
    }

    /**
     * On page load, read the saved toggle state from sync storage and apply it.
     * This is the equivalent of "initEnabledState()" in feature_titles.js.
     */
    async function initPrereqsEnabledState() {
      const { mdePrereqsEnabled = true } = await chrome.storage.sync.get({
        mdePrereqsEnabled: true,
      });
      setPrereqsEnabled(mdePrereqsEnabled);
    }

    /**
     * Receive updates from the popup without reloading the page.
     * Popup sends: { type: "MDE_SET_PREREQS_ENABLED", enabled: boolean }
     */
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "MDE_SET_PREREQS_ENABLED") {
        setPrereqsEnabled(msg.enabled);
      }
    });

    /***********************
     * Prereq grouping
     ***********************/

    /**
     * Convert the prereq objects returned by /course-link/term into "OR groups":
     * Example:
     *   (CS 261 OR CS 261H) AND (ECE 271 OR CS 271)
     * becomes:
     *   [ ["CS 261","CS 261H"], ["ECE 271","CS 271"] ]
     */
    function buildPrereqGroups(prereqObjs) {
      /** @type {string[][]} */
      const groups = [];
      /** @type {string[]} */
      let current = [];

      for (const p of prereqObjs || []) {
        const code = normalizeCourseCode(
          `${p.subjectCodePrerequisite} ${p.courseNumberPrerequisite}`
        );

        const startsGroup = (p.leftParenthesis || "").includes("(");
        const isAnd = p.connector === "A";

        // Start a new group when a "(" begins or an AND connector is used
        if ((startsGroup || isAnd) && current.length) {
          groups.push(current);
          current = [];
        }

        current.push(code);

        // Close group when ")" ends
        const endsGroup = (p.rightParenthesis || "").includes(")");
        if (endsGroup && current.length) {
          groups.push(current);
          current = [];
        }
      }

      // If something didn't end with ")", still keep it as a group
      if (current.length) groups.push(current);

      // De-dupe within groups
      return groups.map((g) => Array.from(new Set(g)));
    }

    /***********************
     * Small utilities
     ***********************/

    function normalizeCourseCode(raw) {
      const s = (raw || "").trim().replace(/\s+/g, " ");
      const m = s.match(/^([A-Z]{2,4})\s?(\d{3}[A-Za-z]?)$/);
      return m ? `${m[1]} ${m[2].toUpperCase()}` : s;
    }

    function splitCourseCode(code) {
      const m = normalizeCourseCode(code).match(/^([A-Z]{2,4})\s(\d{3}[A-Za-z]?)$/);
      return m ? { discipline: m[1], number: m[2] } : null;
    }

    function ensureCardAnchor(cardEl) {
      // Badge is positioned absolutely, so the card must be a positioned container.
      if (getComputedStyle(cardEl).position === "static") cardEl.style.position = "relative";
    }

    function setBadge(cardEl, tooltip) {
      ensureCardAnchor(cardEl);

      let badge = cardEl.querySelector(`.${BADGE_CLASS}`);
      if (!badge) {
        badge = document.createElement("div");
        badge.className = BADGE_CLASS;
        badge.textContent = "!";
        cardEl.appendChild(badge);
      }

      // Tooltip text is stored as an attribute and rendered via CSS ::after
      badge.setAttribute("data-tooltip", tooltip);
    }

    function clearBadge(cardEl) {
      const badge = cardEl.querySelector(`.${BADGE_CLASS}`);
      if (badge) badge.remove();
    }

    function nowMs() {
      return Date.now();
    }

    /***********************
     * Term mapping (confirmed by you)
     * Summer 2025 => 202600
     * Fall 2025   => 202601
     * Winter 2026 => 202602
     * Spring 2026 => 202603
     ***********************/
    function termLabelToCode(season, year) {
      const suffix = { Summer: "00", Fall: "01", Winter: "02", Spring: "03" }[season];
      if (!suffix) return null;

      const y = Number(year);
      const codeYear = season === "Summer" || season === "Fall" ? y + 1 : y;
      return `${codeYear}${suffix}`;
    }

    /***********************
     * Collect scheduled courses from planner
     ***********************/

    /**
     * Reads the planner columns and returns:
     * - items: list of scheduled course cards we can annotate
     * - courseToIndex: courseCode -> termIndex (to compare ordering)
     * - termIndexToLabel: termIndex -> "Fall 2025" (for tooltip)
     */
    function collectScheduled() {
      const termContainer = document.querySelector("#term-container");
      if (!termContainer) {
        return { items: [], courseToIndex: new Map(), termIndexToLabel: new Map() };
      }

      const columns = Array.from(termContainer.children);

      const items = [];
      const courseToIndex = new Map();
      const termIndexToLabel = new Map();

      for (let termIndex = 0; termIndex < columns.length; termIndex++) {
        const col = columns[termIndex];

        // Find a season/year label somewhere in the column.
        const termEl = Array.from(col.querySelectorAll("h1,h2,h3,h4,p,span,div")).find((el) =>
          /\b(20\d{2})\s+(Fall|Winter|Spring|Summer)\b|\b(Fall|Winter|Spring|Summer)\s+(20\d{2})\b/.test(
            (el.textContent || "").trim()
          )
        );

        if (!termEl) continue;

        const txt = (termEl.textContent || "").trim();
        let m = txt.match(/\b(20\d{2})\s+(Fall|Winter|Spring|Summer)\b/);
        if (!m) m = txt.match(/\b(Fall|Winter|Spring|Summer)\s+(20\d{2})\b/);
        if (!m) continue;

        let year, season;
        if (/^\d{4}$/.test(m[1])) {
          year = m[1];
          season = m[2];
        } else {
          season = m[1];
          year = m[2];
        }

        const termLabel = `${season} ${year}`;
        const termCode = termLabelToCode(season, year);
        if (!termCode) continue;

        termIndexToLabel.set(termIndex, termLabel);

        // Course code elements (UI uses p[aria-label] where textContent is "CS 372")
        const courseEls = Array.from(col.querySelectorAll('p[aria-label]')).filter((el) =>
          COURSE_CODE_REGEX.test((el.textContent || "").trim())
        );

        for (const el of courseEls) {
          const courseCode = normalizeCourseCode(el.textContent);
          const cardEl = el.closest('div[draggable="true"]');
          if (!cardEl) continue;

          items.push({ courseCode, termIndex, termCode, cardEl });
          courseToIndex.set(courseCode, termIndex);
        }
      }

      return { items, courseToIndex, termIndexToLabel };
    }

    /***********************
     * MyDegrees API: user + audit -> class history set
     ***********************/

    async function fetchMyStudentId() {
      const res = await fetch("/dashboard/api/users/myself", { credentials: "include" });
      if (!res.ok) throw new Error(`users/myself failed: ${res.status}`);
      const data = await res.json();
      return String(data?.id || "").trim() || null;
    }

    function buildAuditUrl(studentId) {
      const u = new URL("/dashboard/api/audit", location.origin);
      u.searchParams.set("studentId", studentId);
      u.searchParams.set("school", "01");
      u.searchParams.set("degree", "BS");
      u.searchParams.set("is-process-new", "true");
      u.searchParams.set("audit-type", "NV");
      u.searchParams.set("auditId", "");
      u.searchParams.set("include-inprogress", "true");
      u.searchParams.set("include-preregistered", "true");
      u.searchParams.set("aid-term", "undefined");
      return u.toString();
    }

    async function fetchAuditJson(studentId) {
      const url = buildAuditUrl(studentId);
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`audit failed: ${res.status}`);
      return res.json();
    }

    /**
     * Walk the full audit JSON and extract the courses the student has taken/is taking.
     * We collect any object that looks like a course record:
     * { discipline:"CS", number:"352", recordType:"C", inProgress:"N", ... }
     */
    function extractHistoryFromAudit(auditData) {
      const codes = new Set();

      function walk(v) {
        if (!v) return;
        if (Array.isArray(v)) return v.forEach(walk);
        if (typeof v !== "object") return;

        const d = v.discipline;
        const n = v.number;

        if (typeof d === "string" && typeof n === "string") {
          const code = normalizeCourseCode(`${d} ${n}`);
          const looksLikeCourse = /^[A-Z]{2,4}\s\d{3}[A-Z]?$/i.test(code);

          const isCourseRecord =
            v.recordType === "C" ||
            typeof v.letterGrade === "string" ||
            v.inProgress === "Y" ||
            v.preregistered === "Y";

          if (looksLikeCourse && isCourseRecord) {
            codes.add(code.toUpperCase());
          }
        }

        for (const k in v) walk(v[k]);
      }

      walk(auditData);

      return new Set(Array.from(codes).map(normalizeCourseCode));
    }

    async function loadHistoryCache() {
      const { [HISTORY_KEY]: savedList, [HISTORY_META_KEY]: meta } = await chrome.storage.local.get([
        HISTORY_KEY,
        HISTORY_META_KEY,
      ]);

      const listOk = Array.isArray(savedList) && savedList.length > 0;
      const metaOk =
        meta &&
        typeof meta === "object" &&
        typeof meta.studentId === "string" &&
        typeof meta.savedAt === "number";

      return {
        set: listOk ? new Set(savedList) : new Set(),
        meta: metaOk ? meta : null,
      };
    }

    async function saveHistoryCache(studentId, set) {
      await chrome.storage.local.set({
        [HISTORY_KEY]: Array.from(set),
        [HISTORY_META_KEY]: { studentId, savedAt: nowMs() },
      });
    }

    /***********************
     * Prereq API (batch per term)
     ***********************/

    // courseCode -> string[][] (prereq OR-groups)
    let prereqCache = new Map();

    /**
     * Load prereq cache from local storage.
     * This also supports older formats (flat arrays) by converting them into singleton groups.
     */
    async function loadPrereqCache() {
      const saved = (await chrome.storage.local.get(PREREQ_KEY))[PREREQ_KEY];
      if (!saved || typeof saved !== "object") return;

      const m = new Map();

      for (const [course, value] of Object.entries(saved)) {
        // New format: string[][]
        if (Array.isArray(value) && Array.isArray(value[0])) {
          m.set(course, value);
          continue;
        }

        // Old format: string[] -> convert to singleton groups
        if (Array.isArray(value) && typeof value[0] === "string") {
          m.set(course, value.map((code) => [code]));
          continue;
        }
      }

      prereqCache = m;
    }

    async function savePrereqCache() {
      await chrome.storage.local.set({
        [PREREQ_KEY]: Object.fromEntries(prereqCache.entries()),
      });
    }

    async function fetchCourseInfoForTerm(termCode, courses) {
      const res = await fetch("/dashboard/api/course-link/term", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ term: termCode, courses }),
      });

      if (!res.ok) throw new Error(`course-link/term failed: ${res.status}`);

      const data = await res.json();
      const courseObjs = data?.courseInformation?.courses || [];

      for (const obj of courseObjs) {
        const code = normalizeCourseCode(`${obj.subjectCode} ${obj.courseNumber}`);
        const groups = buildPrereqGroups(obj.prerequisites);
        prereqCache.set(code, groups);
      }
    }

    /***********************
     * Main logic
     ***********************/

    let historySet = new Set();
    let running = false;
    let timer = null;
    let initialized = false;

    /**
     * Ensure historySet is populated, using cache if it's fresh enough.
     */
    async function ensureHistorySet() {
      const cached = await loadHistoryCache();

      if (cached.meta && cached.set.size > 0) {
        const age = nowMs() - cached.meta.savedAt;
        if (age < HISTORY_TTL_MS) {
          historySet = cached.set;
          return;
        }
      }

      const studentId = await fetchMyStudentId();
      if (!studentId) return;

      const audit = await fetchAuditJson(studentId);
      const set = extractHistoryFromAudit(audit);

      historySet = set;
      await saveHistoryCache(studentId, set);
    }

    /**
     * Fetch prereqs for any scheduled courses that aren't in prereqCache yet.
     * We batch requests by termCode.
     */
    async function ensurePrereqsForScheduled(items) {
      const termToParts = new Map();

      for (const it of items) {
        if (prereqCache.has(it.courseCode)) continue;
        const parts = splitCourseCode(it.courseCode);
        if (!parts) continue;

        if (!termToParts.has(it.termCode)) termToParts.set(it.termCode, []);
        termToParts.get(it.termCode).push(parts);
      }

      for (const [termCode, list] of termToParts.entries()) {
        const seen = new Set();
        const unique = [];

        for (const c of list) {
          const k = `${c.discipline} ${c.number}`;
          if (!seen.has(k)) {
            seen.add(k);
            unique.push(c);
          }
        }

        await fetchCourseInfoForTerm(termCode, unique);
      }

      if (termToParts.size) await savePrereqCache();
    }

    /**
     * Decide which course cards should show a warning badge.
     * Tooltip format: "Missing Prerequisite: X, Y, Z"
     */
    function applyWarnings(items, courseToIndex, termIndexToLabel) {
      for (const it of items) {
        const groups = prereqCache.get(it.courseCode) || [];

        const missingGroups = [];
        const laterMentions = [];

        // Evaluate each OR-group: group satisfied if ANY option is satisfied
        for (const group of groups) {
          let groupSatisfied = false;

          for (const option of group) {
            const optIdx = courseToIndex.get(option);

            // If prereq is scheduled later, it's not satisfied for this course.
            if (optIdx != null && optIdx > it.termIndex) {
              laterMentions.push({
                code: option,
                term: termIndexToLabel.get(optIdx) || `Term ${optIdx + 1}`,
              });
              continue;
            }

            const satisfied = historySet.has(option) || (optIdx != null && optIdx < it.termIndex);

            if (satisfied) {
              groupSatisfied = true;
              break;
            }
          }

          if (!groupSatisfied) missingGroups.push(group);
        }

        // No issues -> remove badge
        if (missingGroups.length === 0 && laterMentions.length === 0) {
          clearBadge(it.cardEl);
          continue;
        }

        // Build "Missing Prerequisite: X, Y, Z"
        const missingSet = new Set();

        for (const group of missingGroups) {
          for (const code of group) missingSet.add(code);
        }

        for (const x of laterMentions) {
          missingSet.add(x.code);
        }

        if (missingSet.size === 0) {
          clearBadge(it.cardEl);
          continue;
        }

        const tooltipText = "Missing Prerequisite: " + Array.from(missingSet).join(", ");
        setBadge(it.cardEl, tooltipText);
      }
    }

    /**
     * One full pass:
     * - make sure history is available (cached or fetched)
     * - collect scheduled courses
     * - fetch prereqs for those courses
     * - apply badges
     */
    async function tick() {
      // "Guarding tick": if feature is disabled, do nothing.
      if (!prereqsEnabled) return;

      if (running) return;
      running = true;

      try {
        if (!initialized) {
          initialized = true;
          await loadPrereqCache();
          await ensureHistorySet();
        }

        const { items, courseToIndex, termIndexToLabel } = collectScheduled();
        if (items.length === 0) return;

        await ensurePrereqsForScheduled(items);
        applyWarnings(items, courseToIndex, termIndexToLabel);
      } catch (e) {
        // If something breaks, we fail quietly so the site still works.
        // For debugging, uncomment:
        // console.log("[MDE prereqs] error", e);
      } finally {
        running = false;
      }
    }

    /**
     * Debounce repeated DOM changes (MyDegrees updates the page constantly).
     * We schedule tick a little later so we don't spam API calls.
     */
    function scheduleTick() {
      // Optional: don't even schedule work when disabled
      if (!prereqsEnabled) return;

      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 250);
    }

  /**
    * Start feature
    */

    // IMPORTANT: apply saved toggle state on page load
    await initPrereqsEnabledState();

    // Do an initial pass (only runs if enabled)
    tick();

    // Re-run when the planner DOM changes
    const obs = new MutationObserver(scheduleTick);
    obs.observe(document.body, { childList: true, subtree: true });
  },
});
