let isTranslating = false;
let currentTargetLang = 'es';
let readAloudEnabled = false;
let captionObserver = null;
let translatedHistory = [];
let currentStyle = { fontSize: '24', textColor: '#ffffff', bgOpacity: '75' };
let lastOriginalText = '';

// Handle SPA navigation on YouTube
document.addEventListener('yt-navigate-finish', () => {
  if (isTranslating) {
    translatedHistory = [];
    lastOriginalText = '';
    setupObserver();
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startTranslation') {
    isTranslating = true;
    currentTargetLang = request.targetLang;
    readAloudEnabled = request.readAloud;
    setupObserver();
    createOverlay();
  } else if (request.action === 'updateStyle') {
    currentStyle = request.style;
    updateOverlayStyle();
  } else if (request.action === 'downloadSrt') {
    generateAndDownloadSRT();
  }
});

function createOverlay() {
  let overlay = document.getElementById('yt-translate-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'yt-translate-overlay';
    const player = document.querySelector('#movie_player') || document.body;
    player.appendChild(overlay);
  }
  updateOverlayStyle();
}

function updateOverlayStyle() {
  const overlay = document.getElementById('yt-translate-overlay');
  if (overlay) {
    overlay.style.position = 'absolute';
    overlay.style.bottom = '15%';
    overlay.style.left = '50%';
    overlay.style.transform = 'translateX(-50%)';
    overlay.style.textAlign = 'center';
    overlay.style.zIndex = '9999';
    overlay.style.pointerEvents = 'none';
    overlay.style.fontSize = `${currentStyle.fontSize}px`;
    overlay.style.color = currentStyle.textColor;
    overlay.style.textShadow = '1px 1px 2px black, -1px -1px 2px black, 1px -1px 2px black, -1px 1px 2px black'; // Text stroke effect
    const opacity = currentStyle.bgOpacity / 100;
    overlay.style.backgroundColor = `rgba(0, 0, 0, ${opacity})`;
    overlay.style.padding = '5px 10px';
    overlay.style.borderRadius = '5px';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
  }
}

function updateOverlayText(original, translated) {
  const overlay = document.getElementById('yt-translate-overlay');
  if (overlay) {
    overlay.innerHTML = `
      <div class="original-text" style="font-size: 0.75em; opacity: 0.85; margin-bottom: 4px;">${original}</div>
      <div class="translated-text" style="font-weight: bold;">${translated}</div>
    `;
  }
}

async function translateText(text) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: 'translate',
      text: text,
      targetLang: currentTargetLang
    }, (response) => {
      resolve(response ? response.translatedText : text);
    });
  });
}

function speakText(text) {
  if (!readAloudEnabled) return;
  chrome.runtime.sendMessage({
    action: 'speak',
    text: text,
    lang: currentTargetLang
  });
}

function setupObserver() {
  if (captionObserver) {
    captionObserver.disconnect();
  }

  const captionContainer = document.querySelector('.ytp-caption-window-container');
  if (!captionContainer) {
    setTimeout(setupObserver, 1000);
    return;
  }

  captionObserver = new MutationObserver(async (mutations) => {
    if (!isTranslating) return;

    let currentText = '';
    const segments = captionContainer.querySelectorAll('.ytp-caption-segment');
    segments.forEach(seg => {
      currentText += seg.textContent + ' ';
    });
    currentText = currentText.trim();

    if (currentText && currentText !== lastOriginalText) {
      lastOriginalText = currentText;
      const translated = await translateText(currentText);
      updateOverlayText(currentText, translated);
      speakText(translated);
      
      const videoEl = document.querySelector('video');
      const currentTime = videoEl ? videoEl.currentTime : 0;
      translatedHistory.push({
        start: currentTime,
        end: currentTime + 2, // Approximation
        original: currentText,
        translated: translated
      });
      
      hideOriginalCaptions();
    } else if (!currentText && lastOriginalText !== '') {
      const overlay = document.getElementById('yt-translate-overlay');
      if (overlay) overlay.innerHTML = '';
      lastOriginalText = '';
    }
  });

  captionObserver.observe(captionContainer, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function hideOriginalCaptions() {
  let style = document.getElementById('hide-yt-captions');
  if (!style) {
    style = document.createElement('style');
    style.id = 'hide-yt-captions';
    style.textContent = '.ytp-caption-window-container { opacity: 0 !important; pointer-events: none; }';
    document.head.appendChild(style);
  }
}

function formatTime(seconds) {
  const d = new Date(seconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss},${ms}`;
}

function generateAndDownloadSRT() {
  if (translatedHistory.length === 0) {
    alert("No captions translated yet.");
    return;
  }
  
  let srtContent = '';
  translatedHistory.forEach((item, index) => {
    srtContent += `${index + 1}\n`;
    srtContent += `${formatTime(item.start)} --> ${formatTime(item.end)}\n`;
    srtContent += `${item.original}\n${item.translated}\n\n`;
  });

  const blob = new Blob([srtContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'youtube_bilingual_subtitles.srt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
