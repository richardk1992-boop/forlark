// 飞书文档内容读取器 - Background Service Worker
// 处理API请求和令牌管理

// 存储访问令牌（按区域存储）
const accessTokens = {};
const tokenExpireTimes = {};

// API 端点配置
const API_ENDPOINTS = {
  'feishu.cn': 'https://open.feishu.cn',
  'larksuite.com': 'https://open.larksuite.com',
  'larkoffice.com': 'https://open.larksuite.com' // 新加坡版使用国际版API
};

// 根据域名获取API端点
function getApiEndpoint(domain) {
  for (const [key, endpoint] of Object.entries(API_ENDPOINTS)) {
    if (domain.includes(key)) {
      return endpoint;
    }
  }
  // 默认返回中国版端点
  return API_ENDPOINTS['feishu.cn'];
}

// 根据域名获取区域标识
function getRegionKey(domain) {
  if (domain.includes('larkoffice.com')) return 'larkoffice';
  if (domain.includes('larksuite.com')) return 'larksuite';
  return 'feishu';
}

// 监听插件安装
chrome.runtime.onInstalled.addListener(() => {
  console.log('飞书文档内容读取器已安装');
});

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchDocument') {
    fetchDocumentContent(request)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
    return true; // 保持消息通道开启
  }

  if (request.action === 'testConnection') {
    testConnection(request)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 保持消息通道开启
  }

  // OAuth相关
  if (request.action === 'getAuthUrl') {
    try {
      const response = getAuthUrl(request);
      sendResponse(response);
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }

  if (request.action === 'oauthCallback') {
    handleOAuthCallback(request)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'checkAuthStatus') {
    checkAuthStatus()
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ authorized: false, error: error.message }));
    return true;
  }

  if (request.action === 'logout') {
    logout()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'checkPermissions') {
    checkPermissions(request)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  // 处理来自content script的OAuth回调
  if (request.action === 'oauthCallback' && request.source === 'content_script') {
    handleOAuthCallback(request)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // 处理来自content script的OAuth错误
  if (request.action === 'oauthError') {
    console.error('OAuth错误:', request.error);
    showError('授权失败: ' + request.error);
    // 关闭授权窗口
    if (authWindowId) {
      chrome.windows.remove(authWindowId);
      authWindowId = null;
    }
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'documentLoaded') {
    console.log('文档已加载:', request.documentId);
    chrome.storage.local.set({ lastDocumentId: request.documentId });
  }

  return true;
});

// 监听授权窗口的URL变化（用于旧版localhost回调，保留备用）
chrome.webNavigation.onCompleted.addListener(async (details) => {
  // 只监听我们创建的授权窗口
  if (details.windowId === authWindowId) {
    console.log('[webNavigation] 授权窗口URL变化:', details.url);

    // 检查URL中是否包含授权码或错误
    try {
      const urlObj = new URL(details.url);
      const code = urlObj.searchParams.get('code');
      const error = urlObj.searchParams.get('error');

      console.log('[webNavigation] URL解析结果:', { hostname: urlObj.hostname, hasCode: !!code, hasError: !!error });

      // 检查是否是localhost回调（包含授权码）
      if (urlObj.hostname === 'localhost' && code) {
        console.log('[webNavigation] 从localhost回调中提取到授权码:', code);
        await handleOAuthCallback({ code, state: urlObj.searchParams.get('state') });
        // 关闭授权窗口
        if (authWindowId) {
          chrome.windows.remove(authWindowId);
          authWindowId = null;
        }
        return;
      }

      // 检查是否有错误
      if (error) {
        console.error('[webNavigation] 授权失败:', error);
        showError('授权失败: ' + error);
        if (authWindowId) {
          chrome.windows.remove(authWindowId);
          authWindowId = null;
        }
        return;
      }

    } catch (e) {
      console.error('[webNavigation] 处理URL变化失败:', e);
    }
  }
});

// 处理隐式授权的token
async function handleImplicitToken(accessToken) {
  try {
    const storedData = await chrome.storage.local.get(['oauthRegion']);
    const region = storedData.oauthRegion || 'larksuite';
    const apiEndpoint = API_ENDPOINTS[region === 'feishu' ? 'feishu.cn' : 'larksuite.com'];

    // 获取用户信息
    const userInfoResponse = await fetch(`${apiEndpoint}/open-apis/authen/v1/user_info`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const userInfoData = await userInfoResponse.json();
    console.log('用户信息:', userInfoData);

    const tokenInfo = {
      accessToken: accessToken,
      refreshToken: null,
      expiresAt: Date.now() + 7200 * 1000, // 默认2小时
      region: region,
      tokenType: 'user',
      user: userInfoData.code === 0 && userInfoData.data ? {
        name: userInfoData.data.name,
        email: userInfoData.data.email,
        avatar: userInfoData.data.avatar_url,
        userId: userInfoData.data.user_id
      } : null
    };

    await chrome.storage.local.set({ userToken: tokenInfo });
    console.log('授权成功，用户令牌已保存');

    // 通知popup更新授权状态
    chrome.runtime.sendMessage({ action: 'authStatusChanged' });

  } catch (error) {
    console.error('处理token失败:', error);
    throw error;
  }
}

function showError(message) {
  chrome.runtime.sendMessage({ action: 'showError', message: message });
}

// 测试连接
async function testConnection(request) {
  const { appId, appSecret, region, apiEndpoint } = request;

  try {
    const url = `${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`;

    console.log('测试连接到:', url);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret
      })
    });

    console.log('测试连接响应状态:', response.status);

    const contentType = response.headers.get('content-type');

    if (contentType && contentType.includes('text/html')) {
      const text = await response.text();
      console.error('收到HTML响应:', text.substring(0, 200));
      return {
        success: false,
        error: `API端点返回HTML，可能应用区域不匹配\n请确认:\n1. 应用是否在正确的区域创建\n2. 文档在 larkoffice.com，应用应在 open.larksuite.com 创建`
      };
    }

    const data = await response.json();
    console.log('测试连接响应:', data);

    if (data.code !== 0) {
      return {
        success: false,
        error: `认证失败: ${data.msg} (code: ${data.code})\n请检查 App ID 和 App Secret 是否正确`
      };
    }

    // 成功获取令牌
    const regionNames = {
      'feishu': '中国版',
      'larksuite': '国际版/新加坡版'
    };

    return {
      success: true,
      detectedRegion: regionNames[region] || region,
      message: '连接成功，应用配置正确'
    };

  } catch (error) {
    console.error('测试连接失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 检查应用权限
async function checkPermissions(request) {
  const { appId, appSecret, region } = request;

  try {
    const apiEndpoint = API_ENDPOINTS[region === 'feishu' ? 'feishu.cn' : 'larksuite.com'];

    // 获取tenant_access_token
    const tokenResponse = await fetch(`${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret
      })
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.code !== 0) {
      return {
        success: false,
        error: `获取访问令牌失败: ${tokenData.msg} (code: ${tokenData.code})`
      };
    }

    const tenantAccessToken = tokenData.tenant_access_token;

    // 获取应用信息
    const appResponse = await fetch(`${apiEndpoint}/open-apis/app/v1/apps/${appId}`, {
      headers: {
        'Authorization': `Bearer ${tenantAccessToken}`
      }
    });

    // 检查响应类型
    const contentType = appResponse.headers.get('content-type');
    if (contentType && contentType.includes('text/html')) {
      const text = await appResponse.text();
      console.error('获取应用信息失败，返回HTML:', text.substring(0, 200));
      return {
        success: false,
        error: `获取应用信息失败：API返回HTML而不是JSON\n可能原因：\n1. App ID 不正确\n2. 应用不在当前区域创建\n3. API端点不匹配`
      };
    }

    if (!appResponse.ok) {
      return {
        success: false,
        error: `获取应用信息失败: ${appResponse.status} ${appResponse.statusText}`
      };
    }

    const appData = await appResponse.json();
    console.log('应用信息响应:', appData);

    if (appData.code !== 0) {
      return {
        success: false,
        error: `获取应用信息失败: ${appData.msg} (code: ${appData.code})`
      };
    }

    // 解析权限信息
    const permissions = [];
    const app = appData.data.app;

    if (app.app_permissions) {
      app.app_permissions.forEach(perm => {
        permissions.push({
          key: perm.key,
          name: perm.name || perm.key,
          status: perm.status || 'unknown'
        });
      });
    }

    // 检查docx:document权限
    const hasDocxPermission = permissions.some(p => p.key === 'docx:document' || p.key.includes('docx'));

    return {
      success: true,
      appId: appId,
      region: region === 'feishu' ? '中国版' : '国际版/新加坡版',
      permissions: permissions,
      hasDocxPermission: hasDocxPermission,
      warning: !hasDocxPermission ? '⚠️ 未找到 docx:document 权限，请在开放平台添加此权限' : null
    };

  } catch (error) {
    console.error('检查权限失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ===== OAuth 相关函数 =====

// 生成随机state参数
function generateState() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// 获取授权URL并启动OAuth流程
async function getAuthUrl(request) {
  const { region } = request;
  const config = await chrome.storage.local.get(['appId']);

  if (!config.appId) {
    throw new Error('请先配置 App ID');
  }

  const apiEndpoint = API_ENDPOINTS[region === 'feishu' ? 'feishu.cn' : 'larksuite.com'];
  const state = generateState();

  // 存储state用于验证
  await chrome.storage.local.set({ oauthState: state, oauthRegion: region });

  // 使用 Zeabur 部署的重定向URL
  const callbackUrl = 'https://forlark.zeabur.app/callback.html';

  const authUrl = `${apiEndpoint}/open-apis/authen/v1/authorize` +
    `?app_id=${config.appId}` +
    `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
    `&scope=${encodeURIComponent('docx:document:readonly')}` +
    `&state=${state}`;

  console.log('授权URL:', authUrl);

  // 直接打开授权URL，让callback.html处理回调
  chrome.tabs.create({ url: authUrl, active: true });

  return {
    success: true,
    message: '请在打开的标签页中完成授权'
  };
}

// 处理OAuth回调
async function handleOAuthCallback(request) {
  const { code, state, region } = request;

  // 验证state
  const storedData = await chrome.storage.local.get(['oauthState', 'oauthRegion']);
  if (state !== storedData.oauthState) {
    throw new Error('State验证失败，可能存在安全风险');
  }

  console.log('处理OAuth回调:', { code, region });

  try {
    // 获取应用配置
    const config = await chrome.storage.local.get(['appId', 'appSecret']);
    if (!config.appId || !config.appSecret) {
      throw new Error('应用配置不完整');
    }

    // 获取tenant_access_token
    const apiEndpoint = API_ENDPOINTS[region === 'feishu' ? 'feishu.cn' : 'larksuite.com'];
    const regionKey = region === 'feishu' ? 'feishu' : 'larksuite';

    const tenantTokenResponse = await fetch(`${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret
      })
    });

    const tenantTokenData = await tenantTokenResponse.json();
    if (tenantTokenData.code !== 0) {
      throw new Error(`获取tenant_access_token失败: ${tenantTokenData.msg}`);
    }

    const tenantAccessToken = tenantTokenData.tenant_access_token;

    // 使用授权码获取user_access_token
    // redirect_uri必须与授权URL中使用的完全一致
    const redirectUri = 'https://forlark.zeabur.app/callback.html';
    const userTokenResponse = await fetch(`${apiEndpoint}/open-apis/authen/v1/oidc/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tenantAccessToken}`
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.appId,
        client_secret: config.appSecret,
        code: code,
        redirect_uri: redirectUri
      })
    });

    const userTokenData = await userTokenResponse.json();
    console.log('用户令牌响应:', userTokenData);

    if (userTokenData.code !== 0) {
      throw new Error(`获取user_access_token失败: ${userTokenData.msg}`);
    }

    // 存储用户令牌
    const tokenInfo = {
      accessToken: userTokenData.access_token,
      refreshToken: userTokenData.refresh_token,
      expiresAt: Date.now() + userTokenData.expires_in * 1000,
      region: region,
      tokenType: 'user'
    };

    await chrome.storage.local.set({
      userToken: tokenInfo
    });

    // 获取用户信息
    const userInfoResponse = await fetch(`${apiEndpoint}/open-apis/authen/v1/user_info`, {
      headers: {
        'Authorization': `Bearer ${userTokenData.access_token}`
      }
    });

    const userInfoData = await userInfoResponse.json();
    console.log('用户信息:', userInfoData);

    if (userInfoData.code === 0 && userInfoData.data) {
      tokenInfo.user = {
        name: userInfoData.data.name,
        email: userInfoData.data.email,
        avatar: userInfoData.data.avatar_url,
        userId: userInfoData_data.user_id
      };
      await chrome.storage.local.set({ userToken: tokenInfo });
    }

    console.log('授权成功，用户令牌已保存');

    return {
      success: true
    };

  } catch (error) {
    console.error('处理OAuth回调失败:', error);
    throw error;
  }
}

// 检查授权状态
async function checkAuthStatus() {
  const tokenInfo = await chrome.storage.local.get(['userToken']);

  if (!tokenInfo.userToken) {
    return { authorized: false };
  }

  // 检查令牌是否过期
  if (Date.now() >= tokenInfo.userToken.expiresAt - 60000) { // 提前1分钟刷新
    try {
      await refreshUserToken();
    } catch (error) {
      console.error('刷新令牌失败:', error);
      // 刷新失败，清除令牌
      await chrome.storage.local.remove(['userToken']);
      return { authorized: false };
    }
  }

  return {
    authorized: true,
    user: tokenInfo.userToken.user
  };
}

// 刷新用户令牌
async function refreshUserToken() {
  const tokenInfo = await chrome.storage.local.get(['userToken']);
  if (!tokenInfo.userToken || !tokenInfo.userToken.refreshToken) {
    throw new Error('没有可用的刷新令牌');
  }

  const config = await chrome.storage.local.get(['appId', 'appSecret']);
  const region = tokenInfo.userToken.region;
  const apiEndpoint = API_ENDPOINTS[region === 'feishu' ? 'feishu.cn' : 'larksuite.com'];

  const response = await fetch(`${apiEndpoint}/open-apis/authen/v1/oidc/refresh_access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokenInfo.userToken.refreshToken
    })
  });

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`刷新令牌失败: ${data.msg}`);
  }

  // 更新令牌信息
  tokenInfo.userToken.accessToken = data.access_token;
  tokenInfo.userToken.expiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) {
    tokenInfo.userToken.refreshToken = data.refresh_token;
  }

  await chrome.storage.local.set({ userToken: tokenInfo.userToken });

  console.log('用户令牌已刷新');
}

// 退出登录
async function logout() {
  await chrome.storage.local.remove(['userToken']);
  console.log('用户已退出登录');
}

// 获取租户访问令牌 (Tenant Access Token)
async function getTenantAccessToken(appId, appSecret, region = 'feishu') {
  // 检查令牌是否仍然有效
  if (accessTokens[region] && tokenExpireTimes[region] && Date.now() < tokenExpireTimes[region]) {
    return accessTokens[region];
  }

  const apiEndpoint = API_ENDPOINTS[region === 'larkoffice' ? 'larkoffice.com' : region === 'larksuite' ? 'larksuite.com' : 'feishu.cn'];
  const url = `${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`;

  console.log(`获取${region}区域的访问令牌:`, url);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret
      })
    });

    console.log('访问令牌响应状态:', response.status, response.statusText);

    // 检查响应类型
    const contentType = response.headers.get('content-type');
    console.log('响应类型:', contentType);

    if (!response.ok) {
      const text = await response.text();
      console.error('API错误响应:', text);
      throw new Error(`API请求失败: ${response.status} ${response.statusText}\nURL: ${url}\n响应: ${text.substring(0, 200)}`);
    }

    // 如果返回HTML而不是JSON，说明端点可能不正确
    if (contentType && contentType.includes('text/html')) {
      const text = await response.text();
      console.error('收到HTML响应而不是JSON:', text.substring(0, 300));
      throw new Error(`API端点返回了HTML而不是JSON\n请检查:\n1. App ID 和 App Secret 是否正确\n2. 应用是否在正确的区域创建\n3. API端点: ${url}`);
    }

    const data = await response.json();

    console.log('访问令牌响应:', data);

    if (data.code !== 0) {
      throw new Error(`获取访问令牌失败: ${data.msg} (code: ${data.code})`);
    }

    accessTokens[region] = data.tenant_access_token;
    // 提前5分钟过期以确保有效性
    tokenExpireTimes[region] = Date.now() + (data.expire - 300) * 1000;

    return accessTokens[region];
  } catch (error) {
    throw new Error(`获取访问令牌失败: ${error.message}`);
  }
}

// 获取文档内容
async function fetchDocumentContent(request) {
  const { documentId, appId, appSecret, domain } = request;

  try {
    // 检测区域并获取对应的API端点
    const region = getRegionKey(domain || '');
    const apiEndpoint = API_ENDPOINTS[domain && domain.includes('larkoffice') ? 'larkoffice.com' :
                         domain && domain.includes('larksuite') ? 'larksuite.com' : 'feishu.cn'];

    console.log('检测到区域:', region, 'API端点:', apiEndpoint);

    // 优先使用用户令牌（如果已授权）
    let token;
    let tokenType = 'tenant';

    const tokenInfo = await chrome.storage.local.get(['userToken']);
    if (tokenInfo.userToken && tokenInfo.userToken.accessToken) {
      // 检查用户令牌是否过期
      if (Date.now() < tokenInfo.userToken.expiresAt - 60000) {
        token = tokenInfo.userToken.accessToken;
        tokenType = 'user';
        console.log('使用用户令牌获取文档');
      } else {
        // 尝试刷新用户令牌
        try {
          await refreshUserToken();
          const newTokenInfo = await chrome.storage.local.get(['userToken']);
          token = newTokenInfo.userToken.accessToken;
          tokenType = 'user';
          console.log('使用刷新后的用户令牌获取文档');
        } catch (error) {
          console.error('刷新用户令牌失败，使用应用令牌:', error);
          token = await getTenantAccessToken(appId, appSecret, region);
        }
      }
    } else {
      // 没有用户令牌，使用应用令牌
      token = await getTenantAccessToken(appId, appSecret, region);
      console.log('使用应用令牌获取文档');
    }

    // 获取文档元数据
    const metaUrl = `${apiEndpoint}/open-apis/docx/v1/documents/${documentId}`;
    console.log('请求文档元数据:', metaUrl);

    const metaResponse = await fetch(metaUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const metaData = await metaResponse.json();

    console.log('文档元数据API响应:', metaData);

    if (metaData.code !== 0) {
      // 提供更详细的错误信息和解决方案
      let errorMsg = `获取文档元数据失败: ${metaData.msg} (code: ${metaData.code})`;
      if (metaData.code === 99991663 || metaData.msg.toLowerCase().includes('forbidden')) {
        errorMsg += '\n\n可能的原因:\n' +
                   '1. 应用权限不足 - 请确保应用已添加 "docs:document.content:read" 权限\n' +
                   '2. 应用未发布 - 请在飞书开放平台发布应用或启用测试\n' +
                   '3. 需要用户授权 - 此文档可能需要用户登录后访问\n' +
                   '4. 区域不匹配 - 请检查应用创建的区域与文档区域是否一致';
      }
      throw new Error(errorMsg);
    }

    const documentMeta = metaData.data.document;
    const documentTitle = documentMeta.title || '未命名文档';

    // 获取文档块列表
    const blocksUrl = `${apiEndpoint}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`;
    console.log('请求文档块:', blocksUrl);

    const blocksResponse = await fetch(blocksUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const blocksData = await blocksResponse.json();

    console.log('文档块API响应:', blocksData);

    if (blocksData.code !== 0) {
      let errorMsg = `获取文档内容失败: ${blocksData.msg} (code: ${blocksData.code})`;
      if (blocksData.code === 99991663 || blocksData.msg.toLowerCase().includes('forbidden')) {
        errorMsg += '\n\n请检查:\n' +
                   '1. 飞书开放平台应用是否已添加 "docs:document.content:read" 权限\n' +
                   '2. 应用是否已发布或启用测试版本\n' +
                   '3. 应用是否有权访问此文档（需要文档所有者授权或设置为公开）\n' +
                   '4. 应用创建的区域是否与文档所在区域一致';
      }
      throw new Error(errorMsg);
    }

    const allBlocks = await fetchAllBlocks(documentId, token, blocksData.data.items || [], apiEndpoint);

    // 生成纯文本内容作为备用
    const plainContent = blocksToText(allBlocks, documentTitle);

    return {
      success: true,
      documentId,
      title: documentTitle,
      blocks: allBlocks,
      content: plainContent,
      region: region,
      tokenType: tokenType
    };

  } catch (error) {
    console.error('获取文档内容失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 递归获取所有块（处理分页和嵌套块）
async function fetchAllBlocks(documentId, token, collectedBlocks = [], pageToken = null, apiEndpoint = 'https://open.feishu.cn') {
  let url = `${apiEndpoint}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`;

  if (pageToken) {
    url += `?page_token=${encodeURIComponent(pageToken)}`;
  }

  console.log('获取文档块:', url);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`获取文档块失败: ${data.msg} (code: ${data.code})`);
  }

  const items = data.data.items || [];
  collectedBlocks.push(...items);

  // 如果有更多页面，继续获取
  if (data.data.has_more && data.data.page_token) {
    return await fetchAllBlocks(documentId, token, collectedBlocks, data.data.page_token, apiEndpoint);
  }

  return collectedBlocks;
}

// 将块转换为文本格式
function blocksToText(blocks, title = '') {
  let text = title ? `${title}\n\n` : '';

  blocks.forEach(block => {
    const blockType = block.block_type || block.type;

    switch (blockType) {
      case 'page':
        if (block.page && block.page.title) {
          text += `${block.page.title}\n\n`;
        }
        break;
      case 'text':
        if (block.text_run && block.text_run.elements) {
          text += parseTextElements(block.text_run.elements) + '\n\n';
        }
        break;
      case 'heading1':
      case 'heading_1':
        if (block.text_run && block.text_run.elements) {
          text += `# ${parseTextElements(block.text_run.elements)}\n\n`;
        }
        break;
      case 'heading2':
      case 'heading_2':
        if (block.text_run && block.text_run.elements) {
          text += `## ${parseTextElements(block.text_run.elements)}\n\n`;
        }
        break;
      case 'heading3':
      case 'heading_3':
        if (block.text_run && block.text_run.elements) {
          text += `### ${parseTextElements(block.text_run.elements)}\n\n`;
        }
        break;
      case 'bullet':
      case 'bullet_list':
        if (block.text_run && block.text_run.elements) {
          text += `• ${parseTextElements(block.text_run.elements)}\n`;
        }
        break;
      case 'ordered':
      case 'ordered_list':
        if (block.text_run && block.text_run.elements) {
          text += `1. ${parseTextElements(block.text_run.elements)}\n`;
        }
        break;
      case 'quote':
        if (block.text_run && block.text_run.elements) {
          text += `> ${parseTextElements(block.text_run.elements)}\n\n`;
        }
        break;
      case 'code':
        if (block.text_run && block.text_run.elements) {
          text += `\`\`\`\n${parseTextElements(block.text_run.elements)}\n\`\`\`\n\n`;
        }
        break;
      case 'divider':
        text += '---\n\n';
        break;
      case 'todo':
        if (block.text_run && block.text_run.elements) {
          const checked = block.todo && block.todo.done ? 'x' : ' ';
          text += `- [${checked}] ${parseTextElements(block.text_run.elements)}\n`;
        }
        break;
    }
  });

  return text.trim();
}

// 解析文本元素
function parseTextElements(elements) {
  if (!elements || elements.length === 0) {
    return '';
  }

  let text = '';

  elements.forEach(element => {
    if (element.text_run) {
      text += element.text_run.content || '';
    } else if (element.text) {
      text += element.text;
    } else if (element.mention) {
      const mentionName = element.mention.name || element.mention.id || '提及';
      text += `@${mentionName}`;
    } else if (element.equation) {
      text += element.equation.content || '';
    } else if (typeof element === 'string') {
      text += element;
    }
  });

  return text;
}

// 监听 chrome.storage.local 变化（从 callback.html 接收授权码）
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local' && changes.larkOAuthCode) {
    const oauthData = changes.larkOAuthCode.newValue;
    if (oauthData && oauthData.code) {
      console.log('[Storage监听器] 捕获到授权码:', oauthData.code);

      // 获取存储的region
      const storedData = await chrome.storage.local.get(['oauthRegion']);
      const region = storedData.oauthRegion || 'larksuite';

      try {
        await handleOAuthCallback({
          code: oauthData.code,
          state: oauthData.state,
          region: region
        });
        console.log('[Storage监听器] OAuth回调处理成功');

        // 清除已使用的授权码
        await chrome.storage.local.remove(['larkOAuthCode']);

        // 查找并关闭回调标签页
        const tabs = await chrome.tabs.query({});
        const callbackTab = tabs.find(tab => tab.url && tab.url.includes('forlark.zeabur.app/callback.html'));
        if (callbackTab) {
          chrome.tabs.remove(callbackTab.id);
        }
      } catch (error) {
        console.error('[Storage监听器] OAuth回调处理失败:', error);
        showError('授权失败: ' + error.message);
        // 清除失败的授权码
        await chrome.storage.local.remove(['larkOAuthCode']);
      }
    }
  }
});

// 监听标签页更新，检测OAuth回调
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 检查任何URL变化，不只是 complete 状态
  if (tab.url && tab.url.includes('forlark.zeabur.app/callback.html')) {
    console.log('[tabs监听器] 检测到OAuth回调URL:', tab.url, '状态:', changeInfo.status);

    try {
      const urlObj = new URL(tab.url);
      const code = urlObj.searchParams.get('code');
      const state = urlObj.searchParams.get('state');
      const error = urlObj.searchParams.get('error');

      console.log('[tabs监听器] URL解析结果:', { hasCode: !!code, hasError: !!error, code: code?.substring(0, 10) + '...' });

      if (error) {
        console.error('[tabs监听器] OAuth错误:', error);
        showError('授权失败: ' + error);
        chrome.tabs.remove(tabId);
        return;
      }

      if (code) {
        console.log('[tabs监听器] 捕获到授权码:', code);

        // 获取存储的region
        const storedData = await chrome.storage.local.get(['oauthRegion']);
        const region = storedData.oauthRegion || 'larksuite';
        console.log('[tabs监听器] 使用区域:', region);

        // 处理OAuth回调
        await handleOAuthCallback({ code, state, region });

        console.log('[tabs监听器] OAuth回调处理成功');
        chrome.tabs.remove(tabId);
      }
    } catch (e) {
      console.error('[tabs监听器] 处理OAuth回调失败:', e);
    }
  }
});
