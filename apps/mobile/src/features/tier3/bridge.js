// The Tier 3 bridge (WS08): injected into the retailer's own page inside the app's WebView, before
// content loads and again on every load end (SPA navigations do not reload). It serializes the page
// as a snapshot tree (packages/retailers/src/browser/snapshot.ts has the contract), performs clicks,
// typing and selects with real DOM events, streams snapshots for waitFor, and tells the host when
// the page needs the person (sign-in, a human check, a one-time code).
//
// Protocol: packages/retailers/src/browser/protocol.ts and docs/04-integrations.md §Tier 3. Every
// message to the host carries the envelope marker and the per-injection token, so a message the
// page's own scripts post through window.ReactNativeWebView is ignored by the host.
//
// Rules this file keeps:
//   * It never reads, serializes, or types a password, and never fills a sign-in form.
//   * It never changes the user agent, hides automation, or touches a human check. A human check is
//     reported and left for the person.
//   * Nothing here is sent anywhere but the host on the same device.
//
// After editing, run `pnpm --filter @mp/mobile tier3:bridge` to regenerate bridge.generated.ts (a
// test fails when the two differ). The host replaces the token placeholder at the bottom.
((TOKEN) => {
  const GLOBAL = `__mpTier3Bridge_${TOKEN}`;
  const existing = window[GLOBAL];
  if (existing && typeof existing.ping === "function") {
    // Injected twice on the same document (before content loaded, then on load end): keep the first.
    existing.ping();
    return;
  }

  const ENVELOPE = "mp-tier3-bridge";
  const VERSION = 1;
  const WAIT_INTERVAL_MS = 250;
  const DEFAULT_MAX_NODES = 1500;
  const MAX_NAME = 200;
  const MAX_TEXT = 300;

  // Captured at install so later page code cannot swap them out from under us.
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const nativeBridge = window.ReactNativeWebView;

  function post(type, payload) {
    const target = nativeBridge || window.ReactNativeWebView;
    if (!target || typeof target.postMessage !== "function") return;
    const message = { __mp: ENVELOPE, v: VERSION, token: TOKEN, type: type };
    if (payload) {
      for (const key in payload) {
        if (Object.hasOwn(payload, key)) message[key] = payload[key];
      }
    }
    target.postMessage(stringify(message));
  }

  // ---------------------------------------------------------------------------------------
  // Text and visibility
  // ---------------------------------------------------------------------------------------

  const SKIP_TAGS = {
    SCRIPT: 1,
    STYLE: 1,
    NOSCRIPT: 1,
    TEMPLATE: 1,
    HEAD: 1,
    META: 1,
    LINK: 1,
    TITLE: 1,
    BASE: 1,
  };
  const FORM_CONTROLS = { INPUT: 1, SELECT: 1, TEXTAREA: 1 };

  function norm(s) {
    return String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim();
  }

  function clip(s, max) {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  function isHidden(el) {
    if (el.hidden) return true;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
    if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "hidden") {
      return true;
    }
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return true;
    return false;
  }

  function isVisibleDeep(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (isHidden(node)) return false;
    }
    return true;
  }

  // Visible text of a subtree. Form controls contribute nothing (their value is not their text);
  // images contribute their alt text.
  function textOf(el) {
    const parts = [];
    (function visit(node) {
      if (node.nodeType === 3) {
        parts.push(node.data);
        return;
      }
      if (node.nodeType !== 1) return;
      if (SKIP_TAGS[node.tagName] || FORM_CONTROLS[node.tagName] || isHidden(node)) return;
      if (node.tagName === "IMG") {
        parts.push(node.getAttribute("alt") || "");
        return;
      }
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
    })(el);
    return norm(parts.join(" "));
  }

  // ---------------------------------------------------------------------------------------
  // Roles and names (a practical subset of HTML-AAM and accname)
  // ---------------------------------------------------------------------------------------

  const NAME_FROM_CONTENT = {
    button: 1,
    link: 1,
    heading: 1,
    menuitem: 1,
    menuitemcheckbox: 1,
    menuitemradio: 1,
    tab: 1,
    option: 1,
    cell: 1,
    columnheader: 1,
    rowheader: 1,
    checkbox: 1,
    radio: 1,
    switch: 1,
    treeitem: 1,
    tooltip: 1,
  };

  function inputRole(el) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    switch (type) {
      case "hidden":
        return null;
      case "button":
      case "submit":
      case "reset":
      case "image":
        return "button";
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      case "range":
        return "slider";
      case "number":
        return "spinbutton";
      case "search":
        return "searchbox";
      default:
        return "textbox";
    }
  }

  function roleOf(el) {
    const explicit = norm(el.getAttribute("role")).split(" ")[0].toLowerCase();
    if (explicit === "presentation" || explicit === "none") return "generic";
    if (explicit) return explicit;
    const tag = el.tagName;
    switch (tag) {
      case "A":
      case "AREA":
        return el.hasAttribute("href") ? "link" : "generic";
      case "BUTTON":
      case "SUMMARY":
        return "button";
      case "INPUT":
        return inputRole(el);
      case "SELECT":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "OPTION":
        return "option";
      case "TEXTAREA":
        return "textbox";
      case "IMG":
        return el.getAttribute("alt") === "" ? "generic" : "img";
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "heading";
      case "UL":
      case "OL":
      case "MENU":
        return "list";
      case "LI":
        return "listitem";
      case "NAV":
        return "navigation";
      case "MAIN":
        return "main";
      case "FORM":
        return "form";
      case "DIALOG":
        return "dialog";
      case "IFRAME":
        return "iframe";
      case "TABLE":
        return "table";
      case "TR":
        return "row";
      case "TD":
        return "cell";
      case "TH":
        return "columnheader";
      case "ARTICLE":
        return "article";
      case "SECTION":
        return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")
          ? "region"
          : "generic";
      case "HEADER":
        return el.parentElement && el.parentElement.tagName === "BODY" ? "banner" : "generic";
      case "FOOTER":
        return el.parentElement && el.parentElement.tagName === "BODY" ? "contentinfo" : "generic";
      case "ASIDE":
        return "complementary";
      case "FIELDSET":
        return "group";
      case "SEARCH":
        return "search";
      case "OUTPUT":
        return "status";
      case "PROGRESS":
        return "progressbar";
      case "SVG":
      case "svg":
        return el.hasAttribute("aria-label") ? "img" : null;
      default:
        if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
        return "generic";
    }
  }

  function labelText(el) {
    const labels = el.labels;
    if (labels?.length) {
      const parts = [];
      for (let i = 0; i < labels.length; i++) parts.push(textOf(labels[i]));
      const joined = norm(parts.join(" "));
      if (joined) return joined;
    }
    let parent = el.parentElement;
    while (parent) {
      if (parent.tagName === "LABEL") return textOf(parent);
      parent = parent.parentElement;
    }
    return "";
  }

  function nameOf(el, role) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const ids = norm(by).split(" ");
      const parts = [];
      for (let i = 0; i < ids.length; i++) {
        const ref = document.getElementById(ids[i]);
        if (ref) parts.push(textOf(ref));
      }
      const fromRefs = norm(parts.join(" "));
      if (fromRefs) return fromRefs;
    }
    const aria = norm(el.getAttribute("aria-label"));
    if (aria) return aria;

    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") {
        return norm(el.value) || (type === "reset" ? "Reset" : type === "submit" ? "Submit" : "");
      }
      if (type === "image") return norm(el.getAttribute("alt")) || "Submit";
    }
    if (FORM_CONTROLS[tag]) {
      return (
        labelText(el) || norm(el.getAttribute("placeholder")) || norm(el.getAttribute("title"))
      );
    }
    if (tag === "IMG") return norm(el.getAttribute("alt") || el.getAttribute("title"));
    if (tag === "IFRAME") return norm(el.getAttribute("title") || el.getAttribute("name"));
    if (tag === "FIELDSET") {
      const legend = el.querySelector("legend");
      if (legend) return textOf(legend);
    }
    if (tag === "TABLE" && el.caption) return textOf(el.caption);
    if (NAME_FROM_CONTENT[role]) {
      const content = textOf(el);
      if (content) return content;
    }
    return norm(el.getAttribute("title"));
  }

  // ---------------------------------------------------------------------------------------
  // Stable ids: two FNV-1a passes over the key, so ids are short and collisions are rare.
  // ---------------------------------------------------------------------------------------

  function fnv(s, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function hashId(s) {
    return `n${fnv(s, 2166136261).toString(36)}${fnv(s, 3735928559).toString(36)}`;
  }

  // ---------------------------------------------------------------------------------------
  // The walk
  // ---------------------------------------------------------------------------------------

  function box(el) {
    const r = el?.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const vals = r ? [r.left, r.top, r.width, r.height] : [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const v = Number(vals[i]);
      vals[i] = Number.isFinite(v) ? Math.round(v) : 0;
    }
    return vals;
  }

  function controlState(el, role, out) {
    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") out.checked = !!el.checked;
      else if (type !== "password" && role !== "button") out.value = String(el.value);
    } else if (tag === "TEXTAREA" || tag === "SELECT") {
      out.value = String(el.value);
    } else if (tag === "OPTION") {
      out.value = String(el.value);
      out.checked = !!el.selected;
    } else if (tag === "PROGRESS") {
      out.value = String(el.value);
    } else if (role === "textbox" && el.isContentEditable) {
      out.value = norm(el.textContent);
    }
    const ariaChecked = el.getAttribute("aria-checked");
    if (out.checked === undefined && (ariaChecked === "true" || ariaChecked === "false")) {
      out.checked = ariaChecked === "true";
    }
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") out.disabled = true;
    if (role === "link" && el.href) out.href = String(el.href);
  }

  // Builds the full tree of draft nodes ({ role, name, el, children, ... }) for one element.
  // Returns an array (a collapsed wrapper hands up its children) or null.
  function build(el) {
    if (el.nodeType !== 1 || SKIP_TAGS[el.tagName] || isHidden(el)) return null;
    const role = roleOf(el);
    if (role === null) return null;

    const children = [];
    if (el.tagName !== "IFRAME" && !FORM_CONTROLS[el.tagName]) {
      let hasElementChildren = false;
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (!SKIP_TAGS[c.tagName]) hasElementChildren = true;
      }
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const run = norm(child.data);
          // A text run beside elements becomes its own node; a lone text run is the element's text.
          if (run && hasElementChildren) {
            children.push({ role: "text", name: clip(run, MAX_NAME), el: el, children: [] });
          }
        } else if (child.nodeType === 1) {
          const built = build(child);
          if (built) for (let i = 0; i < built.length; i++) children.push(built[i]);
        }
      }
    } else if (el.tagName === "SELECT") {
      for (let o = 0; o < el.options.length; o++) {
        const opt = el.options[o];
        const optNode = {
          role: "option",
          name: clip(norm(opt.text), MAX_NAME),
          el: opt,
          children: [],
        };
        controlState(opt, "option", optNode);
        children.push(optNode);
      }
    }

    const name = nameOf(el, role);
    const node = { role: role, name: clip(name, MAX_NAME), el: el, children: children };
    controlState(el, role, node);

    if (role === "generic") {
      const ownText = children.length === 0 ? textOf(el) : "";
      if (children.length === 0 && !ownText) return null;
      if (children.length === 0) {
        // A leaf that only holds text is a text node.
        node.role = "text";
        node.name = clip(ownText, MAX_NAME);
        return [node];
      }
      if (children.length === 1 && !node.name) return children;
      return [node];
    }
    if (children.length === 0 && !FORM_CONTROLS[el.tagName]) {
      const leafText = textOf(el);
      if (leafText && leafText !== node.name) node.text = clip(leafText, MAX_TEXT);
    }
    return [node];
  }

  function firstNamed(draft) {
    for (let i = 0; i < draft.children.length; i++) {
      const child = draft.children[i];
      if (child.name) return child.name;
      const deeper = firstNamed(child);
      if (deeper) return deeper;
    }
    return "";
  }

  function domIndex(el) {
    let i = 0;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) i++;
    return el.tagName + i;
  }

  // Assigns ids top-down: hash(parent id, role, key, index among siblings with that role and key).
  function assignIds(draft, parentId, used) {
    const counts = {};
    for (let i = 0; i < draft.children.length; i++) {
      const child = draft.children[i];
      const key = child.name ? child.name : `~${firstNamed(child) || `#${domIndex(child.el)}`}`;
      const slot = `${child.role}|${key}`;
      const k = counts[slot] || 0;
      counts[slot] = k + 1;
      let id = hashId(`${parentId}/${slot}#${k}`);
      if (used[id]) {
        let n = 2;
        while (used[`${id}_${n}`]) n++;
        id = `${id}_${n}`;
      }
      used[id] = 1;
      child.id = id;
      assignIds(child, id, used);
    }
  }

  let elementsById = {};

  // Turns drafts into SnapshotNodes in document order, stopping at maxNodes.
  function emit(draft, budget, registry) {
    if (budget.left <= 0) {
      budget.truncated = true;
      return null;
    }
    budget.left -= 1;
    budget.count += 1;
    registry[draft.id] = draft.el;
    const out = { id: draft.id, role: draft.role, name: draft.name, bbox: box(draft.el) };
    if (draft.text !== undefined) out.text = draft.text;
    if (draft.value !== undefined) out.value = draft.value;
    if (draft.href !== undefined) out.href = draft.href;
    if (draft.disabled) out.disabled = true;
    if (draft.checked !== undefined) out.checked = draft.checked;
    if (draft.children.length) {
      const kids = [];
      for (let i = 0; i < draft.children.length; i++) {
        const kid = emit(draft.children[i], budget, registry);
        if (kid) kids.push(kid);
        else if (budget.truncated) break;
      }
      if (kids.length) out.children = kids;
    }
    return out;
  }

  function snapshot(maxNodes) {
    const cap = Math.max(1, Math.floor(Number(maxNodes) || DEFAULT_MAX_NODES));
    const rootDraft = {
      role: "document",
      name: clip(norm(document.title), MAX_NAME),
      el: document.documentElement,
      children: [],
    };
    if (document.body) {
      const built = build(document.body);
      if (built) {
        // The body itself is never a node: its content hangs off the document.
        if (built.length === 1 && built[0].el === document.body)
          rootDraft.children = built[0].children;
        else rootDraft.children = built;
      }
    }
    rootDraft.id = hashId("document");
    assignIds(rootDraft, rootDraft.id, {});
    const registry = {};
    const budget = { left: cap, count: 0, truncated: false };
    const root = emit(rootDraft, budget, registry);
    root.bbox = [0, 0, Math.round(window.innerWidth || 0), Math.round(window.innerHeight || 0)];
    elementsById = registry;
    return {
      url: String(location.href),
      title: norm(document.title),
      root: root,
      capturedAt: new Date().toISOString(),
      truncated: budget.truncated,
      nodeCount: budget.count,
    };
  }

  function idOf(el) {
    for (const id in elementsById) {
      if (elementsById[id] === el) return id;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------
  // Actions with real DOM events
  // ---------------------------------------------------------------------------------------

  function BridgeError(code, message) {
    this.code = code;
    this.message = message || code;
  }

  function resolve(nodeId) {
    let el = elementsById[nodeId];
    if (!el?.isConnected) {
      snapshot(1000000);
      el = elementsById[nodeId];
    }
    if (!el?.isConnected) {
      throw new BridgeError(
        "stale_node",
        `Node ${nodeId} is not on the page. Take a new snapshot.`,
      );
    }
    return el;
  }

  function centreOf(el) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
  }

  function fire(el, type, Ctor, init) {
    const Event = Ctor || window.Event;
    const opts = { bubbles: true, cancelable: true, composed: true };
    if (init) for (const k in init) opts[k] = init[k];
    let event;
    try {
      event = new Event(type, opts);
    } catch (_e) {
      event = new window.Event(type, opts);
    }
    return el.dispatchEvent(event);
  }

  function pointer(el, type) {
    const c = centreOf(el);
    const init = {
      clientX: c.x,
      clientY: c.y,
      button: 0,
      buttons: type.indexOf("down") >= 0 ? 1 : 0,
      view: window,
    };
    const Ctor =
      type.indexOf("pointer") === 0 ? window.PointerEvent || window.MouseEvent : window.MouseEvent;
    if (type.indexOf("pointer") === 0) {
      init.pointerId = 1;
      init.pointerType = "touch";
      init.isPrimary = true;
    }
    fire(el, type, Ctor, init);
  }

  function isDisabled(el) {
    return el.disabled === true || el.getAttribute("aria-disabled") === "true";
  }

  function click(el) {
    if (isDisabled(el)) throw new BridgeError("not_actionable", "The control is disabled.");
    if (el.scrollIntoView) {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch (_e) {}
    }
    pointer(el, "pointerover");
    pointer(el, "pointerdown");
    pointer(el, "mousedown");
    if (typeof el.focus === "function") el.focus();
    pointer(el, "pointerup");
    pointer(el, "mouseup");
    if (typeof el.click === "function") el.click();
    else pointer(el, "click");
  }

  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  function key(el, type, ch) {
    fire(el, type, window.KeyboardEvent, { key: ch, code: "", view: window });
  }

  function typeInto(el, text, clear) {
    const tag = el.tagName;
    const editable = el.isContentEditable && el.getAttribute("contenteditable") !== null;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "password") {
        throw new BridgeError(
          "password_field",
          "Passwords are typed by the person, never by the agent.",
        );
      }
      if (inputRole(el) !== "textbox" && type !== "search" && type !== "number") {
        throw new BridgeError("not_actionable", "This field does not take text.");
      }
    } else if (tag !== "TEXTAREA" && !editable) {
      throw new BridgeError("not_actionable", "This node does not take text.");
    }
    if (isDisabled(el) || el.readOnly)
      throw new BridgeError("not_actionable", "The field is read-only.");
    if (typeof el.focus === "function") el.focus();

    if (editable) {
      if (clear) el.textContent = "";
      el.textContent = (el.textContent || "") + text;
      fire(el, "input", window.InputEvent, { data: text, inputType: "insertText" });
      return;
    }
    if (clear && el.value !== "") {
      setNativeValue(el, "");
      fire(el, "input", window.InputEvent, { inputType: "deleteContentBackward" });
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      key(el, "keydown", ch);
      key(el, "keypress", ch);
      setNativeValue(el, String(el.value) + ch);
      fire(el, "input", window.InputEvent, { data: ch, inputType: "insertText" });
      key(el, "keyup", ch);
    }
    fire(el, "change", window.Event);
  }

  function selectValue(el, value) {
    const want = norm(value).toLowerCase();
    if (el.tagName === "SELECT") {
      if (isDisabled(el)) throw new BridgeError("not_actionable", "The control is disabled.");
      let match = null;
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        if (opt.value === value || norm(opt.text).toLowerCase() === want) {
          match = opt;
          break;
        }
      }
      if (!match) throw new BridgeError("no_such_option", `No option matches ${value}.`);
      if (typeof el.focus === "function") el.focus();
      setNativeValue(el, match.value);
      fire(el, "input", window.Event);
      fire(el, "change", window.Event);
      return;
    }
    const role = roleOf(el);
    if (role === "option" || role === "menuitem" || role === "radio" || role === "menuitemradio") {
      click(el);
      return;
    }
    throw new BridgeError("not_actionable", "Select needs a select element or an option node.");
  }

  // ---------------------------------------------------------------------------------------
  // When the person is needed
  // ---------------------------------------------------------------------------------------

  const SIGNIN_PATH = /(^|[/_.-])(sign[-_]?in|log[-_]?in|logon|signon|authenticate)([/_.?#-]|$)/i;
  const CAPTCHA =
    /captcha|verify (?:that )?you(?:'| a)re (?:a )?human|verify you are (?:a )?human|press (?:&|and) hold|are you a robot|human verification/i;
  const OTP_NAME = /one[-_ ]?time|\botp\b|verification[-_ ]?code|security[-_ ]?code|passcode/i;

  function firstVisible(selector) {
    const list = document.querySelectorAll(selector);
    for (let i = 0; i < list.length; i++) if (isVisibleDeep(list[i])) return list[i];
    return null;
  }

  function findOtp() {
    const direct = firstVisible('input[autocomplete="one-time-code"]');
    if (direct) return direct;
    const inputs = document.querySelectorAll("input");
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const type = (input.getAttribute("type") || "text").toLowerCase();
      if (type === "password" || type === "hidden" || type === "checkbox" || type === "radio")
        continue;
      const hint = [
        input.getAttribute("name"),
        input.id,
        input.getAttribute("aria-label"),
        input.getAttribute("placeholder"),
      ].join(" ");
      if (OTP_NAME.test(hint) && isVisibleDeep(input)) return input;
    }
    return null;
  }

  function findCaptcha() {
    const frames = document.querySelectorAll("iframe");
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const label = [
        f.getAttribute("title"),
        f.getAttribute("name"),
        f.getAttribute("aria-label"),
        f.getAttribute("src"),
      ].join(" ");
      if (CAPTCHA.test(label) && isVisibleDeep(f)) return f;
    }
    const labelled = document.querySelectorAll("[aria-label], [title]");
    for (let j = 0; j < labelled.length; j++) {
      const el = labelled[j];
      const text = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
      if (CAPTCHA.test(text) && isVisibleDeep(el)) return el;
    }
    if (document.body && document.createTreeWalker) {
      const walker = document.createTreeWalker(document.body, 4, null);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS[parent.tagName]) continue;
        if (CAPTCHA.test(node.data) && isVisibleDeep(parent)) return parent;
      }
    }
    return null;
  }

  const reported = {};

  function detect() {
    if (!document.documentElement) return;
    const found = {};
    const password = firstVisible('input[type="password"]');
    if (password) found.login = password;
    else if (SIGNIN_PATH.test(location.pathname)) found.login = document.body;
    const otp = findOtp();
    if (otp) found.mfa = otp;
    const check = findCaptcha();
    if (check) found.captcha = check;

    const order = ["captcha", "mfa", "login"];
    let needIds = false;
    for (let i = 0; i < order.length; i++) {
      const r = order[i];
      if (found[r] && reported[r] !== location.href) needIds = true;
    }
    if (needIds) snapshot(DEFAULT_MAX_NODES);
    for (let k = 0; k < order.length; k++) {
      const reason = order[k];
      if (found[reason]) {
        if (reported[reason] !== location.href) {
          reported[reason] = location.href;
          const payload = { reason: reason, url: String(location.href) };
          const nodeId = idOf(found[reason]);
          if (nodeId) payload.nodeId = nodeId;
          post("userRequired", payload);
        }
      } else {
        delete reported[reason];
      }
    }
  }

  let detectTimer = null;
  function scheduleDetect() {
    if (detectTimer) return;
    detectTimer = setTimeout(() => {
      detectTimer = null;
      try {
        detect();
      } catch (_e) {}
    }, 200);
  }

  // ---------------------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------------------

  let lastUrl = String(location.href);
  function noteNavigation() {
    const now = String(location.href);
    if (now === lastUrl) return;
    lastUrl = now;
    post("navigated", { url: now, title: norm(document.title) });
    scheduleDetect();
  }

  function wrapHistory(name) {
    const original = history[name];
    if (typeof original !== "function") return;
    history[name] = function (...args) {
      const result = original.apply(this, args);
      try {
        noteNavigation();
      } catch (_e) {}
      return result;
    };
  }

  // ---------------------------------------------------------------------------------------
  // Messages from the host
  // ---------------------------------------------------------------------------------------

  const waits = {};

  function dumpStorage(store) {
    const out = {};
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k !== null) out[k] = String(store.getItem(k));
      }
    } catch (_e) {}
    return out;
  }

  function stopWait(requestId) {
    const w = waits[requestId];
    if (!w) return;
    clearInterval(w.interval);
    clearTimeout(w.timeout);
    delete waits[requestId];
  }

  function handle(msg) {
    const requestId = msg.requestId;
    try {
      switch (msg.type) {
        case "snapshot":
          post("snapshot.result", { requestId: requestId, tree: snapshot(msg.maxNodes) });
          return;
        case "click":
          click(resolve(msg.nodeId));
          post("action.result", { requestId: requestId, ok: true });
          scheduleDetect();
          return;
        case "type":
          typeInto(resolve(msg.nodeId), String(msg.text == null ? "" : msg.text), !!msg.clear);
          post("action.result", { requestId: requestId, ok: true });
          return;
        case "select":
          selectValue(resolve(msg.nodeId), String(msg.value == null ? "" : msg.value));
          post("action.result", { requestId: requestId, ok: true });
          return;
        case "waitFor": {
          stopWait(requestId);
          const send = () => {
            post("snapshot.result", { requestId: requestId, tree: snapshot(msg.maxNodes) });
          };
          send();
          waits[requestId] = {
            interval: setInterval(send, WAIT_INTERVAL_MS),
            timeout: setTimeout(
              () => {
                stopWait(requestId);
              },
              Math.max(0, Number(msg.timeoutMs) || 0) + WAIT_INTERVAL_MS * 2,
            ),
          };
          return;
        }
        case "waitFor.stop":
          stopWait(requestId);
          return;
        case "storage.read":
          post("storage.result", {
            requestId: requestId,
            origin: String(location.origin),
            localStorage: dumpStorage(window.localStorage),
            sessionStorage: dumpStorage(window.sessionStorage),
          });
          return;
        default:
          if (requestId) {
            post("action.result", {
              requestId: requestId,
              ok: false,
              error: { code: "unknown_message", message: `Unknown message ${msg.type}` },
            });
          }
      }
    } catch (err) {
      if (!requestId) return;
      const code = err instanceof BridgeError ? err.code : "action_failed";
      const message = err?.message ? String(err.message) : String(err);
      post("action.result", {
        requestId: requestId,
        ok: false,
        error: { code: code, message: message },
      });
    }
  }

  function announceReady() {
    post("ready", { url: String(location.href), title: norm(document.title) });
    scheduleDetect();
  }

  const api = {
    receive: (raw) => {
      let msg;
      try {
        msg = typeof raw === "string" ? parse(raw) : raw;
      } catch (_e) {
        return;
      }
      if (msg && typeof msg.type === "string") handle(msg);
    },
    ping: () => {
      noteNavigation();
      if (document.readyState !== "loading") announceReady();
    },
  };

  try {
    Object.defineProperty(window, GLOBAL, {
      value: api,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } catch (_e) {
    window[GLOBAL] = api;
  }

  wrapHistory("pushState");
  wrapHistory("replaceState");
  window.addEventListener("popstate", noteNavigation);
  window.addEventListener("hashchange", noteNavigation);

  function startObserving() {
    if (window.MutationObserver && document.documentElement) {
      new window.MutationObserver(scheduleDetect).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "hidden",
          "style",
          "class",
          "type",
          "autocomplete",
          "title",
          "aria-hidden",
        ],
      });
    }
    announceReady();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserving, { once: true });
  } else {
    startObserving();
  }
})("__MP_BRIDGE_TOKEN__");
