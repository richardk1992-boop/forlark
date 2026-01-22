// 飞书文档读取器 - Background Service Worker
// 修复：使用正确的 docs API

// ===== API 配置 =====
const API_ENDPOINTS = {
  'feishu.cn': 'https://open.feishu.cn',
  'larksuite.com': 'https://open.larksuite.com',
  'larkoffice.com': 'https://open.larksuite.com',
  // 字节跳动飞书专用域名
  'fsopen.feishu.cn': 'https://fsopen.feishu.cn',
  'fsopen.larksuite.com': 'https://fsopen.larksuite.com'
};

// ===== Token 缓存 =====
const tenantTokens = {};
const tokenExpireTimes = {};

// ===== 监听消息 =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Background] 收到消息:', request.action);

  if (request.action === 'testConnection') {
    testConnection(request).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === 'getAuthUrl') {
    getAuthUrl(request).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === 'fetchDocument') {
    fetchDocumentContent(request).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  return false;
});

// ===== 监听 OAuth 回调 =====
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes('forlark.zeabur.app/callback.html')) {
    console.log('[OAuth] 检测到回调:', tab.url);

    try {
      const urlObj = new URL(tab.url);
      const code = urlObj.searchParams.get('code');
      const state = urlObj.searchParams.get('state');
      const error = urlObj.searchParams.get('error');

      if (error) {
        console.error('[OAuth] 错误:', error);
        chrome.tabs.remove(tabId);
        return;
      }

      if (code) {
        console.log('[OAuth] 授权码:', code.substring(0, 10) + '...');
        const storedData = await chrome.storage.local.get(['oauthRegion']);
        const region = storedData.oauthRegion || 'larksuite';
        await handleOAuthCallback({ code, state, region });
        chrome.tabs.remove(tabId);
      }
    } catch (e) {
      console.error('[OAuth] 处理失败:', e);
    }
  }
});

// ===== 测试连接 =====
async function testConnection(request) {
  const { appId, appSecret, apiEndpoint } = request;

  try {
    const response = await fetch(`${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });

    const data = await response.json();

    if (data.code !== 0) {
      return { success: false, error: `认证失败: ${data.msg} (code: ${data.code})` };
    }

    return { success: true, message: '连接成功' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ===== OAuth 授权 =====
function generateState() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

async function getAuthUrl(request) {
  const { region } = request;
  const config = await chrome.storage.local.get(['appId']);

  if (!config.appId) {
    throw new Error('请先配置 App ID');
  }

  const apiEndpoint = API_ENDPOINTS[region === 'feishu' ? 'feishu.cn' : 'larksuite.com'];
  const state = generateState();

  await chrome.storage.local.set({ oauthState: state, oauthRegion: region });

  const callbackUrl = 'https://forlark.zeabur.app/callback.html';
  const authUrl = `${apiEndpoint}/open-apis/authen/v1/authorize` +
    `?app_id=${config.appId}` +
    `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
    `&scope=${encodeURIComponent('docs:document.content:read')}` +
    `&state=${state}`;

  console.log('[OAuth] 授权URL:', authUrl);
  chrome.tabs.create({ url: authUrl });

  return { success: true, message: '请在打开的窗口中完成授权' };
}

async function handleOAuthCallback(request) {
  const { code, state, region } = request;

  const storedData = await chrome.storage.local.get(['oauthState', 'appId', 'appSecret']);
  if (state !== storedData.oauthState) {
    throw new Error('State 验证失败');
  }

  const apiEndpoint = API_ENDPOINTS[region === 'feishu' ? 'feishu.cn' : 'larksuite.com'];

  // 获取 tenant token
  const tenantRes = await fetch(`${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: storedData.appId,
      app_secret: storedData.appSecret
    })
  });
  const tenantData = await tenantRes.json();
  if (tenantData.code !== 0) {
    throw new Error(`获取应用令牌失败: ${tenantData.msg}`);
  }

  // 获取 user token
  const userRes = await fetch(`${apiEndpoint}/open-apis/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tenantData.tenant_access_token}`
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: storedData.appId,
      client_secret: storedData.appSecret,
      code: code,
      redirect_uri: 'https://forlark.zeabur.app/callback.html'
    })
  });
  const userData = await userRes.json();
  if (userData.code !== 0) {
    throw new Error(`获取用户令牌失败: ${userData.msg}`);
  }

  // 获取用户信息
  const infoRes = await fetch(`${apiEndpoint}/open-apis/authen/v1/user_info`, {
    headers: { 'Authorization': `Bearer ${userData.access_token}` }
  });
  const infoData = await infoRes.json();

  // 存储用户令牌
  await chrome.storage.local.set({
    userToken: {
      accessToken: userData.access_token,
      refreshToken: userData.refresh_token,
      expiresAt: Date.now() + userData.expires_in * 1000,
      region: region,
      tokenType: 'user',
      user: infoData.code === 0 && infoData.data ? {
        name: infoData.data.name,
        email: infoData.data.email,
        userId: infoData.data.user_id
      } : null
    }
  });

  console.log('[OAuth] 授权成功');
}

// ===== 获取应用令牌 =====
async function getTenantAccessToken(appId, appSecret, region) {
  const cacheKey = region;
  if (tenantTokens[cacheKey] && tokenExpireTimes[cacheKey] && Date.now() < tokenExpireTimes[cacheKey]) {
    return tenantTokens[cacheKey];
  }

  const apiEndpoint = API_ENDPOINTS[region === 'larkoffice' ? 'larkoffice.com' : region === 'larksuite' ? 'larksuite.com' : 'feishu.cn'];

  const response = await fetch(`${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`获取应用令牌失败: ${data.msg}`);
  }

  tenantTokens[cacheKey] = data.tenant_access_token;
  tokenExpireTimes[cacheKey] = Date.now() + (data.expire - 300) * 1000;

  return data.tenant_access_token;
}

// ===== 获取文档内容 - 使用正确的 docs API =====
async function fetchDocumentContent(request) {
  const { documentId, appId, appSecret, domain } = request;

  try {
    // 判断区域和API端点
    let region = 'feishu';
    let apiEndpoint = API_ENDPOINTS['feishu.cn'];

    // 优先使用字节跳动的 fsopen 域名
    if (domain && domain.includes('larksuite.com')) {
      region = 'larksuite';
      apiEndpoint = API_ENDPOINTS['fsopen.larksuite.com']; // 使用 fsopen
    } else if (domain && domain.includes('larkoffice.com')) {
      region = 'larkoffice';
      apiEndpoint = API_ENDPOINTS['fsopen.larksuite.com']; // 使用 fsopen
    }

    console.log('[Fetch] 区域:', region, 'API:', apiEndpoint);

    // 选择令牌：优先用户令牌
    let token;
    let tokenType = 'tenant';

    const tokenInfo = await chrome.storage.local.get(['userToken']);
    if (tokenInfo.userToken && tokenInfo.userToken.accessToken) {
      // 检查用户令牌是否过期
      if (Date.now() < (tokenInfo.userToken.expiresAt || 0) - 60000) {
        token = tokenInfo.userToken.accessToken;
        tokenType = 'user';
        console.log('[Fetch] 使用用户令牌');
      }
    }

    // 如果没有用户令牌，使用应用令牌
    if (!token) {
      token = await getTenantAccessToken(appId, appSecret, region);
      console.log('[Fetch] 使用应用令牌');
    }

    // ===== 使用正确的 docs API =====
    // API: GET /open-apis/docs/v1/content
    // 参数: content_type, doc_token, doc_type
    const contentUrl = `${apiEndpoint}/open-apis/docs/v1/content`;

    const params = new URLSearchParams({
      content_type: 'markdown',
      doc_token: documentId,  // 使用 doc_token 而不是 document_id
      doc_type: 'docx'
    });

    console.log('[Fetch] 请求URL:', contentUrl);
    console.log('[Fetch] 请求参数:', {
      content_type: 'markdown',
      doc_token: documentId.substring(0, 20) + '...',
      doc_type: 'docx'
    });

    const response = await fetch(`${contentUrl}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    console.log('[Fetch] 响应状态:', response.status);
    console.log('[Fetch] 响应码:', data.code);

    if (data.code !== 0) {
      let errorMsg = `获取文档失败: ${data.msg} (code: ${data.code})`;

      if (data.code === 1770032 || data.code === 99991663) {
        errorMsg += '\n\n【权限不足】\n\n';
        errorMsg += '请确认：\n';
        errorMsg += '1. 应用已添加权限: docs:document.content:read\n';
        errorMsg += '2. 在文档中添加应用权限：「...」→「...更多」→「添加文档应用」\n';
      } else if (data.code === 1770002) {
        errorMsg += '\n\n【文档不存在】\n\n';
        errorMsg += '可能原因：\n';
        errorMsg += '1. 文档已被删除\n';
        errorMsg += '2. doc_token 不正确\n';
        errorMsg += '3. 当前 token 无权访问此文档\n';
        errorMsg += '4. 文档类型不匹配（不是 docx 类型）\n\n';
        errorMsg += `提取的 doc_token: ${documentId}`;
      }

      throw new Error(errorMsg);
    }

    // 返回内容
    console.log('[Fetch] 获取成功，内容长度:', data.data?.content?.length || 0);

    return {
      success: true,
      documentId: documentId,
      content: data.data?.content || '文档内容为空',
      region: region,
      tokenType: tokenType
    };

  } catch (error) {
    console.error('[Fetch] 失败:', error);
    return { success: false, error: error.message };
  }
}

console.log('[Background] 飞书文档读取器已加载 - 使用 docs API');
