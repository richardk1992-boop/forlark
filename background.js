// 飞书文档读取器 - Background Service Worker
// 简化版，使用权限: docs:document.content:read

// ===== API 配置 =====
const API_ENDPOINTS = {
  'feishu.cn': 'https://open.feishu.cn',
  'larksuite.com': 'https://open.larksuite.com',
  'larkoffice.com': 'https://open.larksuite.com'
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

// ===== 获取文档内容 =====
async function fetchDocumentContent(request) {
  const { documentId, appId, appSecret, domain } = request;

  try {
    // 判断区域
    let region = 'feishu';
    let apiEndpoint = API_ENDPOINTS['feishu.cn'];

    if (domain && domain.includes('larksuite.com')) {
      region = 'larksuite';
      apiEndpoint = API_ENDPOINTS['larksuite.com'];
    } else if (domain && domain.includes('larkoffice.com')) {
      region = 'larkoffice';
      apiEndpoint = API_ENDPOINTS['larkoffice.com'];
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

    // 获取文档元数据
    const metaUrl = `${apiEndpoint}/open-apis/docx/v1/documents/${documentId}`;
    console.log('[Fetch] 请求:', metaUrl);

    const metaRes = await fetch(metaUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const metaData = await metaRes.json();
    console.log('[Fetch] 元数据响应:', metaData);

    if (metaData.code !== 0) {
      let errorMsg = `获取文档失败: ${metaData.msg} (code: ${metaData.code})`;

      if (metaData.code === 1770032 || metaData.code === 99991663) {
        errorMsg += '\n\n权限不足，请检查:\n';
        errorMsg += '1. 应用是否添加权限: docs:document.content:read\n';
        errorMsg += '2. 是否已发布应用或启用测试版本\n';
        errorMsg += '3. 应用区域是否与文档区域匹配\n';
        errorMsg += '4. 私密文档需要用户授权';
      }

      throw new Error(errorMsg);
    }

    const documentTitle = metaData.data.document.title || '未命名文档';

    // 获取文档块
    const blocks = await fetchAllBlocks(documentId, token, apiEndpoint);
    const content = blocksToText(blocks, documentTitle);

    console.log('[Fetch] 获取成功, 文档标题:', documentTitle);

    return {
      success: true,
      documentId,
      title: documentTitle,
      blocks,
      content,
      region,
      tokenType
    };

  } catch (error) {
    console.error('[Fetch] 失败:', error);
    return { success: false, error: error.message };
  }
}

// ===== 递归获取所有块 =====
async function fetchAllBlocks(documentId, token, apiEndpoint, collectedBlocks = [], pageToken = null) {
  let url = `${apiEndpoint}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`;
  if (pageToken) {
    url += `?page_token=${encodeURIComponent(pageToken)}`;
  }

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`获取文档块失败: ${data.msg}`);
  }

  const items = data.data.items || [];
  collectedBlocks.push(...items);

  if (data.data.has_more && data.data.page_token) {
    return await fetchAllBlocks(documentId, token, apiEndpoint, collectedBlocks, data.data.page_token);
  }

  return collectedBlocks;
}

// ===== 块转文本 =====
function blocksToText(blocks, title = '') {
  let text = title ? `${title}\n\n` : '';

  blocks.forEach(block => {
    const type = block.block_type || block.type;

    switch (type) {
      case 'page':
        if (block.page?.title) text += `${block.page.title}\n\n`;
        break;
      case 'text':
        if (block.text_run?.elements) {
          text += parseTextElements(block.text_run.elements) + '\n\n';
        }
        break;
      case 'heading1':
      case 'heading_1':
        if (block.text_run?.elements) {
          text += `# ${parseTextElements(block.text_run.elements)}\n\n`;
        }
        break;
      case 'heading2':
      case 'heading_2':
        if (block.text_run?.elements) {
          text += `## ${parseTextElements(block.text_run.elements)}\n\n`;
        }
        break;
      case 'heading3':
      case 'heading_3':
        if (block.text_run?.elements) {
          text += `### ${parseTextElements(block.text_run.elements)}\n\n`;
        }
        break;
      case 'bullet':
      case 'bullet_list':
        if (block.text_run?.elements) {
          text += `• ${parseTextElements(block.text_run.elements)}\n`;
        }
        break;
      case 'ordered':
      case 'ordered_list':
        if (block.text_run?.elements) {
          text += `1. ${parseTextElements(block.text_run.elements)}\n`;
        }
        break;
      case 'quote':
        if (block.text_run?.elements) {
          text += `> ${parseTextElements(block.text_run.elements)}\n\n`;
        }
        break;
      case 'code':
        if (block.text_run?.elements) {
          text += `\`\`\`\n${parseTextElements(block.text_run.elements)}\n\`\`\`\n\n`;
        }
        break;
      case 'todo':
        if (block.text_run?.elements) {
          const checked = block.todo?.done ? 'x' : ' ';
          text += `- [${checked}] ${parseTextElements(block.text_run.elements)}\n`;
        }
        break;
      case 'divider':
        text += '---\n\n';
        break;
    }
  });

  return text.trim();
}

// ===== 解析文本元素 =====
function parseTextElements(elements) {
  if (!elements || elements.length === 0) return '';

  return elements.map(element => {
    if (element.text_run?.content) return element.text_run.content;
    if (element.text) return element.text;
    if (element.mention) return `@${element.mention.name || element.mention.id}`;
    if (element.equation?.content) return element.equation.content;
    if (typeof element === 'string') return element;
    return '';
  }).join('');
}

console.log('[Background] 飞书文档读取器已加载');
