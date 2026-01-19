// URL Resolver Server - PromoEnvia
// Versão completa com encurtador integrado

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

// ============================================
// CONFIGURAÇÕES
// ============================================

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SHORT_DOMAIN = process.env.SHORT_DOMAIN || 'promo.envia.link';

// ============================================
// FUNÇÕES AUXILIARES - RESOLVER
// ============================================

function extractShopeeIds(url) {
  const patterns = [
    /shopee\.com\.br\/[^\/]+\/(\d+)\/(\d+)/,
    /shopee\.com\.br\/product\/(\d+)\/(\d+)/,
    /i\.(\d+)\.(\d+)/,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return { shopId: match[1], itemId: match[2] };
    }
  }
  return null;
}

function extractAmazonAsin(url) {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/product\/([A-Z0-9]{10})/i,
    /\/d\/([A-Z0-9]{10})/i,
    /amazon\.com\.br\/([A-Z0-9]{10})/i,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function extractMercadoLivreId(url) {
  const patterns = [
    /MLB-?(\d+)/i,
    /mercadolivre\.com\.br\/[^\/]+\/p\/MLB(\d+)/i,
    /produto\.mercadolivre\.com\.br\/MLB-?(\d+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return `MLB${match[1]}`;
    }
  }
  return null;
}

function extractMagaluId(url) {
  const patterns = [
    /magazineluiza\.com\.br\/[^\/]+\/p\/([a-zA-Z0-9]+)/i,
    /magalu\.com\.br\/[^\/]+\/p\/([a-zA-Z0-9]+)/i,
    /\/p\/([a-zA-Z0-9]+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function detectPlatform(url) {
  const urlLower = url.toLowerCase();
  
  if (urlLower.includes('shopee.com.br') || urlLower.includes('shope.ee') || urlLower.includes('s.shopee.com.br')) {
    return 'shopee';
  }
  if (urlLower.includes('amazon.com.br') || urlLower.includes('amzn.to') || urlLower.includes('a.co')) {
    return 'amazon';
  }
  if (urlLower.includes('mercadolivre.com.br') || urlLower.includes('mercadolibre') || urlLower.includes('meli.co')) {
    return 'mercadolivre';
  }
  if (urlLower.includes('magazineluiza.com.br') || urlLower.includes('magalu.com.br') || urlLower.includes('mglu.me')) {
    return 'magalu';
  }
  
  return 'unknown';
}

function isShortLink(url, platform) {
  const urlLower = url.toLowerCase();
  
  switch (platform) {
    case 'shopee':
      return urlLower.includes('shope.ee') || urlLower.includes('s.shopee.com.br');
    case 'amazon':
      return urlLower.includes('amzn.to') || urlLower.includes('a.co');
    case 'mercadolivre':
      return urlLower.includes('meli.co');
    case 'magalu':
      return urlLower.includes('mglu.me');
    default:
      return false;
  }
}

function extractGoParameter(url) {
  try {
    const urlObj = new URL(url);
    const goParam = urlObj.searchParams.get('go');
    if (goParam) {
      return decodeURIComponent(goParam);
    }
  } catch (e) {}
  return null;
}

function needsFurtherResolution(url, platform) {
  const urlLower = url.toLowerCase();
  
  switch (platform) {
    case 'shopee':
      return urlLower.includes('/universal-link') || 
             urlLower.includes('share.shopee') ||
             urlLower.includes('s.shopee.com.br');
    case 'amazon':
      return false;
    case 'mercadolivre':
      return urlLower.includes('/go') || 
             urlLower.includes('click1.mercadolivre');
    case 'magalu':
      return urlLower.includes('redirect') ||
             urlLower.includes('/r/');
    default:
      return false;
  }
}

function extractRedirectFromHtml(html, platform) {
  try {
    const $ = cheerio.load(html);
    
    // Meta refresh
    const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
    if (metaRefresh) {
      const urlMatch = metaRefresh.match(/url=(.+)/i);
      if (urlMatch) {
        return urlMatch[1].trim();
      }
    }
    
    // Canonical
    const canonical = $('link[rel="canonical"]').attr('href');
    if (canonical && canonical.includes(platform)) {
      return canonical;
    }
    
    // OG URL
    const ogUrl = $('meta[property="og:url"]').attr('content');
    if (ogUrl && ogUrl.includes(platform)) {
      return ogUrl;
    }
    
    // JavaScript redirects
    const scriptTags = $('script').text();
    const redirectPatterns = [
      /window\.location\s*=\s*["']([^"']+)["']/,
      /window\.location\.href\s*=\s*["']([^"']+)["']/,
      /location\.replace\s*\(\s*["']([^"']+)["']\s*\)/,
    ];
    
    for (const pattern of redirectPatterns) {
      const match = scriptTags.match(pattern);
      if (match) {
        return match[1];
      }
    }
  } catch (e) {}
  
  return null;
}

async function resolveUrl(url, platform, maxRedirects = 5) {
  let currentUrl = url;
  let redirectCount = 0;
  
  while (redirectCount < maxRedirects) {
    try {
      // Verifica se tem parâmetro go=
      const goUrl = extractGoParameter(currentUrl);
      if (goUrl) {
        currentUrl = goUrl;
        redirectCount++;
        continue;
      }
      
      // Se não precisa mais resolver, retorna
      if (!isShortLink(currentUrl, platform) && !needsFurtherResolution(currentUrl, platform)) {
        break;
      }
      
      // Faz request para seguir redirects
      const response = await axios.get(currentUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        timeout: 10000,
      });
      
      // Verifica redirect no header
      if (response.headers.location) {
        let newUrl = response.headers.location;
        if (!newUrl.startsWith('http')) {
          const baseUrl = new URL(currentUrl);
          newUrl = `${baseUrl.protocol}//${baseUrl.host}${newUrl}`;
        }
        currentUrl = newUrl;
        redirectCount++;
        continue;
      }
      
      // Tenta extrair do HTML
      if (response.data && typeof response.data === 'string') {
        const extractedUrl = extractRedirectFromHtml(response.data, platform);
        if (extractedUrl && extractedUrl !== currentUrl) {
          currentUrl = extractedUrl;
          redirectCount++;
          continue;
        }
      }
      
      break;
    } catch (error) {
      if (error.response && error.response.headers && error.response.headers.location) {
        let newUrl = error.response.headers.location;
        if (!newUrl.startsWith('http')) {
          const baseUrl = new URL(currentUrl);
          newUrl = `${baseUrl.protocol}//${baseUrl.host}${newUrl}`;
        }
        currentUrl = newUrl;
        redirectCount++;
        continue;
      }
      break;
    }
  }
  
  return currentUrl;
}

// ============================================
// FUNÇÕES AUXILIARES - ENCURTADOR
// ============================================

function detectMarketplace(url) {
  const urlLower = url.toLowerCase();
  
  if (urlLower.includes('shopee')) return 'shopee';
  if (urlLower.includes('amazon') || urlLower.includes('amzn')) return 'amazon';
  if (urlLower.includes('mercadolivre') || urlLower.includes('mercadolibre') || urlLower.includes('meli')) return 'mercadolivre';
  if (urlLower.includes('magalu') || urlLower.includes('magazineluiza') || urlLower.includes('mglu')) return 'magalu';
  if (urlLower.includes('aliexpress')) return 'aliexpress';
  if (urlLower.includes('shein')) return 'shein';
  if (urlLower.includes('casasbahia')) return 'casasbahia';
  if (urlLower.includes('americanas')) return 'americanas';
  if (urlLower.includes('kabum')) return 'kabum';
  
  return 'outros';
}

// ============================================
// ENDPOINTS - HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    services: {
      resolver: 'active',
      shortener: SUPABASE_URL ? 'active' : 'not_configured'
    },
    supabase_configured: !!SUPABASE_URL && !!SUPABASE_SERVICE_KEY
  });
});

// ============================================
// ENDPOINTS - RESOLVER UNIFICADO
// ============================================

app.post('/resolve', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const platform = detectPlatform(url);
    
    if (platform === 'unknown') {
      return res.json({
        success: true,
        original_url: url,
        resolved_url: url,
        platform: 'unknown',
        product_id: null,
        message: 'Platform not recognized'
      });
    }
    
    const resolvedUrl = await resolveUrl(url, platform);
    
    let productId = null;
    let additionalInfo = {};
    
    switch (platform) {
      case 'shopee':
        const shopeeIds = extractShopeeIds(resolvedUrl);
        if (shopeeIds) {
          productId = shopeeIds.itemId;
          additionalInfo.shop_id = shopeeIds.shopId;
          additionalInfo.item_id = shopeeIds.itemId;
        }
        break;
      case 'amazon':
        productId = extractAmazonAsin(resolvedUrl);
        additionalInfo.asin = productId;
        break;
      case 'mercadolivre':
        productId = extractMercadoLivreId(resolvedUrl);
        additionalInfo.mlb_id = productId;
        break;
      case 'magalu':
        productId = extractMagaluId(resolvedUrl);
        additionalInfo.sku = productId;
        break;
    }
    
    res.json({
      success: true,
      original_url: url,
      resolved_url: resolvedUrl,
      platform,
      product_id: productId,
      ...additionalInfo
    });
    
  } catch (error) {
    console.error('Resolve error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// ENDPOINTS - RESOLVER POR PLATAFORMA
// ============================================

app.post('/resolve/shopee', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const resolvedUrl = await resolveUrl(url, 'shopee');
    const ids = extractShopeeIds(resolvedUrl);
    
    res.json({
      success: true,
      original_url: url,
      resolved_url: resolvedUrl,
      shop_id: ids?.shopId || null,
      item_id: ids?.itemId || null
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/resolve/amazon', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const resolvedUrl = await resolveUrl(url, 'amazon');
    const asin = extractAmazonAsin(resolvedUrl);
    
    res.json({
      success: true,
      original_url: url,
      resolved_url: resolvedUrl,
      asin
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/resolve/mercadolivre', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const resolvedUrl = await resolveUrl(url, 'mercadolivre');
    const mlbId = extractMercadoLivreId(resolvedUrl);
    
    res.json({
      success: true,
      original_url: url,
      resolved_url: resolvedUrl,
      mlb_id: mlbId
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/resolve/magalu', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const resolvedUrl = await resolveUrl(url, 'magalu');
    const sku = extractMagaluId(resolvedUrl);
    
    res.json({
      success: true,
      original_url: url,
      resolved_url: resolvedUrl,
      sku
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINTS - AMAZON SIGN (AWS V4)
// ============================================

app.post('/amazon/sign', (req, res) => {
  try {
    const { 
      accessKey, 
      secretKey, 
      partnerTag, 
      host, 
      region, 
      path, 
      payload 
    } = req.body;
    
    if (!accessKey || !secretKey || !payload) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 'ProductAdvertisingAPI';
    
    const canonicalHeaders = `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems\n`;
    const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
    
    const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
    const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    
    const getSignatureKey = (key, dateStamp, regionName, serviceName) => {
      const kDate = crypto.createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
      const kRegion = crypto.createHmac('sha256', kDate).update(regionName).digest();
      const kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest();
      const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
      return kSigning;
    };
    
    const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    
    const authorizationHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    
    res.json({
      success: true,
      headers: {
        'Authorization': authorizationHeader,
        'Content-Encoding': 'amz-1.0',
        'Content-Type': 'application/json; charset=utf-8',
        'Host': host,
        'X-Amz-Date': amzDate,
        'X-Amz-Target': 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems'
      }
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINTS - AMAZON PRODUCT
// ============================================

app.post('/amazon/product', async (req, res) => {
  try {
    const { 
      asin, 
      accessKey, 
      secretKey, 
      partnerTag,
      marketplace = 'www.amazon.com.br',
      region = 'us-east-1'
    } = req.body;
    
    if (!asin || !accessKey || !secretKey || !partnerTag) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const host = `webservices.${marketplace.replace('www.', '')}`;
    const path = '/paapi5/getitems';
    
    const payload = JSON.stringify({
      ItemIds: [asin],
      PartnerTag: partnerTag,
      PartnerType: 'Associates',
      Marketplace: marketplace,
      Resources: [
        'Images.Primary.Large',
        'ItemInfo.Title',
        'Offers.Listings.Price',
        'Offers.Listings.SavingBasis'
      ]
    });
    
    // Gera assinatura
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 'ProductAdvertisingAPI';
    
    const canonicalHeaders = `content-encoding:amz-1.0\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems\n`;
    const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
    
    const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
    const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    
    const getSignatureKey = (key, dateStamp, regionName, serviceName) => {
      const kDate = crypto.createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
      const kRegion = crypto.createHmac('sha256', kDate).update(regionName).digest();
      const kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest();
      const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
      return kSigning;
    };
    
    const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authorizationHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    
    // Faz request para Amazon
    const response = await axios.post(`https://${host}${path}`, payload, {
      headers: {
        'Authorization': authorizationHeader,
        'Content-Encoding': 'amz-1.0',
        'Content-Type': 'application/json; charset=utf-8',
        'Host': host,
        'X-Amz-Date': amzDate,
        'X-Amz-Target': 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems'
      }
    });
    
    res.json({
      success: true,
      data: response.data
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.response?.data || error.message 
    });
  }
});

// ============================================
// ENDPOINT - ENCURTADOR
// ============================================

app.post('/shorten', async (req, res) => {
  try {
    const { url, user_id, custom_code, expires_days = 30 } = req.body;
    
    // Validações
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL is required' 
      });
    }
    
    if (!user_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'user_id is required' 
      });
    }
    
    // Verifica se Supabase está configurado
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: 'Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables.' 
      });
    }
    
    // Detecta marketplace
    const marketplace = detectMarketplace(url);
    
    // Chama RPC do Supabase para criar link curto
    const rpcPayload = {
      p_original_url: url,
      p_user_id: user_id,
      p_marketplace: marketplace,
      p_custom_code: custom_code || null,
      p_expires_days: expires_days
    };
    
    const supabaseResponse = await axios.post(
      `${SUPABASE_URL}/rest/v1/rpc/create_short_link`,
      rpcPayload,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        }
      }
    );
    
    const result = supabaseResponse.data;
    
    // Monta URL curta
    const shortUrl = `https://${SHORT_DOMAIN}/${result.code}`;
    
    res.json({
      success: true,
      short_url: shortUrl,
      code: result.code,
      marketplace: marketplace,
      original_url: url,
      expires_at: result.expires_at,
      created_at: result.created_at
    });
    
  } catch (error) {
    console.error('Shorten error:', error.response?.data || error.message);
    
    // Trata erros específicos do Supabase
    if (error.response?.data?.message) {
      return res.status(400).json({ 
        success: false, 
        error: error.response.data.message 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================
// ENDPOINT - ESTATÍSTICAS DO LINK (BÔNUS)
// ============================================

app.get('/stats/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: 'Supabase not configured' 
      });
    }
    
    // Busca link no Supabase
    const response = await axios.get(
      `${SUPABASE_URL}/rest/v1/short_links?code=eq.${code}&select=*`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    
    if (!response.data || response.data.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Link not found' 
      });
    }
    
    const link = response.data[0];
    
    res.json({
      success: true,
      code: link.code,
      original_url: link.original_url,
      marketplace: link.marketplace,
      clicks: link.clicks || 0,
      created_at: link.created_at,
      expires_at: link.expires_at,
      is_active: link.is_active
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================
// INICIALIZAÇÃO
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 URL Resolver Server running on port ${PORT}`);
  console.log(`📍 Endpoints disponíveis:`);
  console.log(`   GET  /health`);
  console.log(`   POST /resolve`);
  console.log(`   POST /resolve/shopee`);
  console.log(`   POST /resolve/amazon`);
  console.log(`   POST /resolve/mercadolivre`);
  console.log(`   POST /resolve/magalu`);
  console.log(`   POST /amazon/sign`);
  console.log(`   POST /amazon/product`);
  console.log(`   POST /shorten`);
  console.log(`   GET  /stats/:code`);
  console.log(`\n🔧 Supabase: ${SUPABASE_URL ? 'Configurado ✓' : 'Não configurado'}`);
});
