chrome.action.onClicked.addListener((tab) => {
    chrome.windows.create({
        url: chrome.runtime.getURL('popup.html?tabId=' + tab.id),
        type: 'popup',
        width: 280,
        height: 200
    });
});
