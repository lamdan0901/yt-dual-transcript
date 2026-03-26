let isTranslating = false;
let translationEnabled = true;
let currentSourceLang = "auto";
let currentTargetLang = "es";
let readAloudEnabled = false;
let currentTtsProvider = "azure";
let currentAzureVoiceName = "";
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
let segmentStableTimer = null; // fires translation when segment stops changing
let lastSegTranslated = "";
let isLineShiftAnimating = false;
let pendingDisplayUpdate = false; // flag: re-render after animation ends
let ttsSessionId = createTtsSessionId();
let ttsChunkSeq = 0;
let pendingSpeechSegments = [];
let speechBufferStartedAt = 0;
let speechBufferUpdatedAt = 0;
let speechSoftFlushTimer = null;
let speechHardFlushTimer = null;
let cloudAudioQueue = [];
let cloudAudioUrl = null;
let cloudAudioPlayer = null;
let isCloudAudioPlaying = false;
let pendingCloudAudio = new Map();
let nextCloudChunkId = 1;
let recentCommittedSegments = new Map();
let lastQueuedSpeechText = "";
let lastQueuedSpeechAt = 0;
let transcriptIdleTimer = null;
let lastPlaybackPaused = false;
let lastPlaybackSeeking = false;
let recentSpokenChunks = [];

const SEGMENT_DEDUPE_MS = 2500;
const SPEECH_DEDUPE_MS = 3000;
const TTS_TRANSCRIPT_IDLE_MS = 1500;
const SPOKEN_CHUNK_MEMORY_MS = 12000;
const MIN_TRIMMED_SPEECH_WORDS = 2;
const SPEECH_SOFT_FLUSH_MS = 900;
const SPEECH_HARD_FLUSH_MS = 2400;
const SPEECH_MAX_CHARS = 220;

// Handle SPA navigation on YouTube
document.addEventListener("yt-navigate-finish", () => {
  if (isTranslating) {
    translatedHistory = [];
    lastOriginalText = "";
    rollingOriginal = "";
    rollingTranslated = "";
    lastSegOriginal = "";
    lastSegTranslated = "";
    clearSegmentStableTimer();
    isLineShiftAnimating = false;
    pendingDisplayUpdate = false;
    resetSpeechSession("navigation", true);
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
    currentTtsProvider = request.ttsProvider || "azure";
    currentAzureVoiceName = request.azureVoiceName || "";
    hideSourceText = Boolean(request.hideSourceText);
    sourceTextFactor = Number(request.sourceTextFactor || 0.8);
    targetTextFactor = Number(request.targetTextFactor || 1.2);
    boldText = request.boldText || "target";
    adaptiveOverlayPosition = request.adaptiveOverlayPosition !== false;
    if (request.style) {
      currentStyle = request.style;
    }

    resetSpeechSession("start-translation", true);
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
      resetSpeechSession("translation-enabled", true);
      createOverlay();
      hideOriginalCaptions();
      updateOverlayStyle();
    } else {
      resetSpeechSession("translation-disabled");
      clearOverlayText();
      hideOverlay();
      restoreOriginalCaptions();
    }
  } else if (request.action === "getAvailableLanguages") {
    sendResponse({ languages: getAvailableLanguages() });
    return true;
  }
});

function createTtsSessionId() {
  return `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLangTag(lang) {
  if (!lang || typeof lang !== "string") return "";

  const parts = lang
    .trim()
    .replace(/_/g, "-")
    .split("-")
    .filter(Boolean);

  if (parts.length === 0) return "";

  return parts
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 2) return part.toUpperCase();
      if (part.length === 4) {
        return part[0].toUpperCase() + part.slice(1).toLowerCase();
      }
      return part.toLowerCase();
    })
    .join("-");
}

function clearSpeechFlushTimers() {
  if (speechSoftFlushTimer !== null) {
    window.clearTimeout(speechSoftFlushTimer);
    speechSoftFlushTimer = null;
  }

  if (speechHardFlushTimer !== null) {
    window.clearTimeout(speechHardFlushTimer);
    speechHardFlushTimer = null;
  }
}

function clearTranscriptIdleTimer() {
  if (transcriptIdleTimer !== null) {
    window.clearTimeout(transcriptIdleTimer);
    transcriptIdleTimer = null;
  }
}

function getCloudAudioPlayer() {
  if (!cloudAudioPlayer) {
    cloudAudioPlayer = new Audio();
    cloudAudioPlayer.preload = "auto";
    cloudAudioPlayer.addEventListener("ended", handleCloudAudioEnded);
    cloudAudioPlayer.addEventListener("error", handleCloudAudioEnded);
  }
  return cloudAudioPlayer;
}

function revokeCloudAudioUrl() {
  if (cloudAudioUrl) {
    URL.revokeObjectURL(cloudAudioUrl);
    cloudAudioUrl = null;
  }
}

function clearCloudAudioQueue() {
  cloudAudioQueue = [];
  pendingCloudAudio = new Map();
  nextCloudChunkId = 1;
  isCloudAudioPlaying = false;
  const player = getCloudAudioPlayer();
  player.pause();
  player.removeAttribute("src");
  player.load();
  revokeCloudAudioUrl();
}

function base64ToBlob(base64, contentType = "audio/mpeg") {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType });
}

function handleCloudAudioEnded() {
  revokeCloudAudioUrl();
  isCloudAudioPlaying = false;
  playNextCloudAudio();
}

function playNextCloudAudio() {
  if (isCloudAudioPlaying || cloudAudioQueue.length === 0) return;

  const nextItem = cloudAudioQueue.shift();
  const player = getCloudAudioPlayer();
  const blob = base64ToBlob(nextItem.audioBase64, nextItem.contentType);
  cloudAudioUrl = URL.createObjectURL(blob);
  player.src = cloudAudioUrl;
  isCloudAudioPlaying = true;
  player.play().catch((error) => {
    console.error("Azure audio playback failed:", error);
    handleCloudAudioEnded();
  });
}

function enqueueCloudAudio(response) {
  if (!response || !response.audioBase64) return;
  pendingCloudAudio.set(response.chunkId, {
    audioBase64: response.audioBase64,
    contentType: response.contentType || "audio/mpeg",
  });
  queueReadyCloudAudio();
}

function queueReadyCloudAudio() {
  while (pendingCloudAudio.has(nextCloudChunkId)) {
    cloudAudioQueue.push(pendingCloudAudio.get(nextCloudChunkId));
    pendingCloudAudio.delete(nextCloudChunkId);
    nextCloudChunkId += 1;
  }
  playNextCloudAudio();
}

function skipCloudChunk(chunkId) {
  if (chunkId !== nextCloudChunkId) return;
  nextCloudChunkId += 1;
  queueReadyCloudAudio();
}

function resetPendingSpeechSegments() {
  clearSpeechFlushTimers();
  pendingSpeechSegments = [];
  speechBufferStartedAt = 0;
  speechBufferUpdatedAt = 0;
}

function pruneRecentCommittedSegments(now = Date.now()) {
  recentCommittedSegments.forEach((timestamp, key) => {
    if (now - timestamp > SEGMENT_DEDUPE_MS) {
      recentCommittedSegments.delete(key);
    }
  });
}

function markSegmentCommitted(originalText, targetLang) {
  const normalizedText = String(originalText || "").replace(/\s+/g, " ").trim();
  if (!normalizedText) return false;

  const now = Date.now();
  const commitKey = `${normalizeLangTag(targetLang)}::${normalizedText}`;
  pruneRecentCommittedSegments(now);

  const lastCommittedAt = recentCommittedSegments.get(commitKey);
  if (lastCommittedAt && now - lastCommittedAt < SEGMENT_DEDUPE_MS) {
    return false;
  }

  recentCommittedSegments.set(commitKey, now);
  return true;
}

function shouldSkipQueuedSpeech(text) {
  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  const now = Date.now();
  if (
    normalizedText &&
    normalizedText === lastQueuedSpeechText &&
    now - lastQueuedSpeechAt < SPEECH_DEDUPE_MS
  ) {
    return true;
  }

  lastQueuedSpeechText = normalizedText;
  lastQueuedSpeechAt = now;
  return false;
}

function appendTranslatedSegment(originalText, translatedText) {
  if (!markSegmentCommitted(originalText, currentTargetLang)) {
    return false;
  }

  lastSegTranslated = translatedText;
  rollingTranslated = rollingTranslated
    ? rollingTranslated + " " + translatedText
    : translatedText;
  updateOverlayText(rollingOriginal, rollingTranslated, true);

  const vid = document.querySelector("video");
  const t = vid ? vid.currentTime : 0;
  translatedHistory.push({
    start: t,
    end: t + 2,
    original: originalText,
    translated: translatedText,
  });

  return true;
}

function tokenizeSpeechText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function pruneRecentSpokenChunks(now = Date.now()) {
  recentSpokenChunks = recentSpokenChunks.filter(
    (item) => now - item.at <= SPOKEN_CHUNK_MEMORY_MS,
  );
}

function longestSuffixPrefixOverlap(prevTokens, nextTokens) {
  const maxPossible = Math.min(prevTokens.length, nextTokens.length);
  for (let size = maxPossible; size >= 1; size -= 1) {
    let matches = true;
    for (let i = 0; i < size; i += 1) {
      if (prevTokens[prevTokens.length - size + i] !== nextTokens[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

function registerSpokenChunk(text) {
  const tokens = tokenizeSpeechText(text);
  if (tokens.length === 0) return;

  const now = Date.now();
  pruneRecentSpokenChunks(now);
  recentSpokenChunks.push({ at: now, text: tokens.join(" "), tokens });
}

function reduceRepeatedSpeech(text, segmentCount = 1) {
  const original = String(text || "").replace(/\s+/g, " ").trim();
  if (!original) return "";

  const now = Date.now();
  pruneRecentSpokenChunks(now);
  const tokens = tokenizeSpeechText(original);
  if (tokens.length === 0) return "";

  let skipWholeChunk = false;
  let bestOverlap = 0;

  for (let i = recentSpokenChunks.length - 1; i >= 0; i -= 1) {
    const prev = recentSpokenChunks[i];
    if (tokens.join(" ") === prev.text) {
      skipWholeChunk = true;
      break;
    }

    const overlap = longestSuffixPrefixOverlap(prev.tokens, tokens);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
    }
  }

  if (skipWholeChunk) return "";
  if (bestOverlap <= 0) return original;
  if (segmentCount <= 1) return original;

  const originalWords = original.split(/\s+/);
  const trimmedWords = originalWords.slice(bestOverlap);
  if (trimmedWords.length < MIN_TRIMMED_SPEECH_WORDS) {
    return "";
  }

  return trimmedWords.join(" ");
}

function resetSpeechSession(reason = "reset", preserveLang = false) {
  resetPendingSpeechSegments();
  clearTranscriptIdleTimer();
  clearCloudAudioQueue();
  recentCommittedSegments = new Map();
  lastQueuedSpeechText = "";
  lastQueuedSpeechAt = 0;
  recentSpokenChunks = [];
  ttsChunkSeq = 0;
  ttsSessionId = createTtsSessionId();
  chrome.runtime.sendMessage({
    action: "resetTtsQueue",
    sessionId: ttsSessionId,
    targetLang: preserveLang ? currentTargetLang : undefined,
    reason,
  });
}

function scheduleTranscriptIdleStop() {
  clearTranscriptIdleTimer();
  transcriptIdleTimer = window.setTimeout(() => {
    if (!isTranslating || !translationEnabled || !readAloudEnabled) return;
    if (pendingSpeechSegments.length > 0) {
      flushSpeechBuffer("transcript-idle");
    }
  }, TTS_TRANSCRIPT_IDLE_MS);
}

function clearSegmentStableTimer() {
  if (segmentStableTimer) { clearTimeout(segmentStableTimer); segmentStableTimer = null; }
}

function scheduleSegmentStableTranslation() {
  clearSegmentStableTimer();
  segmentStableTimer = setTimeout(() => {
    segmentStableTimer = null;
    if (!isTranslating || !translationEnabled) return;
    if (!lastSegOriginal) return;
    const seg = lastSegOriginal;
    const requestSessionId = ttsSessionId;
    const requestTargetLang = currentTargetLang;
    (async () => {
      const translated = await translateText(seg, requestTargetLang);
      if (!isCurrentTtsContext(requestSessionId, requestTargetLang)) return;
      if (!appendTranslatedSegment(seg, translated)) return;
      speakText(translated);
    })();
  }, 400);
}

function handlePlaybackStateChange(eventName = "") {
  const videoEl = document.querySelector("video");
  const isPaused = Boolean(videoEl && videoEl.paused);
  const isSeeking = Boolean(videoEl && videoEl.seeking);

  if (
    (eventName === "seeking" || (isSeeking && !lastPlaybackSeeking)) &&
    isTranslating &&
    readAloudEnabled
  ) {
    resetSpeechSession("video-seeking", true);
  }

  if (isPaused) {
    clearTranscriptIdleTimer();
    if (!lastPlaybackPaused && isTranslating && readAloudEnabled) {
      resetSpeechSession("video-paused", true);
    }
  } else if (lastPlaybackPaused && isTranslating && translationEnabled) {
    resetSpeechSession("video-resumed", true);
  }

  lastPlaybackPaused = isPaused;
  lastPlaybackSeeking = isSeeking;
}

function getPendingSpeechText() {
  return pendingSpeechSegments
    .map((segment) => segment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldFlushSpeechNow(text) {
  if (!text) return false;
  if (/[.!?…。！？]$/.test(text)) return true;
  if (text.length >= SPEECH_MAX_CHARS) return true;
  return false;
}

function scheduleSpeechFlushTimers() {
  clearSpeechFlushTimers();
  if (pendingSpeechSegments.length === 0) return;

  const now = Date.now();
  const expectedUpdatedAt = speechBufferUpdatedAt;
  const hardDelay = Math.max(
    0,
    SPEECH_HARD_FLUSH_MS - Math.max(0, now - speechBufferStartedAt),
  );

  speechSoftFlushTimer = window.setTimeout(() => {
    if (speechBufferUpdatedAt !== expectedUpdatedAt) return;
    flushSpeechBuffer("soft-timeout");
  }, SPEECH_SOFT_FLUSH_MS);

  speechHardFlushTimer = window.setTimeout(() => {
    flushSpeechBuffer("hard-timeout");
  }, hardDelay);
}

function flushSpeechBuffer(reason = "manual") {
  clearSpeechFlushTimers();
  const text = getPendingSpeechText();
  const segmentCount = pendingSpeechSegments.length;
  if (!text || !readAloudEnabled || !translationEnabled) {
    resetPendingSpeechSegments();
    return;
  }
  const dedupedText = reduceRepeatedSpeech(text, segmentCount);
  if (!dedupedText) {
    resetPendingSpeechSegments();
    return;
  }
  if (shouldSkipQueuedSpeech(dedupedText)) {
    resetPendingSpeechSegments();
    return;
  }

  const payload = {
    action: "speak",
    text: dedupedText,
    targetLang: normalizeLangTag(currentTargetLang),
    ttsProvider: currentTtsProvider,
    azureVoiceName: currentAzureVoiceName,
    sessionId: ttsSessionId,
    chunkId: ++ttsChunkSeq,
    reason,
  };
  const requestSessionId = payload.sessionId;

  chrome.runtime.sendMessage(payload, (response) => {
    if (chrome.runtime.lastError) return;
    if (requestSessionId !== ttsSessionId) return;
    if (!response) return;
    if (response.mode === "azure-audio") {
      enqueueCloudAudio(response);
      console.debug("Transcript TTS queued via Azure", response);
    } else if (!response.success) {
      if (
        typeof response.chunkId === "number" &&
        (String(response.reason || "").startsWith("azure-") ||
          String(response.fallback || "").startsWith("azure-"))
      ) {
        skipCloudChunk(response.chunkId);
      }
      console.warn("Transcript TTS skipped", response);
    } else {
      console.debug("Transcript TTS queued", response);
    }
  });

  registerSpokenChunk(dedupedText);
  resetPendingSpeechSegments();
}

function queueSpeechText(text, options = {}) {
  if (!readAloudEnabled || !translationEnabled) return;

  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalizedText) return;

  const now = Date.now();
  pendingSpeechSegments.push({
    text: normalizedText,
    addedAt: now,
  });
  if (!speechBufferStartedAt) {
    speechBufferStartedAt = now;
  }
  speechBufferUpdatedAt = now;

  const pendingText = getPendingSpeechText();
  if (options.flush || shouldFlushSpeechNow(pendingText)) {
    flushSpeechBuffer(options.reason || "phrase-ready");
    return;
  }

  scheduleSpeechFlushTimers();
}

function applySettings(settings) {
  const previousTargetLang = currentTargetLang;
  const previousReadAloud = readAloudEnabled;
  const previousTranslationEnabled = translationEnabled;
  const previousTtsProvider = currentTtsProvider;
  const previousAzureVoiceName = currentAzureVoiceName;

  if (settings.sourceLang) currentSourceLang = settings.sourceLang;
  if (settings.targetLang) currentTargetLang = settings.targetLang;
  if (settings.readAloud !== undefined) readAloudEnabled = settings.readAloud;
  if (settings.ttsProvider) currentTtsProvider = settings.ttsProvider;
  if (settings.azureVoiceName !== undefined) {
    currentAzureVoiceName = settings.azureVoiceName;
  }
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

  const targetLangChanged =
    normalizeLangTag(previousTargetLang) !== normalizeLangTag(currentTargetLang);
  const ttsDisabled = previousReadAloud && !readAloudEnabled;
  const translationDisabled = previousTranslationEnabled && !translationEnabled;
  const ttsProviderChanged = previousTtsProvider !== currentTtsProvider;
  const azureVoiceChanged = previousAzureVoiceName !== currentAzureVoiceName;

  if (
    targetLangChanged ||
    ttsDisabled ||
    translationDisabled ||
    ttsProviderChanged ||
    azureVoiceChanged
  ) {
    resetSpeechSession(
      targetLangChanged
        ? "target-language-changed"
        : ttsDisabled
          ? "tts-disabled"
          : translationDisabled
            ? "translation-disabled"
            : ttsProviderChanged
              ? "tts-provider-changed"
              : "azure-voice-changed",
      Boolean(readAloudEnabled && translationEnabled),
    );
  }

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

  playerUiListeners.forEach(({ element, eventName, handler }) => {
    element.removeEventListener(eventName, handler);
  });
  playerUiListeners = [];

  if (playerUiUpdateTimer !== null) {
    window.clearTimeout(playerUiUpdateTimer);
    playerUiUpdateTimer = null;
  }

  clearTranscriptIdleTimer();
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
    const handler = refreshOverlayPositionSoon;
    player.addEventListener(eventName, handler, {
      passive: true,
    });
    playerUiListeners.push({ element: player, eventName, handler });
  });

  videoEvents.forEach((eventName) => {
    if (!videoEl) return;
    const handler = () => {
      refreshOverlayPositionSoon();
      handlePlaybackStateChange(eventName);
    };
    videoEl.addEventListener(eventName, handler, {
      passive: true,
    });
    playerUiListeners.push({ element: videoEl, eventName, handler });
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
  clearSegmentStableTimer();
  isLineShiftAnimating = false;
  pendingDisplayUpdate = false;
}

function hideOverlay() {
  const overlay = document.getElementById("yt-translate-overlay");
  if (overlay) {
    overlay.style.display = "none";
  }

  handlePlaybackStateChange();
}

function isCurrentTtsContext(sessionId, targetLang) {
  return (
    sessionId === ttsSessionId &&
    normalizeLangTag(targetLang) === normalizeLangTag(currentTargetLang)
  );
}

async function translateText(text, targetLangOverride = currentTargetLang) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: "translate",
        text: text,
        sourceLang: currentSourceLang,
        targetLang: targetLangOverride,
      },
      (response) => {
        resolve(response ? response.translatedText : text);
      },
    );
  });
}

function speakText(text) {
  queueSpeechText(text);
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

    scheduleTranscriptIdleStop();

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
        // Reset stable timer — segment is still growing
        scheduleSegmentStableTranslation();
      } else {
        // ── New segment detected ────────────────────────────────────────────
        // prevSeg (if any) is now fully complete — translate it.
        // currentText is the first word(s) of the brand-new segment.
        clearSegmentStableTimer();
        lastOriginalText = currentText;
        lastSegOriginal = currentText;

        // Reset overlay to show only the new segment (1:1 match with caption)
        rollingOriginal = currentText;
        rollingTranslated = "";
        updateOverlayText(rollingOriginal, rollingTranslated, true);

        if (prevSeg) {
          // Fire-and-forget: translate the completed segment, then update
          // the translated line. Original line keeps growing independently.
          (async () => {
            const requestSessionId = ttsSessionId;
            const requestTargetLang = currentTargetLang;
            const translated = await translateText(prevSeg, requestTargetLang);
            if (!isCurrentTtsContext(requestSessionId, requestTargetLang)) return;
            if (!appendTranslatedSegment(prevSeg, translated)) return;
            speakText(translated);
          })();
        }
        // Start stable timer for the new segment (handles manual transcripts
        // where the full line appears at once and never grows)
        scheduleSegmentStableTranslation();
      }

      hideOriginalCaptions();
    } else if (!currentText && lastOriginalText !== "") {
      // Captions cleared — commit the last in-progress segment to history
      clearSegmentStableTimer();
      if (lastSegOriginal) {
        const finalSeg = lastSegOriginal;
        (async () => {
          const requestSessionId = ttsSessionId;
          const requestTargetLang = currentTargetLang;
          const translated = await translateText(finalSeg, requestTargetLang);
          if (!isCurrentTtsContext(requestSessionId, requestTargetLang)) return;
          if (!appendTranslatedSegment(finalSeg, translated)) return;
          speakText(translated);
          flushSpeechBuffer("caption-clear");
        })();
      } else if (pendingSpeechSegments.length > 0) {
        flushSpeechBuffer("caption-clear");
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
