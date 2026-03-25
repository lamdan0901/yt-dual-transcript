document.addEventListener("DOMContentLoaded", () => {
  const translationEnabled = document.getElementById("translation-enabled");
  const sourceLang = document.getElementById("source-lang");
  const targetLang = document.getElementById("target-lang");
  const translateBtn = document.getElementById("translate-btn");
  const readAloud = document.getElementById("read-aloud");
  const hideSourceText = document.getElementById("hide-source-text");
  const sonioxKey = document.getElementById("soniox-key");
  const fontSize = document.getElementById("font-size");
  const fontSizeValue = document.getElementById("font-size-value");
  const textColor = document.getElementById("text-color");
  const bgOpacity = document.getElementById("bg-opacity");
  const bgOpacityValue = document.getElementById("bg-opacity-value");
  const sourceSizeFactor = document.getElementById("source-size-factor");
  const sourceSizeValue = document.getElementById("source-size-value");
  const targetSizeFactor = document.getElementById("target-size-factor");
  const targetSizeValue = document.getElementById("target-size-value");
  const downloadSrtBtn = document.getElementById("download-srt-btn");
  const startSttBtn = document.getElementById("start-stt-btn");
  let preferredSourceLang = "auto";

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
      hideSourceText: hideSourceText.checked,
      sourceTextFactor: Number(sourceSizeFactor.value),
      targetTextFactor: Number(targetSizeFactor.value),
      sonioxKey: sonioxKey.value,
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
      "hideSourceText",
      "sourceTextFactor",
      "targetTextFactor",
      "sonioxKey",
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
      if (res.hideSourceText !== undefined)
        hideSourceText.checked = res.hideSourceText;
      if (res.sourceTextFactor !== undefined)
        sourceSizeFactor.value = String(res.sourceTextFactor);
      if (res.targetTextFactor !== undefined)
        targetSizeFactor.value = String(res.targetTextFactor);
      if (res.sonioxKey) {
        sonioxKey.value = res.sonioxKey;
        startSttBtn.style.display = "block";
      }
      if (res.style) {
        if (res.style.fontSize) fontSize.value = res.style.fontSize;
        if (res.style.textColor) textColor.value = res.style.textColor;
        if (res.style.bgOpacity) bgOpacity.value = res.style.bgOpacity;
      }

      setValueLabels();
      updateEnabledUiState();
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
      hideSourceText: settings.hideSourceText,
      sourceTextFactor: settings.sourceTextFactor,
      targetTextFactor: settings.targetTextFactor,
      sonioxKey: settings.sonioxKey,
      style: settings.style,
    });

    setValueLabels();
    updateEnabledUiState();

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
  hideSourceText.addEventListener("change", saveSettings);
  sonioxKey.addEventListener("input", saveSettings);
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
        hideSourceText: settings.hideSourceText,
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
});
