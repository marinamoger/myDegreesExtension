const COURSE_CODE_REGEX = /\b[A-Z]{2,4}\s?\d{3}\b/g; // e.g., CS 361, MTH251, ECE 271

/*
Function: loadCourseMap
Loads courses.json file into memory as a javascript object to give access to course info.
*/
async function loadCourseMap() {
  const url = chrome.runtime.getURL("data/courses.json");
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load course map");
  return res.json();
}

/*
Function: shouldSkipNode
If the web text is inside a script, style, textarea, or input tag, skip that text
to avoid breaking the page. 
Input: node (text on page)
Output: bool (should or should not skip)
*/
function shouldSkipNode(node) {
  const p = node.parentElement;
  if (!p) return true;
  const tag = p.tagName;
  return tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "INPUT";
}

/*
Function: normalizeCode
Converts different formats of a course code into a singular format. 
Example: Turn "CS361" or "CS 361" into "CS 361"
Input: Raw course code as written in myDegrees
Output: Properly formatted course code
*/
function normalizeCode(raw) {
  const m = raw.match(/^([A-Z]{2,4})\s?(\d{3})$/);
  if (!m) return raw;
  return `${m[1]} ${m[2]}`;
}

/*
Function: addTitleAfterTextNode
Takes one text node, finds course code within text node, injects full course title 
after text node. 
Inputs: textNode, courseMap 
*/
function addTitleAfterTextNode(textNode, courseMap) {
  //only run if node is safe to modify
  if (shouldSkipNode(textNode)) return;
  
  //only run if node exists
  const text = textNode.nodeValue;
  if (!text) return;

  //only run if there is text matching the course code regex
  const matches = [...text.matchAll(COURSE_CODE_REGEX)];
  if (matches.length === 0) return;

  //only run if we have not yet modified this element
  const parent = textNode.parentNode;
  //if parent exists and is a real HTML element
  if (parent && parent.nodeType === Node.ELEMENT_NODE) {
    //if element is already modified, return
    if (parent.dataset && parent.dataset.processed === "1") return;
  }

  //build a new fragment replacing only known course codes
  const frag = document.createDocumentFragment();
  let lastIndex = 0;

  for (const match of matches) {
    const rawCode = match[0];
    const start = match.index;
    const end = start + rawCode.length;

    //append text before the match
    frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));

    const code = normalizeCode(rawCode);
    const title = courseMap[code];

    //put the original code text back
    frag.appendChild(document.createTextNode(rawCode));

    // if we know the title, append it
    if (title) {
      const span = document.createElement("span");
      span.textContent = ` (${title})`;
      span.style.fontSize = "0.9em";
      span.style.opacity = "0.85";
      span.style.marginLeft = "2px";
      span.dataset.injected = "1";
      frag.appendChild(span);
    }

    lastIndex = end;
  }

  frag.appendChild(document.createTextNode(text.slice(lastIndex)));

  // replace the original text node
  parent.replaceChild(frag, textNode);

  // mark parent so MutationObserver doesn't re-process it forever
  if (parent.nodeType === Node.ELEMENT_NODE) {
    parent.dataset.processed = "1";
  }
}

/*
Function: processPage
Traverses the DOM, collect all text nodes in an array, process each node, calls
addTitleAfterTextNode on each one.
Input: courseMap
*/
function processPage(courseMap) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textNodes = [];

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  for (const n of textNodes) addTitleAfterTextNode(n, courseMap);
}


(async function main() {
  try {
    const courseMap = await loadCourseMap();
    processPage(courseMap);

    // MyDegrees is dynamic, rerun when it changes
    const observer = new MutationObserver(() => processPage(courseMap));
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (err) {
    console.error("[MyDegrees Enhancer]", err);
  }
})();
