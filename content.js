let isTranslating = false;
let translationEnabled = true;
let currentSourceLang = "auto";
let currentTargetLang = "es";
let readAloudEnabled = false;
let hideSourceText = false;
let sourceTextFactor = 0.8;
let targetTextFactor = 1.2;
let adaptiveOverlayPosition = true;
let captionObserver = null;
let playerUiObserver = null;
let playerUiListeners = [];
let playerUiUpdateTimer = null;
let translatedHistory = [];
let currentStyle = { fontSize: "24", textColor: "#ffffff", bgOpacity: "75" };
let lastOriginalText = "";
let lastOverlayBottom = "";

// Handle SPA navigation on YouTube
document.addEventListener("yt-navigate-finish", () => {
  if (isTranslating) {
    translatedHistory = [];
    lastOriginalText = "";
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
    overlay.style.textAlign = "center";
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
    overlay.style.alignItems = "center";
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function updateOverlayText(original, translated) {
  const overlay = document.getElementById("yt-translate-overlay");
  if (overlay) {
    if (!translationEnabled) {
      overlay.style.display = "none";
      return;
    }

    const baseSize = Number(currentStyle.fontSize || 24);
    const sourceSize = Math.max(10, Math.round(baseSize * sourceTextFactor));
    const targetSize = Math.max(12, Math.round(baseSize * targetTextFactor));
    const safeOriginal = escapeHtml(original);
    const safeTranslated = escapeHtml(translated);

    if (hideSourceText) {
      overlay.innerHTML = `<div class="translated-text" style="font-weight: bold; font-size: ${targetSize}px;">${safeTranslated}</div>`;
    } else {
      overlay.innerHTML = `
        <div class="original-text" style="font-size: ${sourceSize}px; opacity: 0.85; margin-bottom: 4px;">${safeOriginal}</div>
        <div class="translated-text" style="font-weight: bold; font-size: ${targetSize}px;">${safeTranslated}</div>
      `;
    }
  }
}

function clearOverlayText() {
  const overlay = document.getElementById("yt-translate-overlay");
  if (overlay) {
    overlay.innerHTML = "";
  }
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
      lastOriginalText = currentText;
      const translated = await translateText(currentText);
      updateOverlayText(currentText, translated);
      speakText(translated);

      const videoEl = document.querySelector("video");
      const currentTime = videoEl ? videoEl.currentTime : 0;
      translatedHistory.push({
        start: currentTime,
        end: currentTime + 2, // Approximation
        original: currentText,
        translated: translated,
      });

      hideOriginalCaptions();
    } else if (!currentText && lastOriginalText !== "") {
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
