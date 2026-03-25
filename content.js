let isTranslating = false;
let translationEnabled = true;
let currentSourceLang = "auto";
let currentTargetLang = "es";
let readAloudEnabled = false;
let hideSourceText = false;
let sourceTextFactor = 0.8;
let targetTextFactor = 1.2;
let boldText = "target";
let adaptiveOverlayPosition = true;
let captionObserver = null;
let playerUiObserver = null;
let playerUiListeners = [];
let playerUiUpdateTimer = null;
let translatedHistory = [];
let currentStyle = { fontSize: "24", textColor: "#ffffff", bgOpacity: "75" };
let lastOriginalText = "";
let lastOverlayBottom = "";
let rollingOriginal = "";      // accumulated display buffer
let rollingTranslated = "";
let lastSegOriginal = "";      // last raw segment text (for grow-detection)
let lastSegTranslated = "";
let isLineShiftAnimating = false;
let pendingDisplayUpdate = false; // flag: re-render after animation ends

// Handle SPA navigation on YouTube
document.addEventListener("yt-navigate-finish", () => {
  if (isTranslating) {
    translatedHistory = [];
    lastOriginalText = "";
    rollingOriginal = "";
    rollingTranslated = "";
    lastSegOriginal = "";
    lastSegTranslated = "";
    isLineShiftAnimating = false;
    pendingDisplayUpdate = false;
    teardownPlayerUiTracking();
    setupObserver();
    refreshOverlayPositionSoon();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startTranslation") {
    isTranslating = true;
    translationEnabled = request.translationEnabled !== false;
    currentSourceLang = request.sourceLang || "auto";
    currentTargetLang = request.targetLang;
    readAloudEnabled = request.readAloud;
    hideSourceText = Boolean(request.hideSourceText);
    sourceTextFactor = Number(request.sourceTextFactor || 0.8);
    targetTextFactor = Number(request.targetTextFactor || 1.2);
    boldText = request.boldText || "target";
    adaptiveOverlayPosition = request.adaptiveOverlayPosition !== false;
    if (request.style) {
      currentStyle = request.style;
    }

    setupObserver();
    createOverlay();
    if (translationEnabled) {
      hideOriginalCaptions();
    } else {
      restoreOriginalCaptions();
    }
  } else if (request.action === "updateStyle") {
    currentStyle = request.style;
    updateOverlayStyle();
  } else if (request.action === "updateSettings") {
    applySettings(request.settings || {});
  } else if (request.action === "downloadSrt") {
    generateAndDownloadSRT();
  } else if (request.action === "toggleTranslation") {
    translationEnabled = request.enabled !== false;
    if (translationEnabled) {
      createOverlay();
      hideOriginalCaptions();
      updateOverlayStyle();
    } else {
      clearOverlayText();
      hideOverlay();
      restoreOriginalCaptions();
    }
  } else if (request.action === "getAvailableLanguages") {
    sendResponse({ languages: getAvailableLanguages() });
    return true;
  }
});

function applySettings(settings) {
  if (settings.sourceLang) currentSourceLang = settings.sourceLang;
  if (settings.targetLang) currentTargetLang = settings.targetLang;
  if (settings.readAloud !== undefined) readAloudEnabled = settings.readAloud;
  if (settings.hideSourceText !== undefined)
    hideSourceText = Boolean(settings.hideSourceText);
  if (settings.sourceTextFactor !== undefined)
    sourceTextFactor = Number(settings.sourceTextFactor);
  if (settings.targetTextFactor !== undefined)
    targetTextFactor = Number(settings.targetTextFactor);
  if (settings.translationEnabled !== undefined)
    translationEnabled = Boolean(settings.translationEnabled);
  if (settings.adaptiveOverlayPosition !== undefined) {
    adaptiveOverlayPosition = Boolean(settings.adaptiveOverlayPosition);
  }
  if (settings.boldText) boldText = settings.boldText;
  if (settings.style) currentStyle = settings.style;

  updateOverlayStyle();
}

function isControlsVisible() {
  const player = document.querySelector("#movie_player");
  if (!player) return false;

  const controls = player.querySelector(
    ".ytp-chrome-bottom, .ytp-player-controls, .ytp-chrome-controls",
  );
  if (!controls) return false;

  const style = window.getComputedStyle(controls);
  const rect = controls.getBoundingClientRect();
  const hiddenByClass =
    player.classList.contains("ytp-autohide") ||
    player.classList.contains("ytp-hide-controls");
  const hasSize = rect.width > 0 && rect.height > 6;
  const visibleByStyle =
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity || "1") > 0.01;

  return hasSize && visibleByStyle && !hiddenByClass;
}

function isPlayerControlsActive() {
  const videoEl = document.querySelector("video");
  if (videoEl && videoEl.paused) {
    return true;
  }
  return isControlsVisible();
}

function getOverlayBottomOffset() {
  if (!adaptiveOverlayPosition) {
    return "15%";
  }

  return isPlayerControlsActive() ? "72px" : "6%";
}

function refreshOverlayPositionSoon() {
  if (playerUiUpdateTimer !== null) return;
  playerUiUpdateTimer = window.setTimeout(() => {
    playerUiUpdateTimer = null;
    updateOverlayStyle();
  }, 50);
}

function teardownPlayerUiTracking() {
  if (captionObserver) {
    captionObserver.disconnect();
    captionObserver = null;
  }

  if (playerUiObserver) {
    playerUiObserver.disconnect();
    playerUiObserver = null;
  }

  playerUiListeners.forEach(({ element, eventName }) => {
    element.removeEventListener(eventName, refreshOverlayPositionSoon);
  });
  playerUiListeners = [];

  if (playerUiUpdateTimer !== null) {
    window.clearTimeout(playerUiUpdateTimer);
    playerUiUpdateTimer = null;
  }
}

function bindPlayerUiTracking(player, videoEl) {
  teardownPlayerUiTracking();

  const playerEvents = [
    "mousemove",
    "mouseenter",
    "mouseleave",
    "touchstart",
    "touchend",
  ];
  const videoEvents = ["play", "pause", "seeking", "seeked", "timeupdate"];

  playerEvents.forEach((eventName) => {
    if (!player) return;
    player.addEventListener(eventName, refreshOverlayPositionSoon, {
      passive: true,
    });
    playerUiListeners.push({ element: player, eventName });
  });

  videoEvents.forEach((eventName) => {
    if (!videoEl) return;
    videoEl.addEventListener(eventName, refreshOverlayPositionSoon, {
      passive: true,
    });
    playerUiListeners.push({ element: videoEl, eventName });
  });

  if (player) {
    playerUiObserver = new MutationObserver(refreshOverlayPositionSoon);
    playerUiObserver.observe(player, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: false,
    });

    const controls = player.querySelector(
      ".ytp-chrome-bottom, .ytp-player-controls, .ytp-chrome-controls",
    );
    if (controls) {
      playerUiObserver.observe(controls, {
        attributes: true,
        attributeFilter: ["class", "style"],
        subtree: false,
      });
    }
  }
}

function createOverlay() {
  let overlay = document.getElementById("yt-translate-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "yt-translate-overlay";
    const player = document.querySelector("#movie_player") || document.body;
    player.appendChild(overlay);
  }
  updateOverlayStyle();
}

function updateOverlayStyle() {
  const overlay = document.getElementById("yt-translate-overlay");
  if (overlay) {
    overlay.style.position = "absolute";
    const overlayBottom = getOverlayBottomOffset();
    if (overlayBottom !== lastOverlayBottom) {
      overlay.style.bottom = overlayBottom;
      lastOverlayBottom = overlayBottom;
    }
    overlay.style.left = "50%";
    overlay.style.transform = "translateX(-50%)";
    overlay.style.maxWidth = "50%";
    overlay.style.width = "max-content";
    overlay.style.textAlign = "left";
    overlay.style.zIndex = "9999";
    overlay.style.pointerEvents = "none";
    overlay.style.fontSize = `${currentStyle.fontSize}px`;
    overlay.style.color = currentStyle.textColor;
    overlay.style.textShadow =
      "1px 1px 2px black, -1px -1px 2px black, 1px -1px 2px black, -1px 1px 2px black"; // Text stroke effect
    const opacity = currentStyle.bgOpacity / 100;
    overlay.style.backgroundColor = `rgba(0, 0, 0, ${opacity})`;
    overlay.style.padding = "5px 10px";
    overlay.style.borderRadius = "5px";
    overlay.style.display = translationEnabled ? "flex" : "none";
    overlay.style.flexDirection = "column";
    overlay.style.alignItems = "flex-start";
  }
}

function getMeasurer() {
  let measurer = document.getElementById("yt-translate-measurer");
  if (!measurer) {
    measurer = document.createElement("div");
    measurer.id = "yt-translate-measurer";
    measurer.style.cssText =
      "position:absolute;visibility:hidden;pointer-events:none;white-space:pre-wrap;word-break:break-word;text-align:left;";
    document.body.appendChild(measurer);
  }
  return measurer;
}

function trimFirstVisualLine(text, referenceEl, lineHeight) {
  if (!text || !referenceEl) return text;
  const measurer = getMeasurer();
  measurer.style.width = (referenceEl.offsetWidth || 400) + "px";
  measurer.style.fontSize = referenceEl.style.fontSize;
  measurer.style.lineHeight = lineHeight + "px";

  // Binary search: find the last char index that fits on exactly 1 line
  let lo = 1, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    measurer.textContent = text.slice(0, mid);
    if (measurer.scrollHeight <= lineHeight + 2) lo = mid;
    else hi = mid - 1;
  }

  // Advance to next word boundary
  let cut = lo;
  while (cut < text.length && text[cut] !== " ") cut++;
  while (cut < text.length && text[cut] === " ") cut++;

  return cut < text.length ? text.slice(cut) : "";
}

function animateLineShift(origInner, transInner, sourceLineH, targetLineH) {
  const DURATION = 250;
  if (origInner && !hideSourceText) {
    origInner.style.transition = `transform ${DURATION}ms ease`;
    origInner.style.transform = `translateY(-${sourceLineH}px)`;
  }
  if (transInner) {
    transInner.style.transition = `transform ${DURATION}ms ease`;
    transInner.style.transform = `translateY(-${targetLineH}px)`;
  }

  setTimeout(() => {
    if (origInner && !hideSourceText) {
      rollingOriginal = trimFirstVisualLine(rollingOriginal, origInner, sourceLineH);
      origInner.style.transition = "none";
      origInner.style.transform = "";
      origInner.textContent = rollingOriginal;
    }
    if (transInner) {
      rollingTranslated = trimFirstVisualLine(rollingTranslated, transInner, targetLineH);
      transInner.style.transition = "none";
      transInner.style.transform = "";
      transInner.textContent = rollingTranslated;
    }
    isLineShiftAnimating = false;

    // Re-render with the latest rolling buffers (may have grown during animation)
    if (pendingDisplayUpdate) {
      pendingDisplayUpdate = false;
      updateOverlayText(rollingOriginal, rollingTranslated, true);
    }
  }, DURATION + 10);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function updateOverlayText(original, translated, triggerOverflowCheck = false) {
  if (isLineShiftAnimating) {
    // Don't store a snapshot — just flag that a re-render is needed after animation.
    // rollingOriginal / rollingTranslated are always current.
    pendingDisplayUpdate = true;
    return;
  }

  const overlay = document.getElementById("yt-translate-overlay");
  if (!overlay) return;
  if (!translationEnabled) { overlay.style.display = "none"; return; }

  const baseSize = Number(currentStyle.fontSize || 24);
  const sourceSize = Math.max(10, Math.round(baseSize * sourceTextFactor));
  const targetSize = Math.max(12, Math.round(baseSize * targetTextFactor));
  const sourceLineH = Math.round(sourceSize * 1.4);
  const targetLineH = Math.round(targetSize * 1.4);
  const sourceBold = boldText === "source" || boldText === "both";
  const targetBold = boldText === "target" || boldText === "both";

  // Build wrapper structure once
  let origWrapper = document.getElementById("yt-original-wrapper");
  let origInner = document.getElementById("yt-original-inner");
  let transWrapper = document.getElementById("yt-translated-wrapper");
  let transInner = document.getElementById("yt-translated-inner");

  if (!transInner) {
    overlay.innerHTML = "";
    isLineShiftAnimating = false;
    if (!hideSourceText) {
      origWrapper = document.createElement("div");
      origWrapper.id = "yt-original-wrapper";
      origInner = document.createElement("div");
      origInner.id = "yt-original-inner";
      origWrapper.appendChild(origInner);
      overlay.appendChild(origWrapper);
    }
    transWrapper = document.createElement("div");
    transWrapper.id = "yt-translated-wrapper";
    transInner = document.createElement("div");
    transInner.id = "yt-translated-inner";
    transWrapper.appendChild(transInner);
    overlay.appendChild(transWrapper);
  }

  // Update wrapper sizes & visibility
  if (origWrapper) {
    origWrapper.style.overflow = "hidden";
    origWrapper.style.width = "100%";
    origWrapper.style.marginBottom = "4px";
    origWrapper.style.height = 2 * sourceLineH + "px";
    origWrapper.style.display = hideSourceText ? "none" : "block";
  }
  if (transWrapper) {
    transWrapper.style.overflow = "hidden";
    transWrapper.style.width = "100%";
    transWrapper.style.height = 2 * targetLineH + "px";
  }

  // Update inner styles & content (don't touch transform — animation owns it)
  if (origInner) {
    origInner.style.fontSize = sourceSize + "px";
    origInner.style.opacity = sourceBold ? "1" : "0.7";
    origInner.style.fontWeight = sourceBold ? "bold" : "normal";
    origInner.style.lineHeight = sourceLineH + "px";
    origInner.style.whiteSpace = "pre-wrap";
    origInner.style.wordBreak = "break-word";
    origInner.textContent = original;
  }
  if (transInner) {
    transInner.style.fontSize = targetSize + "px";
    transInner.style.opacity = targetBold ? "1" : "0.7";
    transInner.style.fontWeight = targetBold ? "bold" : "normal";
    transInner.style.lineHeight = targetLineH + "px";
    transInner.style.whiteSpace = "pre-wrap";
    transInner.style.wordBreak = "break-word";
    transInner.textContent = translated;
  }

  // Only check overflow at segment boundaries to avoid mid-word animation
  if (triggerOverflowCheck && !isLineShiftAnimating) {
    const origOverflows = origInner && !hideSourceText && origInner.scrollHeight > 2 * sourceLineH + 2;
    const transOverflows = transInner && transInner.scrollHeight > 2 * targetLineH + 2;
    if (origOverflows || transOverflows) {
      isLineShiftAnimating = true;
      animateLineShift(
        origOverflows ? origInner : null,
        transOverflows ? transInner : null,
        sourceLineH,
        targetLineH,
      );
    }
  }
}

function clearOverlayText() {
  const overlay = document.getElementById("yt-translate-overlay");
  if (overlay) {
    overlay.innerHTML = "";
  }
  rollingOriginal = "";
  rollingTranslated = "";
  lastSegOriginal = "";
  lastSegTranslated = "";
  isLineShiftAnimating = false;
  pendingDisplayUpdate = false;
}

function hideOverlay() {
  const overlay = document.getElementById("yt-translate-overlay");
  if (overlay) {
    overlay.style.display = "none";
  }
}

async function translateText(text) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: "translate",
        text: text,
        sourceLang: currentSourceLang,
        targetLang: currentTargetLang,
      },
      (response) => {
        resolve(response ? response.translatedText : text);
      },
    );
  });
}

function speakText(text) {
  if (!readAloudEnabled) return;
  chrome.runtime.sendMessage({
    action: "speak",
    text: text,
    lang: currentTargetLang,
  });
}

function setupObserver() {
  teardownPlayerUiTracking();

  const captionContainer = document.querySelector(
    ".ytp-caption-window-container",
  );
  const player = document.querySelector("#movie_player");
  const videoEl = document.querySelector("video");

  bindPlayerUiTracking(player, videoEl);

  if (!captionContainer) {
    refreshOverlayPositionSoon();
    setTimeout(setupObserver, 1000);
    return;
  }

  captionObserver = new MutationObserver(async (mutations) => {
    if (!isTranslating) return;
    if (!translationEnabled) {
      restoreOriginalCaptions();
      return;
    }

    let currentText = "";
    const segments = captionContainer.querySelectorAll(".ytp-caption-segment");
    segments.forEach((seg) => {
      currentText += seg.textContent + " ";
    });
    currentText = currentText.trim();

    if (currentText && currentText !== lastOriginalText) {
      const prevSeg = lastSegOriginal;
      // Growing = the new text is an extension of the previous caption text
      const isGrowing = !!prevSeg && currentText.startsWith(prevSeg);

      if (isGrowing) {
        // ── Word added to current segment ──────────────────────────────────
        // Append only the delta (new words) so animation-trimmed rollingOriginal
        // is never overwritten with a stale full-segment reconstruction.
        const addition = currentText.slice(prevSeg.length).trimStart();
        lastOriginalText = currentText;
        lastSegOriginal = currentText;

        if (addition) {
          rollingOriginal = rollingOriginal
            ? rollingOriginal + " " + addition
            : addition;
          // Update original line immediately — no translation, no flicker
          updateOverlayText(rollingOriginal, rollingTranslated, true);
        }
      } else {
        // ── New segment detected ────────────────────────────────────────────
        // prevSeg (if any) is now fully complete — translate it.
        // currentText is the first word(s) of the brand-new segment.
        lastOriginalText = currentText;
        lastSegOriginal = currentText;

        // Show the new segment's first word(s) in the original line immediately
        rollingOriginal = rollingOriginal
          ? rollingOriginal + " " + currentText
          : currentText;
        updateOverlayText(rollingOriginal, rollingTranslated, true);

        if (prevSeg) {
          // Fire-and-forget: translate the completed segment, then update
          // the translated line. Original line keeps growing independently.
          (async () => {
            const translated = await translateText(prevSeg);
            lastSegTranslated = translated;
            rollingTranslated = rollingTranslated
              ? rollingTranslated + " " + translated
              : translated;
            updateOverlayText(rollingOriginal, rollingTranslated, true);
            speakText(translated);

            const vid = document.querySelector("video");
            const t = vid ? vid.currentTime : 0;
            translatedHistory.push({
              start: t,
              end: t + 2,
              original: prevSeg,
              translated,
            });
          })();
        }
      }

      hideOriginalCaptions();
    } else if (!currentText && lastOriginalText !== "") {
      // Captions cleared — commit the last in-progress segment to history
      if (lastSegOriginal) {
        const finalSeg = lastSegOriginal;
        (async () => {
          const translated = await translateText(finalSeg);
          speakText(translated);
          const vid = document.querySelector("video");
          const t = vid ? vid.currentTime : 0;
          translatedHistory.push({
            start: t,
            end: t + 2,
            original: finalSeg,
            translated,
          });
        })();
      }
      clearOverlayText();
      lastOriginalText = "";
    }
  });

  captionObserver.observe(captionContainer, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  refreshOverlayPositionSoon();
}

function hideOriginalCaptions() {
  let style = document.getElementById("hide-yt-captions");
  if (!style) {
    style = document.createElement("style");
    style.id = "hide-yt-captions";
    style.textContent =
      ".ytp-caption-window-container { opacity: 0 !important; pointer-events: none; }";
    document.head.appendChild(style);
  }
}

function restoreOriginalCaptions() {
  const style = document.getElementById("hide-yt-captions");
  if (style) {
    style.remove();
  }
}

function textFromTrackName(nameObj) {
  if (!nameObj) return "";
  if (typeof nameObj.simpleText === "string") return nameObj.simpleText;
  if (Array.isArray(nameObj.runs)) {
    return nameObj.runs.map((item) => item.text || "").join("");
  }
  return "";
}

function extractJsonArrayByKey(source, key) {
  const keyText = `"${key}":[`;
  const keyIndex = source.indexOf(keyText);
  if (keyIndex === -1) return null;

  const start = source.indexOf("[", keyIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function getAvailableLanguages() {
  const unique = new Map();
  const scripts = Array.from(document.querySelectorAll("script"));

  scripts.forEach((script) => {
    const text = script.textContent || "";
    if (!text.includes("captionTracks")) return;

    const arrayText = extractJsonArrayByKey(text, "captionTracks");
    if (!arrayText) return;

    try {
      const tracks = JSON.parse(arrayText);
      tracks.forEach((track) => {
        const code = track.languageCode;
        const name = textFromTrackName(track.name) || code;
        if (code && !unique.has(code)) {
          unique.set(code, { code, name });
        }
      });
    } catch (error) {
      // Ignore malformed script blocks and continue scanning.
    }
  });

  return Array.from(unique.values());
}

function formatTime(seconds) {
  const d = new Date(seconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

function generateAndDownloadSRT() {
  if (translatedHistory.length === 0) {
    alert("No captions translated yet.");
    return;
  }

  let srtContent = "";
  translatedHistory.forEach((item, index) => {
    srtContent += `${index + 1}\n`;
    srtContent += `${formatTime(item.start)} --> ${formatTime(item.end)}\n`;
    srtContent += `${item.original}\n${item.translated}\n\n`;
  });

  const blob = new Blob([srtContent], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "youtube_bilingual_subtitles.srt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
