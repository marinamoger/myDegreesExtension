/**
 * Feature: Prerequisite warnings
 * - Fetches class history (via /users/myself + /audit)
 * - Fetches prereqs for scheduled courses (via /course-link/term)
 * - Adds a "!" badge to any course card whose prereqs are missing/out of order
 * - Toggle state is read on page load and updated live from the popup
 */
window.MDE.registerFeature({
  id: "prereqs",

  // init is async so we can read storage + fetch history/prereqs.
  async init() {
    /***********************
     * Config + Toggle State
     ***********************/

    const COURSE_CODE_REGEX = /^[A-Z]{2,4}\s?\d{3}[A-Za-z]?$/;
    const BADGE_CLASS = "mde-prereq-badge";

    let prereqsEnabled = true;

    const HISTORY_KEY = "mdeHistoryCourses_v2";
    const HISTORY_META_KEY = "mdeHistoryMeta_v2"; // { studentId, savedAt }
    const PREREQ_KEY = "mdePrereqCache_v5";

    const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

    function setPrereqsEnabled(enabled) {
      prereqsEnabled = Boolean(enabled);

      if (!prereqsEnabled) {
        document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
        return;
      }

      scheduleTick();
    }

    async function initPrereqsEnabledState() {
      const { mdePrereqsEnabled = true } = await chrome.storage.sync.get({
        mdePrereqsEnabled: true,
      });
      setPrereqsEnabled(mdePrereqsEnabled);
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "MDE_SET_PREREQS_ENABLED") {
        setPrereqsEnabled(msg.enabled);
      }
    });

    /***********************
     * Prereq grouping
     ***********************/

    function buildPrereqGroups(prereqObjs) {
      const groups = [];
      let current = [];

      for (const p of prereqObjs || []) {
        const code = normalizeCourseCode(
          `${p.subjectCodePrerequisite} ${p.courseNumberPrerequisite}`
        );

        const startsGroup = (p.leftParenthesis || "").includes("(");
        const isAnd = p.connector === "A";

        if ((startsGroup || isAnd) && current.length) {
          groups.push(current);
          current = [];
        }

        current.push(code);

        const endsGroup = (p.rightParenthesis || "").includes(")");
        if (endsGroup && current.length) {
          groups.push(current);
          current = [];
        }
      }

      if (current.length) groups.push(current);
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
     * Term mapping
     ***********************/

    function termLabelToCode(season, year) {
      const suffix = { Summer: "00", Fall: "01", Winter: "02", Spring: "03" }[season];
      if (!suffix) return null;

      const y = Number(year);
      const codeYear = season === "Summer" || season === "Fall" ? y + 1 : y;
      return `${codeYear}${suffix}`;
    }

    /***********************
     * Collect scheduled courses
     ***********************/

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
     * MyDegrees API: user + audit -> history set
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
     * Prereq API cache
     ***********************/

    let prereqCache = new Map();

    async function loadPrereqCache() {
      const saved = (await chrome.storage.local.get(PREREQ_KEY))[PREREQ_KEY];
      if (!saved || typeof saved !== "object") return;

      const m = new Map();

      for (const [course, value] of Object.entries(saved)) {
        if (Array.isArray(value) && Array.isArray(value[0])) {
          m.set(course, value);
          continue;
        }

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

    function applyWarnings(items, courseToIndex, termIndexToLabel) {
      for (const it of items) {
        const groups = prereqCache.get(it.courseCode) || [];

        const missingGroups = [];
        const laterMentions = [];

        for (const group of groups) {
          let groupSatisfied = false;

          for (const option of group) {
            const optIdx = courseToIndex.get(option);

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

        if (missingGroups.length === 0 && laterMentions.length === 0) {
          clearBadge(it.cardEl);
          continue;
        }

        const missingSet = new Set();

        for (const group of missingGroups) {
          for (const code of group) missingSet.add(code);
        }

        for (const x of laterMentions) missingSet.add(x.code);

        if (missingSet.size === 0) {
          clearBadge(it.cardEl);
          continue;
        }

        const tooltipText = "Missing Prerequisite: " + Array.from(missingSet).join(", ");
        setBadge(it.cardEl, tooltipText);
      }
    }

    async function tick() {
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
        // Fail quietly so the site remains usable.
        // For debugging:
        // console.log("[MDE prereqs] error", e);
      } finally {
        running = false;
      }
    }

    function scheduleTick() {
      if (!prereqsEnabled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 250);
    }

    /***********************
     * Start feature
     ***********************/

    await initPrereqsEnabledState();
    tick();

    const obs = new MutationObserver(scheduleTick);
    obs.observe(document.body, { childList: true, subtree: true });
  },
});
