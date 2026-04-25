/* fleetview — artifact design-mode inspector.
 *
 * Loads inside every artifact iframe (dev-mode Vite). Sits dormant
 * until the parent (fleetview UI) posts {type:"fv:design", on:true}.
 * In design mode: hover highlights; click captures the element +
 * its React source location; an inline bubble takes a comment; on
 * Send/Add the annotation goes back to the parent via postMessage.
 *
 * Adapted from superbot3's ui-feedback-extension (a Chrome extension
 * that did the same thing for arbitrary pages). Here the inspector
 * is scoped to artifact iframes only, the source location comes from
 * React fiber's _debugSource (more precise than CSS selectors), and
 * the styling matches fleetview's japandi tokens.
 */
(function () {
  if (window.__fvInspectorActive) return;
  window.__fvInspectorActive = true;

  const STATE = {
    on: false,
    hovered: null,
    selected: null,
    bubble: null,
    hoverTimer: null,
  };

  // Only run inside dev-mode iframes loaded over loopback. Belt-and-
  // suspenders — fleetview only injects this into artifact iframes,
  // but the script also self-guards.
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    return;
  }

  // ── styles ─────────────────────────────────────────────────────
  const css = `
    .fv-highlight {
      cursor: crosshair !important;
      box-shadow: inset 0 0 0 2px color-mix(in oklch, oklch(0.60 0.080 140) 80%, transparent), 0 0 0 0 transparent !important;
      background-color: color-mix(in oklch, oklch(0.60 0.080 140) 14%, transparent) !important;
      transition: box-shadow 180ms ease, background-color 180ms ease !important;
    }
    .fv-selected {
      outline: 2px solid color-mix(in oklch, oklch(0.60 0.080 140) 90%, transparent) !important;
      outline-offset: 1px !important;
    }
    #fv-bubble, #fv-bubble * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
      letter-spacing: normal;
      text-transform: none;
      font-style: normal;
    }
    #fv-bubble {
      position: absolute;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 4px;
      background: oklch(0.985 0.005 90);
      color: oklch(0.18 0.02 80);
      border: 1px solid oklch(0.86 0.012 90);
      border-radius: 12px;
      padding: 4px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.02);
      animation: fv-pop-in 0.18s cubic-bezier(.16,1,.3,1);
    }
    #fv-bubble input {
      background: transparent;
      border: none;
      outline: none;
      color: inherit;
      font-size: 13px;
      width: 220px;
      padding: 4px 6px;
    }
    #fv-bubble input::placeholder { color: oklch(0.55 0.01 80); }
    #fv-bubble button {
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 120ms ease;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    #fv-bubble button kbd {
      font-size: 10px;
      opacity: 0.4;
      font-weight: 400;
      font-family: ui-monospace, 'Geist Mono', monospace;
    }
    #fv-bubble .fv-add {
      background: oklch(0.92 0.01 90);
      color: oklch(0.30 0.02 80);
      border-color: oklch(0.86 0.012 90);
    }
    #fv-bubble .fv-add:hover { background: oklch(0.88 0.012 90); }
    #fv-bubble .fv-send {
      background: oklch(0.60 0.080 140);
      color: oklch(0.985 0.005 90);
    }
    #fv-bubble .fv-send:hover { background: oklch(0.55 0.085 140); }
    @keyframes fv-pop-in {
      from { opacity: 0; transform: translateY(4px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "fv-inspector-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── helpers ────────────────────────────────────────────────────

  // React fiber introspection. Each DOM node rendered by React (dev
  // mode) gets an internal property `__reactFiber$<random>`. The
  // fiber carries _debugSource from the JSX dev transform, plus type
  // info we can use to build a friendly element label.
  function getFiber(el) {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    return k ? el[k] : null;
  }

  function getSourceLoc(el) {
    let fiber = getFiber(el);
    while (fiber) {
      if (fiber._debugSource) {
        const s = fiber._debugSource;
        return {
          fileName: s.fileName,
          lineNumber: s.lineNumber,
          columnNumber: s.columnNumber,
        };
      }
      fiber = fiber.return;
    }
    return null;
  }

  // Compact label like `h1.text-4xl ("Good coffee takes time")`.
  function getElementLabel(el) {
    const tag = el.tagName.toLowerCase();
    let cls = "";
    if (typeof el.className === "string" && el.className.trim()) {
      const parts = el.className
        .split(/\s+/)
        .filter((c) => c && !c.startsWith("fv-"))
        .slice(0, 2);
      if (parts.length) cls = "." + parts.join(".");
    }
    let txt = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (txt.length > 40) txt = txt.slice(0, 37) + "…";
    return `${tag}${cls}${txt ? ` ("${txt}")` : ""}`;
  }

  function getCleanHtml(el) {
    const clone = el.cloneNode(true);
    clone.classList.remove("fv-highlight");
    clone.classList.remove("fv-selected");
    let html = clone.outerHTML;
    if (html.length > 500) html = html.slice(0, 500) + "…";
    return html;
  }

  // ── activation ────────────────────────────────────────────────

  function setMode(on) {
    if (STATE.on === on) return;
    STATE.on = on;
    if (!on) {
      clearHover();
      closeBubble();
    }
    document.body.style.cursor = on ? "crosshair" : "";
  }

  function clearHover() {
    if (STATE.hoverTimer) {
      clearTimeout(STATE.hoverTimer);
      STATE.hoverTimer = null;
    }
    if (STATE.hovered) {
      STATE.hovered.classList.remove("fv-highlight");
      STATE.hovered = null;
    }
  }

  function closeBubble() {
    if (STATE.bubble) {
      STATE.bubble.remove();
      STATE.bubble = null;
    }
    if (STATE.selected) {
      STATE.selected.classList.remove("fv-selected");
      STATE.selected = null;
    }
  }

  function isOurUI(target) {
    return target.closest && target.closest("#fv-bubble");
  }

  // ── event handlers ────────────────────────────────────────────

  function onMouseOver(e) {
    if (!STATE.on || isOurUI(e.target) || e.target === STATE.selected) return;
    if (STATE.hoverTimer) clearTimeout(STATE.hoverTimer);
    const target = e.target;
    STATE.hoverTimer = setTimeout(() => {
      if (STATE.hovered && STATE.hovered !== target) {
        STATE.hovered.classList.remove("fv-highlight");
      }
      STATE.hovered = target;
      target.classList.add("fv-highlight");
      STATE.hoverTimer = null;
    }, 100);
  }

  function onMouseOut(e) {
    if (!STATE.on || isOurUI(e.target)) return;
    if (STATE.hoverTimer) {
      clearTimeout(STATE.hoverTimer);
      STATE.hoverTimer = null;
    }
    if (e.target && e.target !== STATE.selected) {
      e.target.classList.remove("fv-highlight");
    }
  }

  function onClick(e) {
    if (!STATE.on) return;
    if (isOurUI(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    closeBubble();
    STATE.selected = e.target;
    STATE.selected.classList.remove("fv-highlight");
    STATE.selected.classList.add("fv-selected");
    showBubble(STATE.selected);
  }

  function onKeyDown(e) {
    if (!STATE.on) return;
    if (e.key === "Escape") {
      if (STATE.bubble) closeBubble();
      else parent.postMessage({ type: "fv:design-cancel" }, "*");
    }
    if (STATE.bubble && e.key === "Enter") {
      e.preventDefault();
      submit(e.metaKey || e.ctrlKey);
    }
  }

  function showBubble(el) {
    const rect = el.getBoundingClientRect();
    const bubble = document.createElement("div");
    bubble.id = "fv-bubble";
    bubble.innerHTML =
      '<input id="fv-input" placeholder="Describe the change…" autocomplete="off" />' +
      '<button class="fv-add" id="fv-add" title="Add to queue">Add <kbd>↵</kbd></button>' +
      '<button class="fv-send" id="fv-send" title="Send all to orchestrator">Send <kbd>⌘↵</kbd></button>';
    document.body.appendChild(bubble);

    const bb = bubble.getBoundingClientRect();
    let top = rect.bottom + window.scrollY + 8;
    let left = rect.left + window.scrollX;
    if (left + bb.width > window.innerWidth - 16) {
      left = window.innerWidth - bb.width - 16;
    }
    if (left < 16) left = 16;
    if (rect.bottom + bb.height + 16 > window.innerHeight) {
      top = rect.top + window.scrollY - bb.height - 8;
    }
    bubble.style.left = left + "px";
    bubble.style.top = top + "px";

    STATE.bubble = bubble;
    const input = bubble.querySelector("#fv-input");
    setTimeout(() => input.focus(), 30);

    bubble.querySelector("#fv-add").addEventListener("click", (e) => {
      e.stopPropagation();
      submit(false);
    });
    bubble.querySelector("#fv-send").addEventListener("click", (e) => {
      e.stopPropagation();
      submit(true);
    });
  }

  function submit(sendNow) {
    if (!STATE.bubble || !STATE.selected) return;
    const input = STATE.bubble.querySelector("#fv-input");
    const text = input.value.trim();
    if (!text) {
      input.style.borderBottom = "2px solid oklch(0.55 0.18 22)";
      input.placeholder = "Type something…";
      return;
    }
    const annotation = {
      text,
      source: getSourceLoc(STATE.selected),
      label: getElementLabel(STATE.selected),
      html: getCleanHtml(STATE.selected),
      url: location.href,
    };
    parent.postMessage(
      { type: "fv:annotation", payload: annotation, sendNow: !!sendNow },
      "*",
    );
    closeBubble();
  }

  // ── parent ↔ iframe protocol ──────────────────────────────────

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "fv:design") {
      setMode(!!msg.on);
    }
  });

  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);

  // Announce so the parent can flip state if it cares.
  parent.postMessage({ type: "fv:inspector-ready" }, "*");
})();
