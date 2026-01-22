// 飞书文档内容脚本
// 用于从飞书文档页面提取信息并监听插件消息

console.log('飞书文档内容读取器已加载');

// 从页面获取文档ID
function getDocumentIdFromPage() {
  // 方法1: 从URL获取
  const urlMatch = window.location.pathname.match(/\/docx\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  // 方法2: 从window对象获取（飞书可能会在全局存储）
  if (window.__doc_id__) {
    return window.__doc_id__;
  }

  // 方法3: 从页面的data属性获取
  const docElement = document.querySelector('[data-doc-id]');
  if (docElement) {
    return docElement.getAttribute('data-doc-id');
  }

  // 方法4: 从meta标签获取
  const metaTag = document.querySelector('meta[name="doc-id"]');
  if (metaTag) {
    return metaTag.getAttribute('content');
  }

  return null;
}

// 尝试从页面DOM直接提取文档内容
// 这是一个备用方案，当API不可用时使用
function extractContentFromDOM() {
  const content = {
    title: '',
    blocks: []
  };

  // 获取文档标题
  const titleElement = document.querySelector('.docs-title-input, [data-title], .doc-title');
  if (titleElement) {
    content.title = titleElement.textContent || titleElement.value || '';
  }

  // 获取文档内容区域
  const contentElements = document.querySelectorAll('[data-block-type], .doc-content, .docs-content');

  contentElements.forEach(el => {
    const blockType = el.getAttribute('data-block-type') || 'text';
    const text = el.textContent || '';

    if (text.trim()) {
      content.blocks.push({
        type: blockType,
        text: text
      });
    }
  });

  return content;
}

// 监听来自插件的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getDocumentId') {
    const documentId = getDocumentIdFromPage();
    sendResponse({ documentId });
  } else if (request.action === 'extractContent') {
    const content = extractContentFromDOM();
    sendResponse(content);
  }
  return true;
});

// 页面加载完成后通知background
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const docId = getDocumentIdFromPage();
    if (docId) {
      console.log('检测到飞书文档ID:', docId);
      chrome.runtime.sendMessage({
        action: 'documentLoaded',
        documentId: docId,
        url: window.location.href
      });
    }
  });
} else {
  const docId = getDocumentIdFromPage();
  if (docId) {
    console.log('检测到飞书文档ID:', docId);
    chrome.runtime.sendMessage({
      action: 'documentLoaded',
      documentId: docId,
      url: window.location.href
    });
  }
}

// 监听URL变化（单页应用可能会改变URL而不刷新页面）
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    const docId = getDocumentIdFromPage();
    if (docId) {
      console.log('URL变化，检测到飞书文档ID:', docId);
      chrome.runtime.sendMessage({
        action: 'documentLoaded',
        documentId: docId,
        url: url
      });
    }
  }
}).observe(document, { subtree: true, childList: true });
