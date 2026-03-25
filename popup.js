document.addEventListener("DOMContentLoaded", () => {
  const translationEnabled = document.getElementById("translation-enabled");
  const sourceLang = document.getElementById("source-lang");
  const targetLang = document.getElementById("target-lang");
  const translateBtn = document.getElementById("translate-btn");
  const readAloud = document.getElementById("read-aloud");
  const ttsProvider = document.getElementById("tts-provider");
  const azureVoiceName = document.getElementById("azure-voice-name");
  const hideSourceText = document.getElementById("hide-source-text");
  const adaptiveOverlayPosition = document.getElementById(
    "adaptive-overlay-position",
  );
  const sonioxKey = document.getElementById("soniox-key");
  const azureSpeechKey = document.getElementById("azure-speech-key");
  const azureSpeechRegion = document.getElementById("azure-speech-region");
  const fontSize = document.getElementById("font-size");
  const fontSizeValue = document.getElementById("font-size-value");
  const textColor = document.getElementById("text-color");
  const bgOpacity = document.getElementById("bg-opacity");
  const bgOpacityValue = document.getElementById("bg-opacity-value");
  const sourceSizeFactor = document.getElementById("source-size-factor");
  const sourceSizeValue = document.getElementById("source-size-value");
  const targetSizeFactor = document.getElementById("target-size-factor");
  const targetSizeValue = document.getElementById("target-size-value");
  const boldBtns = document.querySelectorAll(".bold-btn");
  const downloadSrtBtn = document.getElementById("download-srt-btn");
  const startSttBtn = document.getElementById("start-stt-btn");
  let preferredSourceLang = "auto";
  let boldText = "target";
  let availableAzureVoices = [];

  function normalizeLangTag(lang) {
    if (!lang || typeof lang !== "string") return "";
    const parts = lang.trim().replace(/_/g, "-").split("-").filter(Boolean);
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

  function getVoiceDisplayName(voice) {
    const locale = voice.Locale || voice.locale || "";
    const name = voice.ShortName || voice.shortName || voice.voiceName || "";
    const gender = voice.Gender || voice.gender || "";
    return [name, locale, gender].filter(Boolean).join(" • ");
  }

  function getFilteredAzureVoices(lang) {
    const normalized = normalizeLangTag(lang);
    const base = normalized.split("-")[0];
    return availableAzureVoices.filter((voice) => {
      const locale = normalizeLangTag(voice.Locale || voice.locale);
      return locale === normalized || locale.split("-")[0] === base;
    });
  }

  function updateAzureVoiceOptions() {
    const selectedValue = azureVoiceName.value;
    const voices = getFilteredAzureVoices(targetLang.value);
    azureVoiceName.innerHTML = "";

    const autoOption = document.createElement("option");
    autoOption.value = "";
    autoOption.textContent = voices.length
      ? "Auto Select for Target Language"
      : "No Azure voices available for this language";
    azureVoiceName.appendChild(autoOption);

    voices
      .sort((a, b) =>
        getVoiceDisplayName(a).localeCompare(getVoiceDisplayName(b)),
      )
      .forEach((voice) => {
        const option = document.createElement("option");
        option.value = voice.ShortName || voice.shortName || "";
        option.textContent = getVoiceDisplayName(voice);
        azureVoiceName.appendChild(option);
      });

    const hasSelectedVoice = Array.from(azureVoiceName.options).some(
      (option) => option.value === selectedValue,
    );
    azureVoiceName.value = hasSelectedVoice ? selectedValue : "";
    azureVoiceName.disabled = ttsProvider.value !== "azure";
  }

  function refreshAzureVoices() {
    const key = azureSpeechKey.value.trim();
    const region = azureSpeechRegion.value.trim();

    if (!key || !region) {
      availableAzureVoices = [];
      updateAzureVoiceOptions();
      return;
    }

    chrome.runtime.sendMessage(
      {
        action: "getAzureVoices",
        key,
        region,
      },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (!response || !response.success || !Array.isArray(response.voices)) {
          availableAzureVoices = [];
          updateAzureVoiceOptions();
          return;
        }

        availableAzureVoices = response.voices;
        updateAzureVoiceOptions();
      },
    );
  }

  boldBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      boldBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      boldText = btn.dataset.value;
      saveSettings();
    });
  });

  function setValueLabels() {
    fontSizeValue.textContent = `${fontSize.value}px`;
    bgOpacityValue.textContent = `${bgOpacity.value}%`;
    sourceSizeValue.textContent = `${Number(sourceSizeFactor.value).toFixed(1)}x`;
    targetSizeValue.textContent = `${Number(targetSizeFactor.value).toFixed(1)}x`;
  }

  function updateEnabledUiState() {
    const enabled = translationEnabled.checked;
    translateBtn.disabled = !enabled;
    translateBtn.style.opacity = enabled ? "1" : "0.6";
  }

  function getActiveTabId(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        callback(null);
        return;
      }
      callback(tabs[0].id);
    });
  }

  function requestAvailableSourceLanguages() {
    getActiveTabId((tabId) => {
      if (!tabId) return;
      chrome.tabs.sendMessage(
        tabId,
        { action: "getAvailableLanguages" },
        (response) => {
          if (chrome.runtime.lastError) return;
          if (!response || !Array.isArray(response.languages)) return;

          const currentValue =
            preferredSourceLang || sourceLang.value || "auto";
          sourceLang.innerHTML = "";

          const autoOption = document.createElement("option");
          autoOption.value = "auto";
          autoOption.textContent = "Auto Detect";
          sourceLang.appendChild(autoOption);

          response.languages.forEach((langItem) => {
            const option = document.createElement("option");
            option.value = langItem.code;
            option.textContent = langItem.name;
            sourceLang.appendChild(option);
          });

          sourceLang.value = Array.from(sourceLang.options).some(
            (o) => o.value === currentValue,
          )
            ? currentValue
            : "auto";
          preferredSourceLang = sourceLang.value;
        },
      );
    });
  }

  function collectSettings() {
    return {
      translationEnabled: translationEnabled.checked,
      sourceLang: sourceLang.value,
      targetLang: targetLang.value,
      readAloud: readAloud.checked,
      ttsProvider: ttsProvider.value,
      azureVoiceName: azureVoiceName.value,
      hideSourceText: hideSourceText.checked,
      adaptiveOverlayPosition: adaptiveOverlayPosition.checked,
      sourceTextFactor: Number(sourceSizeFactor.value),
      targetTextFactor: Number(targetSizeFactor.value),
      boldText,
      sonioxKey: sonioxKey.value,
      azureSpeechKey: azureSpeechKey.value.trim(),
      azureSpeechRegion: azureSpeechRegion.value.trim(),
      style: {
        fontSize: fontSize.value,
        textColor: textColor.value,
        bgOpacity: bgOpacity.value,
      },
    };
  }

  // Load saved settings
  chrome.storage.local.get(
    [
      "translationEnabled",
      "sourceLang",
      "targetLang",
      "readAloud",
      "ttsProvider",
      "azureVoiceName",
      "hideSourceText",
      "adaptiveOverlayPosition",
      "sourceTextFactor",
      "targetTextFactor",
      "sonioxKey",
      "azureSpeechKey",
      "azureSpeechRegion",
      "boldText",
      "style",
    ],
    (res) => {
      if (res.translationEnabled !== undefined) {
        translationEnabled.checked = res.translationEnabled;
      }
      if (res.sourceLang) {
        sourceLang.value = res.sourceLang;
        preferredSourceLang = res.sourceLang;
      }
      if (res.targetLang) targetLang.value = res.targetLang;
      if (res.readAloud !== undefined) readAloud.checked = res.readAloud;
      if (res.ttsProvider) ttsProvider.value = res.ttsProvider;
      if (res.azureVoiceName) azureVoiceName.value = res.azureVoiceName;
      if (res.hideSourceText !== undefined)
        hideSourceText.checked = res.hideSourceText;
      if (res.adaptiveOverlayPosition !== undefined) {
        adaptiveOverlayPosition.checked = res.adaptiveOverlayPosition;
      }
      if (res.sourceTextFactor !== undefined)
        sourceSizeFactor.value = String(res.sourceTextFactor);
      if (res.targetTextFactor !== undefined)
        targetSizeFactor.value = String(res.targetTextFactor);
      if (res.sonioxKey) {
        sonioxKey.value = res.sonioxKey;
        startSttBtn.style.display = "block";
      }
      if (res.azureSpeechKey) azureSpeechKey.value = res.azureSpeechKey;
      if (res.azureSpeechRegion) azureSpeechRegion.value = res.azureSpeechRegion;
      if (res.boldText) {
        boldText = res.boldText;
        boldBtns.forEach((b) => {
          b.classList.toggle("active", b.dataset.value === res.boldText);
        });
      }
      if (res.style) {
        if (res.style.fontSize) fontSize.value = res.style.fontSize;
        if (res.style.textColor) textColor.value = res.style.textColor;
        if (res.style.bgOpacity) bgOpacity.value = res.style.bgOpacity;
      }

      setValueLabels();
      updateEnabledUiState();
      refreshAzureVoices();
    },
  );

  const saveSettings = () => {
    const settings = collectSettings();
    preferredSourceLang = settings.sourceLang;

    chrome.storage.local.set({
      translationEnabled: settings.translationEnabled,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      readAloud: settings.readAloud,
      ttsProvider: settings.ttsProvider,
      azureVoiceName: settings.azureVoiceName,
      hideSourceText: settings.hideSourceText,
      adaptiveOverlayPosition: settings.adaptiveOverlayPosition,
      sourceTextFactor: settings.sourceTextFactor,
      targetTextFactor: settings.targetTextFactor,
      sonioxKey: settings.sonioxKey,
      azureSpeechKey: settings.azureSpeechKey,
      azureSpeechRegion: settings.azureSpeechRegion,
      boldText: settings.boldText,
      style: settings.style,
    });

    setValueLabels();
    updateEnabledUiState();
    updateAzureVoiceOptions();

    if (sonioxKey.value) {
      startSttBtn.style.display = "block";
    } else {
      startSttBtn.style.display = "none";
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;

      chrome.tabs.sendMessage(tabs[0].id, {
        action: "updateSettings",
        settings,
      });

      chrome.tabs.sendMessage(tabs[0].id, {
        action: "toggleTranslation",
        enabled: settings.translationEnabled,
      });
    });
  };

  translationEnabled.addEventListener("change", saveSettings);
  sourceLang.addEventListener("change", saveSettings);
  targetLang.addEventListener("change", saveSettings);
  readAloud.addEventListener("change", saveSettings);
  ttsProvider.addEventListener("change", saveSettings);
  azureVoiceName.addEventListener("change", saveSettings);
  hideSourceText.addEventListener("change", saveSettings);
  adaptiveOverlayPosition.addEventListener("change", saveSettings);
  sonioxKey.addEventListener("input", saveSettings);
  azureSpeechKey.addEventListener("input", () => {
    refreshAzureVoices();
    saveSettings();
  });
  azureSpeechRegion.addEventListener("input", () => {
    refreshAzureVoices();
    saveSettings();
  });
  fontSize.addEventListener("input", saveSettings);
  textColor.addEventListener("input", saveSettings);
  bgOpacity.addEventListener("input", saveSettings);
  sourceSizeFactor.addEventListener("input", saveSettings);
  targetSizeFactor.addEventListener("input", saveSettings);

  translateBtn.addEventListener("click", () => {
    const settings = collectSettings();
    saveSettings();

    if (!settings.translationEnabled) {
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;

      chrome.tabs.sendMessage(tabs[0].id, {
        action: "startTranslation",
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        readAloud: settings.readAloud,
        ttsProvider: settings.ttsProvider,
        azureVoiceName: settings.azureVoiceName,
        hideSourceText: settings.hideSourceText,
        adaptiveOverlayPosition: settings.adaptiveOverlayPosition,
        sourceTextFactor: settings.sourceTextFactor,
        targetTextFactor: settings.targetTextFactor,
        style: settings.style,
        translationEnabled: settings.translationEnabled,
      });
    });
  });

  downloadSrtBtn.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "downloadSrt" });
      }
    });
  });

  startSttBtn.addEventListener("click", () => {
    saveSettings();
    chrome.runtime.sendMessage({
      action: "startSttTabCapture",
      sonioxKey: sonioxKey.value,
    });
  });

  requestAvailableSourceLanguages();
  refreshAzureVoices();
});
