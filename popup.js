document.addEventListener('DOMContentLoaded', () => {
  const targetLang = document.getElementById('target-lang');
  const translateBtn = document.getElementById('translate-btn');
  const readAloud = document.getElementById('read-aloud');
  const sonioxKey = document.getElementById('soniox-key');
  const fontSize = document.getElementById('font-size');
  const textColor = document.getElementById('text-color');
  const bgOpacity = document.getElementById('bg-opacity');
  const downloadSrtBtn = document.getElementById('download-srt-btn');
  const startSttBtn = document.getElementById('start-stt-btn');

  // Load saved settings
  chrome.storage.local.get(['targetLang', 'readAloud', 'sonioxKey', 'style'], (res) => {
    if (res.targetLang) targetLang.value = res.targetLang;
    if (res.readAloud !== undefined) readAloud.checked = res.readAloud;
    if (res.sonioxKey) {
      sonioxKey.value = res.sonioxKey;
      startSttBtn.style.display = 'block';
    }
    if (res.style) {
      if (res.style.fontSize) fontSize.value = res.style.fontSize;
      if (res.style.textColor) textColor.value = res.style.textColor;
      if (res.style.bgOpacity) bgOpacity.value = res.style.bgOpacity;
    }
  });

  const saveSettings = () => {
    chrome.storage.local.set({
      targetLang: targetLang.value,
      readAloud: readAloud.checked,
      sonioxKey: sonioxKey.value,
      style: {
        fontSize: fontSize.value,
        textColor: textColor.value,
        bgOpacity: bgOpacity.value
      }
    });
    
    if (sonioxKey.value) {
      startSttBtn.style.display = 'block';
    } else {
      startSttBtn.style.display = 'none';
    }

    // Update style dynamically
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'updateStyle',
          style: {
            fontSize: fontSize.value,
            textColor: textColor.value,
            bgOpacity: bgOpacity.value
          }
        });
      }
    });
  };

  targetLang.addEventListener('change', saveSettings);
  readAloud.addEventListener('change', saveSettings);
  sonioxKey.addEventListener('input', saveSettings);
  fontSize.addEventListener('input', saveSettings);
  textColor.addEventListener('input', saveSettings);
  bgOpacity.addEventListener('input', saveSettings);

  translateBtn.addEventListener('click', () => {
    saveSettings();
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'startTranslation',
          targetLang: targetLang.value,
          readAloud: readAloud.checked
        });
      }
    });
  });

  downloadSrtBtn.addEventListener('click', () => {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {action: 'downloadSrt'});
      }
    });
  });
  
  startSttBtn.addEventListener('click', () => {
    saveSettings();
    chrome.runtime.sendMessage({ action: 'startSttTabCapture', sonioxKey: sonioxKey.value });
  });
});
