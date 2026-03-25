let voiceCache = null;
let voiceCacheLoadedAt = 0;

const VOICE_CACHE_TTL_MS = 30 * 1000;
const AZURE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const ttsState = {
  sessionId: null,
  targetLang: null,
  queue: [],
  isSpeaking: false,
  utteranceSeq: 0,
  lastStatus: null,
};

const AZURE_VOICE_BY_LANG = {
  ar: { locale: "ar-SA", voice: "ar-SA-ZariyahNeural" },
  de: { locale: "de-DE", voice: "de-DE-KatjaNeural" },
  en: { locale: "en-US", voice: "en-US-JennyNeural" },
  es: { locale: "es-ES", voice: "es-ES-ElviraNeural" },
  fr: { locale: "fr-FR", voice: "fr-FR-DeniseNeural" },
  hi: { locale: "hi-IN", voice: "hi-IN-SwaraNeural" },
  it: { locale: "it-IT", voice: "it-IT-IsabellaNeural" },
  ja: { locale: "ja-JP", voice: "ja-JP-NanamiNeural" },
  ko: { locale: "ko-KR", voice: "ko-KR-SunHiNeural" },
  pt: { locale: "pt-BR", voice: "pt-BR-FranciscaNeural" },
  ru: { locale: "ru-RU", voice: "ru-RU-SvetlanaNeural" },
  vi: { locale: "vi-VN", voice: "vi-VN-HoaiMyNeural" },
  zh: { locale: "zh-CN", voice: "zh-CN-XiaoxiaoNeural" },
};

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

function getBaseLang(lang) {
  const normalized = normalizeLangTag(lang);
  return normalized.split("-")[0] || "";
}

function buildVoiceKeywordSet(lang) {
  const base = getBaseLang(lang);
  const keywords = new Set([normalizeLangTag(lang), base]);

  const aliases = {
    ar: ["arabic"],
    de: ["german", "deutsch"],
    en: ["english"],
    es: ["spanish", "espanol", "español"],
    fr: ["french", "francais", "français"],
    hi: ["hindi"],
    it: ["italian", "italiano"],
    ja: ["japanese", "nihongo"],
    ko: ["korean", "hangul"],
    pt: ["portuguese", "portugues", "português"],
    ru: ["russian", "русский"],
    vi: ["vietnamese", "tieng viet", "tiếng việt"],
    zh: ["chinese", "mandarin", "cantonese"],
  };

  (aliases[base] || []).forEach((keyword) => keywords.add(keyword));
  return Array.from(keywords).filter(Boolean);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function getAzureVoiceConfig(targetLang) {
  const normalized = normalizeLangTag(targetLang);
  const base = getBaseLang(normalized);

  if (AZURE_VOICE_BY_LANG[normalized]) return AZURE_VOICE_BY_LANG[normalized];
  return AZURE_VOICE_BY_LANG[base] || null;
}

function getAzureSpeechConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["azureSpeechKey", "azureSpeechRegion"],
      (result) => {
        resolve({
          key: String(result.azureSpeechKey || "").trim(),
          region: String(result.azureSpeechRegion || "").trim().toLowerCase(),
        });
      },
    );
  });
}

async function fetchAzureVoicesList(key, region) {
  const normalizedRegion = String(region || "").trim().toLowerCase();
  if (!key || !normalizedRegion) {
    return {
      success: false,
      reason: "azure-not-configured",
      voices: [],
    };
  }

  const endpoint = `https://${normalizedRegion}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
  try {
    const response = await fetch(endpoint, {
      headers: {
        "Ocp-Apim-Subscription-Key": key,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Azure voices list error:", response.status, errorText);
      return {
        success: false,
        reason: `azure-voices-http-${response.status}`,
        voices: [],
      };
    }

    const voices = await response.json();
    return {
      success: true,
      reason: "ok",
      voices: Array.isArray(voices) ? voices : [],
    };
  } catch (error) {
    console.error("Azure voices list request failed:", error);
    return {
      success: false,
      reason: "azure-voices-request-failed",
      voices: [],
    };
  }
}

async function synthesizeAzureSpeech(text, targetLang) {
  return synthesizeAzureSpeechWithVoice(text, targetLang, "");
}

async function synthesizeAzureSpeechWithVoice(text, targetLang, preferredVoiceName) {
  const azureConfig = await getAzureSpeechConfig();
  if (!azureConfig.key || !azureConfig.region) {
    return {
      success: false,
      reason: "azure-not-configured",
      resolvedLang: normalizeLangTag(targetLang),
      voiceName: null,
      chunkId: null,
    };
  }

  let voiceConfig = getAzureVoiceConfig(targetLang);
  if (preferredVoiceName) {
    const voicesList = await fetchAzureVoicesList(
      azureConfig.key,
      azureConfig.region,
    );
    const matchedVoice = voicesList.success
      ? voicesList.voices.find(
          (voice) => (voice.ShortName || voice.shortName) === preferredVoiceName,
        )
      : null;
    const preferredLocale = normalizeLangTag(preferredVoiceName.split("-").slice(0, 2).join("-"));
    voiceConfig = {
      locale:
        normalizeLangTag(matchedVoice?.Locale || matchedVoice?.locale) ||
        preferredLocale ||
        (voiceConfig ? voiceConfig.locale : normalizeLangTag(targetLang)),
      voice: preferredVoiceName,
    };
  }
  if (!voiceConfig) {
    return {
      success: false,
      reason: "azure-voice-unavailable",
      resolvedLang: normalizeLangTag(targetLang),
      voiceName: null,
      chunkId: null,
    };
  }

  const endpoint = `https://${azureConfig.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = [
    `<speak version="1.0" xml:lang="${voiceConfig.locale}">`,
    `<voice xml:lang="${voiceConfig.locale}" name="${voiceConfig.voice}">`,
    escapeXml(text),
    "</voice>",
    "</speak>",
  ].join("");

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "Ocp-Apim-Subscription-Key": azureConfig.key,
        "X-Microsoft-OutputFormat": AZURE_OUTPUT_FORMAT,
      },
      body: ssml,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Azure TTS error:", response.status, errorText);
      return {
        success: false,
        reason: `azure-http-${response.status}`,
        resolvedLang: voiceConfig.locale,
        voiceName: voiceConfig.voice,
        chunkId: null,
      };
    }

    const audioBuffer = await response.arrayBuffer();
    return {
      success: true,
      reason: "azure-audio",
      mode: "azure-audio",
      resolvedLang: voiceConfig.locale,
      voiceName: voiceConfig.voice,
      audioBase64: arrayBufferToBase64(audioBuffer),
      contentType: "audio/mpeg",
      chunkId: null,
    };
  } catch (error) {
    console.error("Azure TTS request failed:", error);
    return {
      success: false,
      reason: "azure-request-failed",
      resolvedLang: voiceConfig.locale,
      voiceName: voiceConfig.voice,
      chunkId: null,
    };
  }
}

function getVoices() {
  const now = Date.now();
  if (voiceCache && now - voiceCacheLoadedAt < VOICE_CACHE_TTL_MS) {
    return Promise.resolve(voiceCache);
  }

  return new Promise((resolve) => {
    chrome.tts.getVoices((voices) => {
      voiceCache = Array.isArray(voices) ? voices : [];
      voiceCacheLoadedAt = Date.now();
      resolve(voiceCache);
    });
  });
}

function scoreVoiceForLang(voice, requestedLang) {
  const voiceLang = normalizeLangTag(voice.lang);
  if (!voiceLang) return Number.NEGATIVE_INFINITY;

  const normalizedRequested = normalizeLangTag(requestedLang);
  const requestedBase = getBaseLang(normalizedRequested);
  const voiceBase = getBaseLang(voiceLang);

  let score = Number.NEGATIVE_INFINITY;
  if (voiceLang === normalizedRequested) {
    score = 1000;
  } else if (voiceBase && voiceBase === requestedBase) {
    score = 700;
  } else {
    return Number.NEGATIVE_INFINITY;
  }

  const haystack = `${String(voice.voiceName || "").toLowerCase()} ${String(
    voice.extensionId || "",
  ).toLowerCase()}`;
  const keywords = buildVoiceKeywordSet(normalizedRequested);

  if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
    score += 25;
  }
  if (voice.remote === false) score += 10;
  if (Array.isArray(voice.eventTypes) && voice.eventTypes.includes("end")) {
    score += 5;
  }

  return score;
}

async function resolveVoiceForLang(requestedLang) {
  const normalizedLang = normalizeLangTag(requestedLang);
  if (!normalizedLang) {
    return {
      success: false,
      reason: "invalid-language",
      resolvedLang: "",
      voiceName: null,
      chunkId: null,
    };
  }

  const voices = await getVoices();
  let bestVoice = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  voices.forEach((voice) => {
    const score = scoreVoiceForLang(voice, normalizedLang);
    if (score > bestScore) {
      bestScore = score;
      bestVoice = voice;
    }
  });

  if (!bestVoice || bestScore === Number.NEGATIVE_INFINITY) {
    return {
      success: false,
      reason: "no-compatible-voice",
      resolvedLang: normalizedLang,
      voiceName: null,
      chunkId: null,
    };
  }

  return {
    success: true,
    reason: null,
    resolvedLang: normalizeLangTag(bestVoice.lang) || normalizedLang,
    voiceName: bestVoice.voiceName || null,
  };
}

function setLastTtsStatus(status) {
  ttsState.lastStatus = {
    ...status,
    at: new Date().toISOString(),
  };
}

function resetSpeechQueue({ sessionId = null, targetLang = null, reason = "reset" } = {}) {
  ttsState.sessionId = sessionId;
  ttsState.targetLang = normalizeLangTag(targetLang);
  ttsState.queue = [];
  ttsState.isSpeaking = false;
  ttsState.utteranceSeq += 1;
  chrome.tts.stop();
  setLastTtsStatus({
    success: true,
    reason,
    resolvedLang: ttsState.targetLang,
    voiceName: null,
  });
}

function processSpeechQueue() {
  if (ttsState.isSpeaking || ttsState.queue.length === 0) return;

  const nextItem = ttsState.queue.shift();
  const utteranceId = ++ttsState.utteranceSeq;
  ttsState.isSpeaking = true;

  chrome.tts.speak(nextItem.text, {
    enqueue: false,
    lang: nextItem.resolvedLang,
    voiceName: nextItem.voiceName || undefined,
    onEvent: (event) => {
      if (utteranceId !== ttsState.utteranceSeq) return;

      if (event.type === "end") {
        ttsState.isSpeaking = false;
        processSpeechQueue();
        return;
      }

      if (
        event.type === "interrupted" ||
        event.type === "cancelled" ||
        event.type === "error"
      ) {
        ttsState.isSpeaking = false;
        if (event.type === "error") {
          setLastTtsStatus({
            success: false,
            reason: event.errorMessage || "tts-error",
            resolvedLang: nextItem.resolvedLang,
            voiceName: nextItem.voiceName || null,
          });
        }
        processSpeechQueue();
      }
    },
  });
}

async function enqueueLocalSpeech(request, text, targetLang, sessionId, chunkId) {
  const voice = await resolveVoiceForLang(targetLang);
  if (ttsState.sessionId !== sessionId || ttsState.targetLang !== targetLang) {
    const status = {
      success: false,
      reason: "stale-session",
      resolvedLang: targetLang,
      voiceName: null,
      chunkId,
    };
    setLastTtsStatus(status);
    return status;
  }

  if (!voice.success) {
    const status = {
      success: false,
      reason: voice.reason,
      resolvedLang: voice.resolvedLang,
      voiceName: null,
      chunkId,
    };
    setLastTtsStatus(status);
    return status;
  }

  const queueItem = {
    text,
    resolvedLang: voice.resolvedLang,
    voiceName: voice.voiceName,
    chunkId,
  };
  ttsState.queue.push(queueItem);

  const status = {
    success: true,
    reason: "queued",
    resolvedLang: queueItem.resolvedLang,
    voiceName: queueItem.voiceName,
    chunkId,
  };
  setLastTtsStatus(status);
  console.debug("Queued transcript TTS", status);
  processSpeechQueue();
  return status;
}

async function enqueueSpeech(request) {
  const text = String(request.text || "").trim();
  const targetLang = normalizeLangTag(request.targetLang || request.lang);
  const sessionId = String(request.sessionId || "default");
  const chunkId = Number.isFinite(request.chunkId) ? Number(request.chunkId) : null;
  const ttsProvider = request.ttsProvider === "local" ? "local" : "azure";
  const azureVoiceName = String(request.azureVoiceName || "").trim();

  if (!text) {
    const status = {
      success: false,
      reason: "empty-text",
      resolvedLang: targetLang,
      voiceName: null,
      chunkId,
    };
    setLastTtsStatus(status);
    return status;
  }

  if (!targetLang) {
    const status = {
      success: false,
      reason: "invalid-language",
      resolvedLang: "",
      voiceName: null,
      chunkId,
    };
    setLastTtsStatus(status);
    return status;
  }

  if (ttsState.sessionId !== sessionId || ttsState.targetLang !== targetLang) {
    resetSpeechQueue({
      sessionId,
      targetLang,
      reason: "session-sync",
    });
  }

  if (ttsProvider === "azure") {
    const azureStatus = await synthesizeAzureSpeechWithVoice(
      text,
      targetLang,
      azureVoiceName,
    );
    azureStatus.chunkId = chunkId;
    if (azureStatus.success) {
      setLastTtsStatus(azureStatus);
      return azureStatus;
    }

    const localFallback = await enqueueLocalSpeech(
      request,
      text,
      targetLang,
      sessionId,
      chunkId,
    );
    if (localFallback.success) {
      localFallback.fallback = azureStatus.reason;
      setLastTtsStatus(localFallback);
      return localFallback;
    }

    const status = {
      success: false,
      reason: azureStatus.reason,
      fallback: localFallback.reason,
      resolvedLang: azureStatus.resolvedLang || localFallback.resolvedLang,
      voiceName: azureStatus.voiceName || localFallback.voiceName,
      chunkId,
    };
    setLastTtsStatus(status);
    console.warn("Azure TTS and local fallback both unavailable", status);
    return status;
  }

  return enqueueLocalSpeech(request, text, targetLang, sessionId, chunkId);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    const sourceLang = request.sourceLang || "auto";
    const cacheKey = `trans_${sourceLang}_${request.targetLang}_${request.text}`;

    chrome.storage.local.get([cacheKey], (res) => {
      if (res[cacheKey]) {
        sendResponse({ translatedText: res[cacheKey] });
      } else {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLang)}&tl=${request.targetLang}&dt=t&q=${encodeURIComponent(request.text)}`;

        fetch(url)
          .then((response) => response.json())
          .then((data) => {
            let translatedText = "";
            if (data && data[0]) {
              data[0].forEach((item) => {
                if (item[0]) translatedText += item[0];
              });
            }
            const saveObj = {};
            saveObj[cacheKey] = translatedText;
            chrome.storage.local.set(saveObj);

            sendResponse({ translatedText });
          })
          .catch((error) => {
            console.error("Translation error:", error);
            sendResponse({ translatedText: request.text });
          });
      }
    });

    return true;
  }

  if (request.action === "speak") {
    enqueueSpeech(request)
      .then((status) => sendResponse(status))
      .catch((error) => {
        console.error("TTS enqueue failed:", error);
        const status = {
          success: false,
          reason: "tts-enqueue-failed",
          resolvedLang: normalizeLangTag(request.targetLang || request.lang),
          voiceName: null,
          chunkId: Number.isFinite(request.chunkId) ? Number(request.chunkId) : null,
        };
        setLastTtsStatus(status);
        sendResponse(status);
      });
    return true;
  }

  if (request.action === "getAzureVoices") {
    fetchAzureVoicesList(request.key, request.region)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("Failed to fetch Azure voices:", error);
        sendResponse({
          success: false,
          reason: "azure-voices-request-failed",
          voices: [],
        });
      });
    return true;
  }

  if (request.action === "resetTtsQueue") {
    resetSpeechQueue({
      sessionId: request.sessionId || null,
      targetLang: request.targetLang || null,
      reason: request.reason || "reset",
    });
    sendResponse({
      success: true,
      reason: request.reason || "reset",
      resolvedLang: normalizeLangTag(request.targetLang),
      voiceName: null,
    });
    return true;
  }

  if (request.action === "getTtsStatus") {
    sendResponse({
      success: true,
      status: ttsState.lastStatus,
      queueLength: ttsState.queue.length,
      isSpeaking: ttsState.isSpeaking,
    });
    return true;
  }

  if (request.action === "startSttTabCapture") {
    console.log("STT requested with Soniox Key:", request.sonioxKey);
  }
});
