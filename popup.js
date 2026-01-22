// 飞书文档读取器 - Popup Script
// 简化版，保留核心功能和调试接口

// ===== 全局变量 =====
let documentContent = '';
let documentBlocks = [];

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  // 绑定事件监听器
  document.getElementById('saveConfig').addEventListener('click', saveConfig);
  document.getElementById('testConnection').addEventListener('click', testConnection);
  document.getElementById('authorizeBtn').addEventListener('click', startAuthorization);
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('setManualToken').addEventListener('click', setManualToken);
  document.getElementById('clearToken').addEventListener('click', clearToken);
  document.getElementById('fetchContent').addEventListener('click', fetchDocumentContent);
  document.getElementById('testApi').addEventListener('click', testApi);
  document.getElementById('debugInfo').addEventListener('click', showDebugInfo);
  document.getElementById('copyContent').addEventListener('click', copyContent);
  document.getElementById('downloadFile').addEventListener('click', downloadFile);

  // 加载配置
  loadConfig();
  // 检查授权状态
  checkAuthStatus();
});

// ===== 配置管理 =====
async function loadConfig() {
  const config = await chrome.storage.local.get(['appId', 'appSecret']);
  if (config.appId) document.getElementById('appId').value = config.appId;
  if (config.appSecret) document.getElementById('appSecret').value = config.appSecret;
}

async function saveConfig() {
  const appId = document.getElementById('appId').value.trim();
  const appSecret = document.getElementById('appSecret').value.trim();
  const statusEl = document.getElementById('saveStatus');

  if (!appId || !appSecret) {
    showStatus('请填写完整的 App ID 和 App Secret', 'error');
    return;
  }

  await chrome.storage.local.set({ appId, appSecret });
  showStatus('✅ 配置保存成功', 'success');
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
}

async function testConnection() {
  const config = await chrome.storage.local.get(['appId', 'appSecret']);
  if (!config.appId || !config.appSecret) {
    showStatus('请先配置 App ID 和 App Secret', 'error');
    return;
  }

  // 获取当前页面判断区域
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const region = tab.url.includes('feishu.cn') ? 'feishu' : 'larksuite';
  const apiEndpoint = region === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com';

  showStatus('正在测试连接...', '');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'testConnection',
      appId: config.appId,
      appSecret: config.appSecret,
      region: region,
      apiEndpoint: apiEndpoint
    });

    if (response.success) {
      showStatus('✅ 连接成功！', 'success');
    } else {
      showStatus('❌ ' + response.error, 'error');
    }
  } catch (error) {
    showStatus('❌ 测试失败: ' + error.message, 'error');
  }
}

function showStatus(message, type) {
  const statusEl = document.getElementById('saveStatus');
  statusEl.textContent = message;
  statusEl.className = 'status ' + (type || '');
}

// ===== 授权管理 =====
async function checkAuthStatus() {
  const tokenInfo = await chrome.storage.local.get(['userToken']);
  const indicator = document.getElementById('authIndicator');
  const statusText = document.getElementById('authStatusText');
  const logoutBtn = document.getElementById('logoutBtn');

  if (tokenInfo.userToken && tokenInfo.userToken.accessToken) {
    const isExpired = Date.now() >= (tokenInfo.userToken.expiresAt || 0);
    if (!isExpired) {
      indicator.className = 'auth-indicator authorized';
      statusText.textContent = tokenInfo.userToken.user?.name || '已授权';
      logoutBtn.classList.remove('hidden');
      return;
    }
  }

  indicator.className = 'auth-indicator unauthorized';
  statusText.textContent = '未授权';
  logoutBtn.classList.add('hidden');
}

async function startAuthorization() {
  const config = await chrome.storage.local.get(['appId']);
  if (!config.appId) {
    showError('请先配置 App ID');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const region = tab.url.includes('feishu.cn') ? 'feishu' : 'larksuite';

  try {
    await chrome.runtime.sendMessage({
      action: 'getAuthUrl',
      region: region
    });
  } catch (error) {
    showError('启动授权失败: ' + error.message);
  }
}

async function logout() {
  if (!confirm('确定要退出登录吗？')) return;
  await chrome.storage.local.remove(['userToken']);
  checkAuthStatus();
}

async function setManualToken() {
  const token = document.getElementById('manualToken').value.trim();
  const region = document.getElementById('manualTokenRegion').value;

  if (!token) {
    showError('请输入 Access Token');
    return;
  }

  const apiEndpoint = region === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com';

  try {
    // 验证 token
    const response = await fetch(`${apiEndpoint}/open-apis/authen/v1/user_info`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();

    if (data.code !== 0) {
      showError('Token 无效: ' + data.msg);
      return;
    }

    // 存储 token
    await chrome.storage.local.set({
      userToken: {
        accessToken: token,
        expiresAt: Date.now() + 7200 * 1000,
        region: region,
        tokenType: 'user',
        user: data.data ? {
          name: data.data.name,
          email: data.data.email,
          userId: data.data.user_id
        } : null
      }
    });

    document.getElementById('manualToken').value = '';
    checkAuthStatus();
    showStatus('✅ Token 设置成功', 'success');
  } catch (error) {
    showError('设置失败: ' + error.message);
  }
}

async function clearToken() {
  await chrome.storage.local.remove(['userToken']);
  checkAuthStatus();
  showStatus('Token 已清除', 'success');
}

// ===== 获取文档 =====
async function fetchDocumentContent() {
  hideError();
  hideContent();
  showLoading(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 提取文档 ID
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const match = window.location.pathname.match(/\/docx\/([a-zA-Z0-9_-]+)/);
        return match ? match[1] : null;
      }
    });

    const documentId = results[0]?.result;
    if (!documentId) {
      throw new Error('无法获取文档 ID，请确保在飞书文档页面');
    }

    // 获取配置
    const config = await chrome.storage.local.get(['appId', 'appSecret']);

    const response = await chrome.runtime.sendMessage({
      action: 'fetchDocument',
      documentId: documentId,
      appId: config.appId,
      appSecret: config.appSecret,
      domain: tab.url
    });

    showLoading(false);

    if (response.success) {
      documentContent = response.content;
      documentBlocks = response.blocks;
      displayContent(response);
    } else {
      showError(response.error);
    }
  } catch (error) {
    showLoading(false);
    showError('获取文档失败: ' + error.message);
  }
}

function displayContent(data) {
  const contentSection = document.getElementById('contentSection');
  const contentDisplay = document.getElementById('contentDisplay');

  contentDisplay.textContent = data.content || '文档内容为空';
  contentSection.classList.remove('hidden');
}

// ===== API 测试 =====
async function testApi() {
  hideError();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const region = tab.url.includes('feishu.cn') ? 'feishu' : 'larksuite';
  const apiEndpoint = region === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com';

  const config = await chrome.storage.local.get(['appId', 'appSecret']);
  if (!config.appId || !config.appSecret) {
    showError('请先配置 App ID 和 App Secret');
    return;
  }

  // 获取文档 ID
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const match = window.location.pathname.match(/\/docx\/([a-zA-Z0-9_-]+)/);
      return match ? match[1] : null;
    }
  });

  const documentId = results[0]?.result;
  if (!documentId) {
    showError('无法获取文档 ID');
    return;
  }

  // 测试 API
  try {
    // 1. 获取 tenant token
    const tokenRes = await fetch(`${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret
      })
    });
    const tokenData = await tokenRes.json();

    if (tokenData.code !== 0) {
      throw new Error(`获取应用令牌失败: ${tokenData.msg}`);
    }

    const tenantToken = tokenData.tenant_access_token;

    // 2. 获取文档元数据
    const metaRes = await fetch(`${apiEndpoint}/open-apis/docx/v1/documents/${documentId}`, {
      headers: {
        'Authorization': `Bearer ${tenantToken}`,
        'Content-Type': 'application/json'
      }
    });
    const metaData = await metaRes.json();

    // 3. 显示结果
    let result = '🧪 API 测试结果\n\n';
    result += `📋 文档 ID: ${documentId}\n`;
    result += `🌍 区域: ${region} (${apiEndpoint})\n`;
    result += `🔑 应用令牌: ✅ 已获取\n\n`;
    result += `📄 文档元数据 API:\n`;
    result += `  状态码: ${metaRes.status}\n`;
    result += `  响应码: ${metaData.code}\n`;
    result += `  消息: ${metaData.msg}\n`;

    if (metaData.code === 0) {
      result += `\n✅ 成功！文档标题: ${metaData.data.document.title}\n`;
      result += `\n应用可以访问此文档，点击"获取文档内容"开始读取。`;
    } else {
      result += `\n❌ 失败\n\n`;
      if (metaData.code === 1770032) {
        result += `错误代码 1770032 = 权限不足\n\n`;
        result += `解决方法:\n`;
        result += `1. 访问 ${apiEndpoint}\n`;
        result += `2. 进入应用 → 权限管理\n`;
        result += `3. 添加权限: docs:document.content:read\n`;
        result += `4. 发布管理 → 启用测试版本\n`;
        result += `5. 添加自己为测试用户\n\n`;
        result += `启用测试版本后立即生效，无需等待审批！`;
      } else {
        result += `请检查应用配置和权限设置`;
      }
    }

    alert(result);

  } catch (error) {
    showError('API 测试失败: ' + error.message);
  }
}

// ===== 调试信息 =====
async function showDebugInfo() {
  hideError();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const storage = await chrome.storage.local.get(null);

  let debug = '🔍 调试信息\n\n';
  debug += `📌 当前页面:\n  ${tab.url}\n\n`;

  debug += `📱 应用配置:\n`;
  debug += `  App ID: ${storage.appId ? '✅ 已配置' : '❌ 未配置'}\n`;
  debug += `  App Secret: ${storage.appSecret ? '✅ 已配置' : '❌ 未配置'}\n\n`;

  debug += `👤 用户 Token:\n`;
  if (storage.userToken) {
    const remainingMs = (storage.userToken.expiresAt || 0) - Date.now();
    const remainingMins = Math.floor(remainingMs / 60000);
    debug += `  状态: ✅ 已设置\n`;
    debug += `  类型: ${storage.userToken.tokenType}\n`;
    debug += `  区域: ${storage.userToken.region}\n`;
    debug += `  过期: ${remainingMs > 0 ? `${remainingMins}分钟后` : `已过期`}\n`;
    if (storage.userToken.user) {
      debug += `  用户: ${storage.userToken.user.name}\n`;
    }
  } else {
    debug += `  状态: ❌ 未设置\n`;
  }

  const debugSection = document.getElementById('debugSection');
  const debugContent = document.getElementById('debugContent');
  debugContent.textContent = debug;
  debugSection.classList.remove('hidden');
}

// ===== 内容操作 =====
async function copyContent() {
  const text = document.getElementById('contentDisplay').textContent;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('copyContent');
    const originalText = btn.textContent;
    btn.textContent = '已复制!';
    setTimeout(() => { btn.textContent = originalText; }, 2000);
  } catch (error) {
    showError('复制失败: ' + error.message);
  }
}

function downloadFile() {
  const content = document.getElementById('contentDisplay').textContent;
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `feishu_doc_${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ===== UI 工具函数 =====
function showLoading(show) {
  document.getElementById('loading').classList.toggle('hidden', !show);
}

function hideError() {
  document.getElementById('errorSection').classList.add('hidden');
}

function hideContent() {
  document.getElementById('contentSection').classList.add('hidden');
  document.getElementById('debugSection').classList.add('hidden');
}

function showError(message) {
  hideContent();
  const errorSection = document.getElementById('errorSection');
  const errorContent = document.getElementById('errorContent');
  errorContent.textContent = message;
  errorSection.classList.remove('hidden');
}
