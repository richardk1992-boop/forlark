// 全局变量存储文档内容
let documentContent = '';
let documentBlocks = [];

// 初始化加载配置
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  setupEventListeners();
  checkAuthStatus();

  // 监听授权状态变化
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'authStatusChanged') {
      checkAuthStatus();
    }
    if (request.action === 'showError') {
      showError(request.message);
    }
    return true;
  });
});

// 加载保存的配置
async function loadConfig() {
  const result = await chrome.storage.local.get(['appId', 'appSecret']);
  if (result.appId) {
    document.getElementById('appId').value = result.appId;
  }
  if (result.appSecret) {
    document.getElementById('appSecret').value = result.appSecret;
  }
}

// 设置事件监听
function setupEventListeners() {
  // 保存配置按钮
  document.getElementById('saveConfig').addEventListener('click', saveConfig);

  // 测试连接按钮
  document.getElementById('testConnection').addEventListener('click', testConnection);

  // 授权按钮
  document.getElementById('authorizeBtn').addEventListener('click', startAuthorization);

  // 检查权限按钮
  document.getElementById('checkPermissionsBtn').addEventListener('click', checkAppPermissions);

  // 退出登录按钮
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // 获取文档内容按钮
  document.getElementById('fetchContent').addEventListener('click', fetchDocumentContent);

  // 调试信息按钮
  document.getElementById('debugInfo').addEventListener('click', showDebugInfo);

  // 复制内容按钮
  document.getElementById('copyContent').addEventListener('click', copyContent);

  // 复制Markdown按钮
  document.getElementById('copyMarkdown').addEventListener('click', copyMarkdown);

  // 下载文件按钮
  document.getElementById('downloadFile').addEventListener('click', downloadFile);

  // 手动设置 Token 按钮
  document.getElementById('setManualToken').addEventListener('click', setManualToken);
}

// 保存配置
async function saveConfig() {
  const appId = document.getElementById('appId').value.trim();
  const appSecret = document.getElementById('appSecret').value.trim();
  const statusEl = document.getElementById('saveStatus');

  if (!appId || !appSecret) {
    showStatus('请填写完整的 App ID 和 App Secret', 'error');
    return;
  }

  await chrome.storage.local.set({ appId, appSecret });
  showStatus('配置保存成功', 'success');
  setTimeout(() => {
    statusEl.textContent = '';
  }, 2000);
}

// 显示状态信息
function showStatus(message, type) {
  const statusEl = document.getElementById('saveStatus');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

// 显示错误信息
function showError(message) {
  const errorSection = document.getElementById('errorSection');
  const errorMessage = errorSection.querySelector('.error-message');
  errorMessage.textContent = message;
  errorSection.style.display = 'block';
  setTimeout(() => {
    errorSection.style.display = 'none';
  }, 5000);
}

// 测试连接
async function testConnection() {
  const appId = document.getElementById('appId').value.trim();
  const appSecret = document.getElementById('appSecret').value.trim();
  const statusEl = document.getElementById('saveStatus');

  if (!appId || !appSecret) {
    showStatus('请先填写 App ID 和 App Secret', 'error');
    return;
  }

  showStatus('测试中...', '');
  statusEl.className = 'status';

  try {
    // 获取当前活跃标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const urlInfo = new URL(tab.url);

    // 检测区域
    let region = 'feishu';
    let apiEndpoint = 'https://open.feishu.cn';

    if (urlInfo.hostname.includes('larksuite.com') || urlInfo.hostname.includes('larkoffice.com')) {
      region = 'larksuite';
      apiEndpoint = 'https://open.larksuite.com';
    }

    console.log('测试连接到区域:', region, 'API端点:', apiEndpoint);

    // 发送测试请求到background.js
    const response = await chrome.runtime.sendMessage({
      action: 'testConnection',
      appId: appId,
      appSecret: appSecret,
      region: region,
      apiEndpoint: apiEndpoint
    });

    if (response.success) {
      showStatus(`✓ 连接成功! 应用区域: ${response.detectedRegion}`, 'success');
    } else {
      showStatus(`✗ 连接失败: ${response.error}`, 'error');
    }

  } catch (error) {
    showStatus(`✗ 测试失败: ${error.message}`, 'error');
  }

  setTimeout(() => {
    if (statusEl.textContent.includes('测试中')) {
      statusEl.textContent = '';
    }
  }, 5000);
}

// ===== 授权相关函数 =====

// 检查授权状态
async function checkAuthStatus() {
  const authIndicator = document.getElementById('authIndicator');
  const authStatusText = document.getElementById('authStatusText');
  const userInfo = document.getElementById('userInfo');
  const authorizeBtn = document.getElementById('authorizeBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  authIndicator.className = 'auth-indicator loading';
  authStatusText.textContent = '检查中...';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'checkAuthStatus' });

    if (response.authorized && response.user) {
      // 已授权
      authIndicator.className = 'auth-indicator authorized';
      authStatusText.textContent = '已授权';

      // 显示用户信息
      userInfo.style.display = 'flex';
      document.getElementById('userName').textContent = response.user.name || '未知用户';
      document.getElementById('userEmail').textContent = response.user.email || '';
      if (response.user.avatar) {
        document.getElementById('userAvatar').src = response.user.avatar;
      }

      authorizeBtn.style.display = 'none';
      logoutBtn.style.display = 'inline-block';
    } else {
      // 未授权
      authIndicator.className = 'auth-indicator unauthorized';
      authStatusText.textContent = '未授权';
      userInfo.style.display = 'none';
      authorizeBtn.style.display = 'inline-block';
      logoutBtn.style.display = 'none';
    }
  } catch (error) {
    console.error('检查授权状态失败:', error);
    authIndicator.className = 'auth-indicator unauthorized';
    authStatusText.textContent = '未授权';
    userInfo.style.display = 'none';
    authorizeBtn.style.display = 'inline-block';
    logoutBtn.style.display = 'none';
  }
}

// 启动授权流程
async function startAuthorization() {
  const config = await chrome.storage.local.get(['appId', 'appSecret']);

  if (!config.appId || !config.appSecret) {
    showError('请先配置 App ID 和 App Secret');
    return;
  }

  const authIndicator = document.getElementById('authIndicator');
  const authStatusText = document.getElementById('authStatusText');

  authIndicator.className = 'auth-indicator loading';
  authStatusText.textContent = '正在打开授权页面...';

  try {
    // 获取当前标签页URL判断区域
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const urlInfo = new URL(tab.url);

    let region = 'larksuite';
    if (urlInfo.hostname.includes('feishu.cn')) {
      region = 'feishu';
    }

    console.log('开始授权流程，区域:', region);
    console.log('当前页面URL:', tab.url);

    // 请求授权URL
    const response = await chrome.runtime.sendMessage({
      action: 'getAuthUrl',
      region: region
    });

    console.log('授权响应:', response);

    if (response.error) {
      throw new Error(response.error);
    }

    // 授权窗口会自动打开
    authStatusText.textContent = '请在打开的窗口中完成授权';
    console.log('授权窗口应该已打开');

  } catch (error) {
    console.error('启动授权失败:', error);
    showError('启动授权失败: ' + error.message);
    authIndicator.className = 'auth-indicator unauthorized';
    authStatusText.textContent = '授权失败';
  }
}

// 检查应用权限
async function checkAppPermissions() {
  const config = await chrome.storage.local.get(['appId', 'appSecret']);

  if (!config.appId || !config.appSecret) {
    showError('请先配置 App ID 和 App Secret');
    return;
  }

  // 获取当前页面URL判断区域
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const urlInfo = new URL(tab.url);

  let region = 'larksuite';
  if (urlInfo.hostname.includes('feishu.cn')) {
    region = 'feishu';
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'checkPermissions',
      appId: config.appId,
      appSecret: config.appSecret,
      region: region
    });

    if (response.error) {
      showError('权限检查失败: ' + response.error);
      return;
    }

    // 显示权限信息
    let message = '应用权限检查结果:\n\n';
    message += `App ID: ${config.appId}\n`;
    message += `应用区域: ${response.region}\n\n`;
    message += '权限状态:\n';

    if (response.permissions && response.permissions.length > 0) {
      response.permissions.forEach(perm => {
        const status = perm.status === 'approved' ? '✅ 已通过' : '⏳ 待审批';
        message += `  ${status} - ${perm.name} (${perm.key})\n`;
      });
    } else {
      message += '  未找到已配置的权限\n';
    }

    message += '\n如果显示"待审批"，请：\n';
    message += '1. 在飞书开放平台点击"申请发布"\n';
    message += '2. 等待企业管理员审批\n';
    message += '3. 或开启"测试版本"邀请自己为测试用户';

    alert(message);

  } catch (error) {
    showError('权限检查失败: ' + error.message);
  }
}

// 退出登录
async function logout() {
  if (!confirm('确定要退出登录吗？')) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({ action: 'logout' });
    // 刷新授权状态
    checkAuthStatus();
  } catch (error) {
    console.error('退出登录失败:', error);
    showError('退出登录失败: ' + error.message);
  }
}

// 手动设置 Access Token
async function setManualToken() {
  const tokenInput = document.getElementById('manualAccessToken');
  const regionSelect = document.getElementById('manualTokenRegion');

  const accessToken = tokenInput.value.trim();
  const region = regionSelect.value;

  if (!accessToken) {
    showError('请输入 Access Token');
    return;
  }

  console.log('手动设置 token:', { region, tokenLength: accessToken.length });

  try {
    // 验证 token 是否有效 - 获取用户信息
    const apiEndpoint = region === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com';

    const userInfoResponse = await fetch(`${apiEndpoint}/open-apis/authen/v1/user_info`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const userInfoData = await userInfoResponse.json();
    console.log('Token 验证响应:', userInfoData);

    if (userInfoData.code !== 0) {
      showError(`Token 无效: ${userInfoData.msg}`);
      return;
    }

    // Token 有效，存储用户信息
    const tokenInfo = {
      accessToken: accessToken,
      refreshToken: null,
      expiresAt: Date.now() + 7200 * 1000, // 默认2小时
      region: region,
      tokenType: 'user',
      user: userInfoData.data ? {
        name: userInfoData.data.name,
        email: userInfoData.data.email,
        avatar: userInfoData.data.avatar_url,
        userId: userInfoData.data.user_id
      } : null
    };

    await chrome.storage.local.set({ userToken: tokenInfo });

    // 清空输入框
    tokenInput.value = '';

    // 刷新授权状态显示
    checkAuthStatus();

    showStatus('Token 设置成功！', 'success');

    console.log('手动 token 设置成功');
  } catch (error) {
    console.error('设置 token 失败:', error);
    showError('设置 Token 失败: ' + error.message);
  }
}

// 获取文档内容
async function fetchDocumentContent() {
  const loadingEl = document.getElementById('loading');
  const contentSection = document.getElementById('contentSection');

  try {
    loadingEl.style.display = 'inline';
    contentSection.style.display = 'none';

    // 获取当前活跃标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 检查是否在飞书文档页面（支持多种URL格式）
    const isFeishuDoc = tab.url.match(/(feishu\.cn|larksuite\.com|larkoffice\.com|feishucdn\.com).*\/(docx|docs|wiki|note)/);
    const isFeishuDomain = tab.url.includes('feishu.cn') ||
                          tab.url.includes('larksuite.com') ||
                          tab.url.includes('larkoffice.com');

    // 如果既不是飞书文档格式，也不是飞书域名，则报错
    if (!isFeishuDomain) {
      showError(`当前不在飞书页面\n当前URL: ${tab.url}`);
      return;
    }

    console.log('当前页面URL:', tab.url);
    console.log('是否匹配文档格式:', isFeishuDoc);

    // 从页面获取文档ID
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: getDocumentIdFromPage
    });

    const documentId = results[0].result;

    console.log('提取到的文档ID:', documentId);

    if (!documentId) {
      showError(`无法获取文档ID\n请确保在飞书文档页面\n当前页面: ${tab.url}`);
      return;
    }

    // 获取配置
    const config = await chrome.storage.local.get(['appId', 'appSecret']);

    if (!config.appId || !config.appSecret) {
      showError('请先配置 App ID 和 App Secret');
      return;
    }

    // 发送消息到background.js获取文档内容
    const urlInfo = new URL(tab.url);
    const isInternational = urlInfo.hostname.includes('larksuite.com') || urlInfo.hostname.includes('larkoffice.com');

    console.log('当前URL:', tab.url);
    console.log('是否国际版:', isInternational);

    // 如果是国际版/新加坡版，提示用户检查应用创建位置
    if (isInternational) {
      console.warn('检测到国际版飞书文档，请确保应用是在国际版飞书开放平台创建');
    }

    const response = await chrome.runtime.sendMessage({
      action: 'fetchDocument',
      documentId: documentId,
      appId: config.appId,
      appSecret: config.appSecret,
      domain: urlInfo.hostname // 发送域名信息用于区域检测
    });

    if (response.error) {
      showError(`获取失败: ${response.error}`);
      return;
    }

    // 存储文档内容
    documentBlocks = response.blocks || [];
    documentContent = response.content || '';

    // 显示内容
    displayContent();

  } catch (error) {
    showError(`获取失败: ${error.message}`);
  } finally {
    loadingEl.style.display = 'none';
  }
}

// 在页面中获取文档ID的函数（会被注入到页面中执行）
function getDocumentIdFromPage() {
  const pathname = window.location.pathname;

  console.log('当前路径:', pathname);

  // 尝试多种URL格式的文档ID提取
  // 格式1: /docx/xxxxx 或 /docs/xxxxx
  const pathMatch = pathname.match(/\/(docx|docs|wiki|note)\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) {
    console.log('从路径提取到文档ID:', pathMatch[2]);
    return pathMatch[2];
  }

  // 格式2: /wiki/xxxxx?xxxx=xxxx
  const wikiMatch = pathname.match(/\/wiki\/([a-zA-Z0-9_-]+)/);
  if (wikiMatch) {
    console.log('从wiki路径提取到文档ID:', wikiMatch[1]);
    return wikiMatch[1];
  }

  // 尝试从URL参数获取
  const urlParams = new URLSearchParams(window.location.search);
  const urlDocId = urlParams.get('docId') || urlParams.get('doc_id') || urlParams.get('documentId');
  if (urlDocId) {
    console.log('从URL参数提取到文档ID:', urlDocId);
    return urlDocId;
  }

  // 尝试从页面数据获取
  const docElement = document.querySelector('[data-doc-id]');
  if (docElement) {
    const docId = docElement.getAttribute('data-doc-id');
    console.log('从DOM元素提取到文档ID:', docId);
    return docId;
  }

  // 尝试从meta标签获取
  const metaTag = document.querySelector('meta[name="doc-id"], meta[name="document-id"]');
  if (metaTag) {
    const docId = metaTag.getAttribute('content');
    console.log('从meta标签提取到文档ID:', docId);
    return docId;
  }

  // 尝试从window对象获取
  if (window.__doc_id__) {
    console.log('从window对象提取到文档ID:', window.__doc_id__);
    return window.__doc_id__;
  }

  // 尝试从常见飞书全局变量获取
  if (window.GLOBAL_CONFIG && window.GLOBAL_CONFIG.docId) {
    console.log('从GLOBAL_CONFIG提取到文档ID:', window.GLOBAL_CONFIG.docId);
    return window.GLOBAL_CONFIG.docId;
  }

  // 尝试从React等框架的内部状态获取
  const rootElement = document.querySelector('#root, [data-reactroot]');
  if (rootElement && rootElement.dataset) {
    const dataKey = Object.keys(rootElement.dataset).find(key =>
      key.toLowerCase().includes('doc') || key.toLowerCase().includes('article')
    );
    if (dataKey) {
      console.log('从根元素dataset提取到文档ID:', rootElement.dataset[dataKey]);
      return rootElement.dataset[dataKey];
    }
  }

  console.log('未能提取到文档ID');
  return null;
}

// 显示内容
function displayContent() {
  const format = document.getElementById('outputFormat').value;
  const contentDisplay = document.getElementById('contentDisplay');
  const contentSection = document.getElementById('contentSection');

  let displayContent = '';

  switch (format) {
    case 'markdown':
      displayContent = convertToMarkdown(documentBlocks);
      break;
    case 'html':
      displayContent = convertToHTML(documentBlocks);
      break;
    case 'text':
      displayContent = convertToText(documentBlocks);
      break;
    default:
      displayContent = documentContent;
  }

  contentDisplay.textContent = displayContent;
  contentSection.style.display = 'block';
}

// 监听格式选择变化
document.getElementById('outputFormat').addEventListener('change', () => {
  if (documentBlocks.length > 0 || documentContent) {
    displayContent();
  }
});

// 复制内容
async function copyContent() {
  const format = document.getElementById('outputFormat').value;
  const contentDisplay = document.getElementById('contentDisplay');
  const text = contentDisplay.textContent;

  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('copyContent');
    const originalText = btn.textContent;
    btn.textContent = '已复制!';
    setTimeout(() => {
      btn.textContent = originalText;
    }, 2000);
  } catch (error) {
    showError('复制失败: ' + error.message);
  }
}

// 复制Markdown
async function copyMarkdown() {
  const markdown = convertToMarkdown(documentBlocks);

  try {
    await navigator.clipboard.writeText(markdown);
    const btn = document.getElementById('copyMarkdown');
    const originalText = btn.textContent;
    btn.textContent = '已复制!';
    setTimeout(() => {
      btn.textContent = originalText;
    }, 2000);
  } catch (error) {
    showError('复制失败: ' + error.message);
  }
}

// 下载文件
function downloadFile() {
  const format = document.getElementById('outputFormat').value;
  const contentDisplay = document.getElementById('contentDisplay');
  const content = contentDisplay.textContent;

  let extension = 'txt';
  let mimeType = 'text/plain';

  switch (format) {
    case 'markdown':
      extension = 'md';
      mimeType = 'text/markdown';
      break;
    case 'html':
      extension = 'html';
      mimeType = 'text/html';
      break;
    case 'text':
      extension = 'txt';
      mimeType = 'text/plain';
      break;
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `feishu_document_${Date.now()}.${extension}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 转换为Markdown格式
function convertToMarkdown(blocks) {
  if (!blocks || blocks.length === 0) {
    return documentContent || '';
  }

  let markdown = '';

  blocks.forEach(block => {
    const blockType = block.block_type || block.type;
    const text = block.text || '';

    switch (blockType) {
      case 'page':
        if (block.page && block.page.title) {
          markdown += `# ${block.page.title}\n\n`;
        }
        break;
      case 'text':
        if (block.text_run && block.text_run.elements) {
          markdown += parseTextElements(block.text_run.elements) + '\n\n';
        } else if (text) {
          markdown += text + '\n\n';
        }
        break;
      case 'heading1':
      case 'heading_1':
        if (block.text_run && block.text_run.elements) {
          markdown += `# ${parseTextElements(block.text_run.elements)}\n\n`;
        } else {
          markdown += `# ${text}\n\n`;
        }
        break;
      case 'heading2':
      case 'heading_2':
        if (block.text_run && block.text_run.elements) {
          markdown += `## ${parseTextElements(block.text_run.elements)}\n\n`;
        } else {
          markdown += `## ${text}\n\n`;
        }
        break;
      case 'heading3':
      case 'heading_3':
        if (block.text_run && block.text_run.elements) {
          markdown += `### ${parseTextElements(block.text_run.elements)}\n\n`;
        } else {
          markdown += `### ${text}\n\n`;
        }
        break;
      case 'heading4':
      case 'heading_4':
        if (block.text_run && block.text_run.elements) {
          markdown += `#### ${parseTextElements(block.text_run.elements)}\n\n`;
        } else {
          markdown += `#### ${text}\n\n`;
        }
        break;
      case 'heading5':
      case 'heading_5':
        if (block.text_run && block.text_run.elements) {
          markdown += `##### ${parseTextElements(block.text_run.elements)}\n\n`;
        } else {
          markdown += `##### ${text}\n\n`;
        }
        break;
      case 'heading6':
      case 'heading_6':
        if (block.text_run && block.text_run.elements) {
          markdown += `###### ${parseTextElements(block.text_run.elements)}\n\n`;
        } else {
          markdown += `###### ${text}\n\n`;
        }
        break;
      case 'heading7':
      case 'heading_7':
      case 'heading8':
      case 'heading9':
        if (block.text_run && block.text_run.elements) {
          markdown += `###### ${parseTextElements(block.text_run.elements)}\n\n`;
        } else {
          markdown += `###### ${text}\n\n`;
        }
        break;
      case 'bullet':
      case 'bullet_list':
        if (block.text_run && block.text_run.elements) {
          markdown += `- ${parseTextElements(block.text_run.elements)}\n`;
        } else {
          markdown += `- ${text}\n`;
        }
        break;
      case 'ordered':
      case 'ordered_list':
        if (block.text_run && block.text_run.elements) {
          markdown += `1. ${parseTextElements(block.text_run.elements)}\n`;
        } else {
          markdown += `1. ${text}\n`;
        }
        break;
      case 'quote':
        if (block.text_run && block.text_run.elements) {
          markdown += `> ${parseTextElements(block.text_run.elements)}\n\n`;
        } else {
          markdown += `> ${text}\n\n`;
        }
        break;
      case 'code':
        if (block.text_run && block.text_run.elements) {
          const codeText = parseTextElements(block.text_run.elements);
          markdown += `\`\`\`\n${codeText}\n\`\`\`\n\n`;
        } else {
          markdown += `\`\`\`\n${text}\n\`\`\`\n\n`;
        }
        break;
      case 'divider':
        markdown += '---\n\n';
        break;
      case 'table':
        // 简单的表格处理
        if (block.table) {
          markdown += '[表格]\n\n';
        }
        break;
      case 'image':
        if (block.image && block.image.token) {
          markdown += `![图片](https://cn.feishucdn.com/thumbnail/${block.image.token})\n\n`;
        }
        break;
      case 'view':
        if (block.view && block.view.title) {
          markdown += `[${block.view.title}](引用)\n\n`;
        }
        break;
      case 'file':
        if (block.file && block.file.name) {
          markdown += `[文件: ${block.file.name}]\n\n`;
        }
        break;
      case 'todo':
        if (block.text_run && block.text_run.elements) {
          const checked = block.todo && block.todo.done ? 'x' : ' ';
          markdown += `- [${checked}] ${parseTextElements(block.text_run.elements)}\n`;
        }
        break;
      default:
        if (text) {
          markdown += text + '\n\n';
        }
    }
  });

  return markdown.trim();
}

// 解析文本元素
function parseTextElements(elements) {
  if (!elements || elements.length === 0) {
    return '';
  }

  let text = '';

  elements.forEach(element => {
    if (element.text_run) {
      const content = element.text_run.content || '';
      const style = element.text_run.text_element_style || {};

      if (style.bold) {
        text += `**${content}**`;
      } else if (style.italic) {
        text += `*${content}*`;
      } else if (style.strikethrough) {
        text += `~~${content}~~`;
      } else if (style.inline_code) {
        text += `\`${content}\``;
      } else if (style.link) {
        text += `[${content}](${style.link.url})`;
      } else {
        text += content;
      }
    } else if (element.text) {
      text += element.text;
    } else if (element.mention) {
      const mentionName = element.mention.name || element.mention.id || '提及';
      text += `@${mentionName}`;
    } else if (element.equation) {
      text += `$${element.equation.content}$`;
    } else if (typeof element === 'string') {
      text += element;
    }
  });

  return text;
}

// 转换为HTML格式
function convertToHTML(blocks) {
  if (!blocks || blocks.length === 0) {
    return documentContent || '';
  }

  let html = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>飞书文档</title>\n</head>\n<body>\n';

  blocks.forEach(block => {
    const blockType = block.block_type || block.type;

    switch (blockType) {
      case 'page':
        if (block.page && block.page.title) {
          html += `<h1>${escapeHtml(block.page.title)}</h1>\n`;
        }
        break;
      case 'text':
        if (block.text_run && block.text_run.elements) {
          html += `<p>${parseTextElementsHTML(block.text_run.elements)}</p>\n`;
        }
        break;
      case 'heading1':
      case 'heading_1':
        if (block.text_run && block.text_run.elements) {
          html += `<h1>${parseTextElementsHTML(block.text_run.elements)}</h1>\n`;
        }
        break;
      case 'heading2':
      case 'heading_2':
        if (block.text_run && block.text_run.elements) {
          html += `<h2>${parseTextElementsHTML(block.text_run.elements)}</h2>\n`;
        }
        break;
      case 'heading3':
      case 'heading_3':
        if (block.text_run && block.text_run.elements) {
          html += `<h3>${parseTextElementsHTML(block.text_run.elements)}</h3>\n`;
        }
        break;
      case 'bullet':
      case 'bullet_list':
        if (block.text_run && block.text_run.elements) {
          html += `<ul><li>${parseTextElementsHTML(block.text_run.elements)}</li></ul>\n`;
        }
        break;
      case 'ordered':
      case 'ordered_list':
        if (block.text_run && block.text_run.elements) {
          html += `<ol><li>${parseTextElementsHTML(block.text_run.elements)}</li></ol>\n`;
        }
        break;
      case 'quote':
        if (block.text_run && block.text_run.elements) {
          html += `<blockquote>${parseTextElementsHTML(block.text_run.elements)}</blockquote>\n`;
        }
        break;
      case 'code':
        if (block.text_run && block.text_run.elements) {
          const codeText = parseTextElementsHTML(block.text_run.elements);
          html += `<pre><code>${escapeHtml(codeText)}</code></pre>\n`;
        }
        break;
      case 'divider':
        html += '<hr>\n';
        break;
    }
  });

  html += '</body>\n</html>';
  return html;
}

// 解析文本元素为HTML
function parseTextElementsHTML(elements) {
  if (!elements || elements.length === 0) {
    return '';
  }

  let html = '';

  elements.forEach(element => {
    if (element.text_run) {
      const content = escapeHtml(element.text_run.content || '');
      const style = element.text_run.text_element_style || {};

      if (style.bold) {
        html += `<strong>${content}</strong>`;
      } else if (style.italic) {
        html += `<em>${content}</em>`;
      } else if (style.strikethrough) {
        html += `<del>${content}</del>`;
      } else if (style.inline_code) {
        html += `<code>${content}</code>`;
      } else if (style.link) {
        html += `<a href="${escapeHtml(style.link.url)}">${content}</a>`;
      } else {
        html += content;
      }
    } else if (element.text) {
      html += escapeHtml(element.text);
    }
  });

  return html;
}

// 转换为纯文本
function convertToText(blocks) {
  if (!blocks || blocks.length === 0) {
    return documentContent || '';
  }

  let text = '';

  blocks.forEach(block => {
    const blockType = block.block_type || block.type;

    switch (blockType) {
      case 'page':
        if (block.page && block.page.title) {
          text += block.page.title + '\n\n';
        }
        break;
      case 'text':
      case 'heading1':
      case 'heading_1':
      case 'heading2':
      case 'heading_2':
      case 'heading3':
      case 'heading_3':
        if (block.text_run && block.text_run.elements) {
          text += parseTextElementsPlain(block.text_run.elements) + '\n\n';
        }
        break;
      case 'bullet':
      case 'bullet_list':
        if (block.text_run && block.text_run.elements) {
          text += '• ' + parseTextElementsPlain(block.text_run.elements) + '\n';
        }
        break;
      case 'ordered':
      case 'ordered_list':
        if (block.text_run && block.text_run.elements) {
          text += '1. ' + parseTextElementsPlain(block.text_run.elements) + '\n';
        }
        break;
      case 'quote':
        if (block.text_run && block.text_run.elements) {
          text += '"' + parseTextElementsPlain(block.text_run.elements) + '"\n\n';
        }
        break;
      case 'code':
        if (block.text_run && block.text_run.elements) {
          text += parseTextElementsPlain(block.text_run.elements) + '\n\n';
        }
        break;
      case 'divider':
        text += '---\n\n';
        break;
    }
  });

  return text.trim();
}

// 解析文本元素为纯文本
function parseTextElementsPlain(elements) {
  if (!elements || elements.length === 0) {
    return '';
  }

  let text = '';

  elements.forEach(element => {
    if (element.text_run) {
      text += element.text_run.content || '';
    } else if (element.text) {
      text += element.text;
    }
  });

  return text;
}

// HTML转义函数
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 显示调试信息
async function showDebugInfo() {
  try {
    const debugSection = document.getElementById('debugSection');
    const debugContent = document.getElementById('debugContent');

    // 获取当前活跃标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 检查是否在飞书页面
    const isFeishuDoc = tab.url.match(/(feishu\.cn|larksuite\.com|larkoffice\.com|feishucdn\.com).*\/(docx|docs|wiki|note)/);
    const isFeishuDomain = tab.url.includes('feishu.cn') ||
                          tab.url.includes('larksuite.com') ||
                          tab.url.includes('larkoffice.com');

    // 尝试提取文档ID
    let documentId = '无法提取';
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: getDocumentIdFromPage
      });
      documentId = results[0].result || '无法提取';
    } catch (error) {
      documentId = `提取失败: ${error.message}`;
    }

    // 获取配置信息
    const config = await chrome.storage.local.get(['appId', 'appSecret']);

    // 构建调试信息
    const debugInfo = {
      '当前页面URL': tab.url,
      '页面标题': tab.title,
      '是否飞书域名': isFeishuDomain ? '是' : '否',
      '是否匹配文档格式': isFeishuDoc ? '是' : '否',
      '提取的文档ID': documentId,
      'App ID': config.appId || '未配置',
      'App Secret': config.appSecret ? '已配置' : '未配置',
    };

    // 显示调试信息
    let html = '<table style="width: 100%; border-collapse: collapse;">';
    for (const [key, value] of Object.entries(debugInfo)) {
      html += `
        <tr style="border-bottom: 1px solid #e5e5e5;">
          <td style="padding: 8px; font-weight: 500; color: #555; width: 40%;">${escapeHtml(key)}</td>
          <td style="padding: 8px; color: #333; word-break: break-all;">${escapeHtml(String(value))}</td>
        </tr>
      `;
    }
    html += '</table>';

    debugContent.innerHTML = html;
    debugSection.style.display = 'block';

  } catch (error) {
    showError(`获取调试信息失败: ${error.message}`);
  }
}

