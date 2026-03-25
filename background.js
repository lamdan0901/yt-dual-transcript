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

            sendResponse({ translatedText: translatedText });
          })
          .catch((error) => {
            console.error("Translation error:", error);
            sendResponse({ translatedText: request.text });
          });
      }
    });

    return true;
  } else if (request.action === "speak") {
    chrome.tts.speak(request.text, { lang: request.lang, enqueue: true });
    sendResponse({ success: true });
  } else if (request.action === "startSttTabCapture") {
    // Placeholder for Soniox STT setup
    // In MV3, capturing tab audio requires activeTab and tabCapture permissions
    // Usually, you'd use chrome.tabCapture.getMediaStreamId and send it to an offscreen document or handle via native messaging.
    console.log("STT requested with Soniox Key:", request.sonioxKey);
    // STT implementation logic goes here using the Soniox websocket API
  }
});
