const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// =======================
// Health Check
// =======================
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    services: ["amazon", "shopee", "mercadolivre", "magalu"],
    timestamp: new Date().toISOString() 
  });
});

// =======================
// Extrator Shopee IDs
// =======================
function extractShopeeIds(url) {
  if (!url) return null;
  const clean = url.split("?")[0].split("#")[0];
  let m;
  m = clean.match(/\/product\/(\d+)\/(\d+)/i);
  if (m) return { shopId: m[1], itemId: m[2] };
  m = clean.match(/\/[^\/]+\/(\d+)\/(\d+)/);
  if (m) return { shopId: m[1], itemId: m[2] };
  m = clean.match(/(?:\.i|-i)\.(\d+)\.(\d+)/i);
  if (m) return { shopId: m[1], itemId: m[2] };
  m = clean.match(/(\d{6,})\.(\d{6,})/);
  if (m) {
    const a = m[1], b = m[2];
    return a.length >= b.length
      ? { itemId: a, shopId: b }
      : { itemId: b, shopId: a };
  }
  return null;
}

// =======================
// Extrator Amazon ASIN
// =======================
function extractAmazonAsin(url) {
  if (!url) return null;
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/gp\/aw\/d\/([A-Z0-9]{10})/i,
    /\/exec\/obidos\/asin\/([A-Z0-9]{10})/i,
    /\/o\/ASIN\/([A-Z0-9]{10})/i,
    /\/product\/([A-Z0-9]{10})/i,
    /[?&]asin=([A-Z0-9]{10})/i,
    /\/([A-Z0-9]{10})(?:[/?]|$)/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1] && /^[A-Z0-9]{10}$/i.test(match[1])) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

// =======================
// Extrator Mercado Livre ID
// =======================
function extractMercadoLivreId(url) {
  if (!url) return null;
  const patterns = [
    /\/p\/(MLB\d{10,14})/i,
    /\/(MLB-?\d{10,14})/i,
    /\/produto\/(MLB-?\d{10,14})/i,
    /\/item\/(MLB-?\d{10,14})/i,
    /[?&]id=(MLB-?\d{10,14})/i,
    /(MLB-?\d{10,14})(?:[?#\/]|$)/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1].replace(/-/g, '').toUpperCase();
    }
  }
  return null;
}

// =======================
// Extrator Magalu ID
// =======================
function extractMagaluId(url) {
  if (!url) return null;
  const patterns = [
    /\/p\/([a-z0-9]{6,20})\/?(?:[?#]|$)/i,
    /\/produto\/([a-z0-9]{6,20})/i,
    /\/[^\/]+\/p\/([a-z0-9]{6,20})/i,
    /[?&]sku=([a-z0-9]{6,20})/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

// =======================
// Detectar Plataforma
// =======================
function detectPlatform(url) {
  if (!url) return "unknown";
  const lower = url.toLowerCase();
  if (lower.includes("amazon.") || lower.includes("amzn.to") || lower.includes("amzn.com") || lower.includes("a.co/")) {
    return "amazon";
  }
  if (lower.includes("shopee.") || lower.includes("shp.ee") || lower.includes("s.shopee.")) {
    return "shopee";
  }
  if (lower.includes("mercadolivre.com") || lower.includes("mercadolibre.com") || lower.includes("meli.com") || lower.includes("produto.mercadolivre")) {
    return "mercadolivre";
  }
  if (lower.includes("magazineluiza.com") || lower.includes("magazinevoce.com") || lower.includes("magalu.com")) {
    return "magalu";
  }
  return "unknown";
}

// =======================
// Verificar se é short link ou URL especial
// =======================
function isShortLink(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  
  const shortPatterns = [
    // Amazon
    "amzn.to", "amzn.com/", "a.co/",
    // Shopee
    "shp.ee", "s.shopee.",
    // Mercado Livre - SHORT LINKS
    "mercadolivre.com/sec/", "mercadolibre.com/sec/", "meli.com/",
    // Mercado Livre - SOCIAL/PROMO URLs (NOVO!)
    "/social/",
    "/jms/",
    "/gz/webdevice/",
    "/deals/",
    "/ofertas/",
    "forceInApp=true",
    "matt_tool=",
    // Magalu
    "magalu.com/", "mglu.me/",
    // Genéricos
    "bit.ly", "tinyurl.", "t.co/", "goo.gl/"
  ];
  
  return shortPatterns.some(p => lower.includes(p));
}

// =======================
// Extrair URL do parâmetro "go=" (webdevice wrapper)
// =======================
function extractGoParameter(url) {
  if (!url) return null;
  
  try {
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
    const goParam = urlObj.searchParams.get('go');
    
    if (goParam) {
      let decoded = decodeURIComponent(goParam);
      try {
        if (decoded.includes('%')) {
          decoded = decodeURIComponent(decoded);
        }
      } catch (e) {}
      
      console.log(`[GO PARAM] Extracted: ${decoded}`);
      return decoded;
    }
  } catch (e) {
    const match = url.match(/[?&]go=([^&]+)/);
    if (match) {
      let decoded = decodeURIComponent(match[1]);
      try {
        if (decoded.includes('%')) {
          decoded = decodeURIComponent(decoded);
        }
      } catch (e) {}
      return decoded;
    }
  }
  
  return null;
}

// =======================
// Verificar se URL ainda precisa de resolução (ML)
// =======================
function needsFurtherResolution(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  
  const unresolvedPatterns = [
    "/social/",
    "/jms/",
    "/gz/webdevice/",
    "/deals/",
    "/ofertas/",
    "forceInApp=true"
  ];
  
  return unresolvedPatterns.some(p => lower.includes(p));
}

// =======================
// Extrair redirect de HTML
// =======================
function extractRedirectFromHtml(html, baseUrl) {
  if (!html) return null;
  
  const metaMatch = html.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?\d+;\s*url=([^"'\s>]+)/i);
  if (metaMatch) {
    console.log(`[HTML] Found meta refresh: ${metaMatch[1]}`);
    return metaMatch[1];
  }
  
  const jsPatterns = [
    /window\.location\.href\s*=\s*["']([^"']+)["']/i,
    /window\.location\s*=\s*["']([^"']+)["']/i,
    /location\.href\s*=\s*["']([^"']+)["']/i,
    /location\.replace\s*\(\s*["']([^"']+)["']\s*\)/i
  ];
  
  for (const pattern of jsPatterns) {
    const match = html.match(pattern);
    if (match && match[1] && match[1].startsWith('http')) {
      console.log(`[HTML] Found JS redirect: ${match[1]}`);
      return match[1];
    }
  }
  
  const canonicalMatch = html.match(/<link[^>]*rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i);
  if (canonicalMatch && canonicalMatch[1].includes('/p/MLB')) {
    console.log(`[HTML] Found canonical: ${canonicalMatch[1]}`);
    return canonicalMatch[1];
  }
  
  const ogMatch = html.match(/<meta[^>]*property=["']?og:url["']?[^>]*content=["']([^"']+)["']/i);
  if (ogMatch && ogMatch[1].includes('/p/MLB')) {
    console.log(`[HTML] Found og:url: ${ogMatch[1]}`);
    return ogMatch[1];
  }
  
  const mlbMatch = html.match(/https?:\/\/[^"'\s]*\/p\/MLB\d{10,14}[^"'\s]*/i);
  if (mlbMatch) {
    console.log(`[HTML] Found MLB link: ${mlbMatch[0]}`);
    return mlbMatch[0];
  }
  
  return null;
}

// =======================
// Resolver URL com suporte a múltiplos hops
// =======================
async function resolveUrl(url, maxHops = 5) {
  let currentUrl = url;
  let hopCount = 0;
  
  console.log(`[RESOLVE] Starting: ${url}`);
  
  while (hopCount < maxHops) {
    hopCount++;
    
    if (currentUrl.includes('/gz/webdevice/') || currentUrl.includes('?go=')) {
      const goUrl = extractGoParameter(currentUrl);
      if (goUrl) {
        console.log(`[RESOLVE] Hop ${hopCount}: Extracted go param -> ${goUrl}`);
        currentUrl = goUrl;
        continue;
      }
    }
    
    if (!needsFurtherResolution(currentUrl) && hopCount > 1) {
      const mlbId = extractMercadoLivreId(currentUrl);
      if (mlbId) {
        console.log(`[RESOLVE] Found MLB ID: ${mlbId}`);
        break;
      }
    }
    
    try {
      console.log(`[RESOLVE] Hop ${hopCount}: Fetching ${currentUrl}`);
      
      const res = await axios.get(currentUrl, {
        maxRedirects: 10,
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
        }
      });
      
      const httpFinalUrl = res.request?.res?.responseUrl || 
                          res.request?._redirectable?._currentUrl || 
                          res.config?.url || 
                          currentUrl;
      
      console.log(`[RESOLVE] HTTP resolved to: ${httpFinalUrl}`);
      
      if (httpFinalUrl !== currentUrl) {
        currentUrl = httpFinalUrl;
        
        if (!needsFurtherResolution(currentUrl)) {
          const mlbId = extractMercadoLivreId(currentUrl);
          if (mlbId) {
            console.log(`[RESOLVE] Success! MLB ID: ${mlbId}`);
            break;
          }
        }
      }
      
      if (httpFinalUrl.includes('?go=')) {
        const goUrl = extractGoParameter(httpFinalUrl);
        if (goUrl) {
          console.log(`[RESOLVE] Found go param in result: ${goUrl}`);
          currentUrl = goUrl;
          continue;
        }
      }
      
      if (needsFurtherResolution(currentUrl) && res.data && typeof res.data === 'string') {
        const htmlRedirect = extractRedirectFromHtml(res.data, currentUrl);
        if (htmlRedirect && htmlRedirect !== currentUrl) {
          console.log(`[RESOLVE] Found in HTML: ${htmlRedirect}`);
          currentUrl = htmlRedirect;
          continue;
        }
      }
      
      break;
      
    } catch (err) {
      console.error(`[RESOLVE] Error on hop ${hopCount}: ${err.message}`);
      
      try {
        const headRes = await axios.head(currentUrl, {
          maxRedirects: 10,
          timeout: 10000,
          validateStatus: () => true,
          headers: { "User-Agent": "Mozilla/5.0" }
        });
        const headUrl = headRes.request?.res?.responseUrl || currentUrl;
        if (headUrl !== currentUrl) {
          currentUrl = headUrl;
          continue;
        }
      } catch (headErr) {
        console.error(`[RESOLVE] HEAD also failed: ${headErr.message}`);
      }
      
      break;
    }
  }
  
  console.log(`[RESOLVE] Final (${hopCount} hops): ${currentUrl}`);
  return currentUrl;
}

// =======================
// Amazon Creators API - OAuth 2.0 Token Cache
// =======================
const tokenCache = {};

async function getOAuthToken(credentialId, credentialSecret) {
  const cacheKey = credentialId;
  const now = Date.now();

  // Retornar token cacheado se ainda válido (com margem de 5 min)
  if (tokenCache[cacheKey] && tokenCache[cacheKey].expiresAt > now + 300000) {
    console.log(`[AUTH] Using cached token for ${credentialId.substring(0, 8)}...`);
    return tokenCache[cacheKey].accessToken;
  }

  console.log(`[AUTH] Fetching new OAuth token for ${credentialId.substring(0, 8)}...`);

  // Brasil = NA region = Version 2.1
  const tokenEndpoint = 'https://creatorsapi.auth.us-east-1.amazoncognito.com/oauth2/token';

  const response = await axios.post(tokenEndpoint, 
    `grant_type=client_credentials&client_id=${encodeURIComponent(credentialId)}&client_secret=${encodeURIComponent(credentialSecret)}&scope=creatorsapi/default`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    }
  );

  const { access_token, expires_in } = response.data;

  tokenCache[cacheKey] = {
    accessToken: access_token,
    expiresAt: now + (expires_in * 1000)
  };

  console.log(`[AUTH] Token obtained, expires in ${expires_in}s`);
  return access_token;
}

// =======================
// POST /amazon/product (Creators API v2.1)
// =======================
app.post("/amazon/product", async (req, res) => {
  const { credentialId, credentialSecret, partnerTag, asin } = req.body;
  if (!credentialId || !credentialSecret || !partnerTag || !asin) {
    return res.status(400).json({
      ok: false,
      error: "missing_params",
      message: "Campos obrigatórios: credentialId, credentialSecret, partnerTag, asin"
    });
  }
  try {
    // 1. Obter Bearer Token OAuth 2.0
    const accessToken = await getOAuthToken(credentialId, credentialSecret);

    // 2. Montar payload para Creators API
    const payload = {
      itemIds: [asin],
      itemIdType: "ASIN",
      marketplace: "www.amazon.com.br",
      partnerTag: partnerTag,
      resources: [
        "itemInfo.title",
        "itemInfo.features",
        "images.primary.large",
        "images.primary.medium",
        "offersV2.listings.price",
        "offersV2.listings.dealDetails",
        "offersV2.listings.condition",
        "offersV2.listings.availability"
      ]
    };

    console.log(`[PRODUCT] Fetching ASIN: ${asin} via Creators API`);

    // 3. Chamar Creators API
    const response = await axios.post(
      'https://creatorsapi.amazon/catalog/v1/getItems',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}, Version 2.1`,
          'x-marketplace': 'www.amazon.com.br'
        },
        timeout: 30000
      }
    );

    console.log(`[PRODUCT] Success for ASIN: ${asin}`);

    return res.json({
      ok: true,
      asin: asin,
      data: response.data
    });

  } catch (err) {
    console.error(`[PRODUCT ERROR] ${err.message}`);

    // Limpar cache de token em caso de erro de auth
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      delete tokenCache[credentialId];
      console.log(`[AUTH] Token cache cleared for ${credentialId.substring(0, 8)}...`);
    }

    if (err.response) {
      return res.status(err.response.status).json({
        ok: false,
        error: "api_error",
        status: err.response.status,
        message: err.response.data
      });
    }
    return res.status(500).json({
      ok: false,
      error: "request_failed",
      message: err.message
    });
  }
});

// =======================
// POST /resolve (unificado)
// =======================
app.post("/resolve", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({
      ok: false,
      error: "url_required",
      message: "Campo 'url' é obrigatório"
    });
  }
  try {
    const needsResolve = isShortLink(url);
    let finalUrl = url;
    
    if (needsResolve) {
      finalUrl = await resolveUrl(url);
    }
    const platform = detectPlatform(finalUrl);
    let result = {
      ok: false,
      platform,
      original_url: url,
      final_url: finalUrl,
      was_short_link: needsResolve,
      asin: null,
      shopId: null,
      itemId: null,
      mlbId: null,
      magaluId: null
    };
    if (platform === "amazon") {
      const asin = extractAmazonAsin(finalUrl);
      result.ok = !!asin;
      result.asin = asin;
    } else if (platform === "shopee") {
      const ids = extractShopeeIds(finalUrl);
      result.ok = !!ids;
      result.shopId = ids?.shopId || null;
      result.itemId = ids?.itemId || null;
    } else if (platform === "mercadolivre") {
      const mlbId = extractMercadoLivreId(finalUrl);
      result.ok = !!mlbId;
      result.mlbId = mlbId;
    } else if (platform === "magalu") {
      const magaluId = extractMagaluId(finalUrl);
      result.ok = !!magaluId;
      result.magaluId = magaluId;
    } else {
      result.error = "unsupported_platform";
      result.message = "Plataforma não suportada. Use Amazon, Shopee, Mercado Livre ou Magalu.";
    }
    console.log(`[RESULT] Platform: ${platform}, OK: ${result.ok}, URL: ${url}`);
    return res.json(result);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return res.status(500).json({
      ok: false,
      error: "resolve_failed",
      message: err.message,
      original_url: url
    });
  }
});

// =======================
// POST /resolve/amazon
// =======================
app.post("/resolve/amazon", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ ok: false, error: "url_required" });
  }
  try {
    const needsResolve = isShortLink(url);
    const finalUrl = needsResolve ? await resolveUrl(url) : url;
    const asin = extractAmazonAsin(finalUrl);
    return res.json({
      ok: !!asin,
      asin,
      original_url: url,
      final_url: finalUrl,
      was_short_link: needsResolve
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      original_url: url
    });
  }
});

// =======================
// POST /resolve/shopee
// =======================
app.post("/resolve/shopee", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ ok: false, error: "url_required" });
  }
  try {
    const needsResolve = isShortLink(url);
    const finalUrl = needsResolve ? await resolveUrl(url) : url;
    const ids = extractShopeeIds(finalUrl);
    return res.json({
      ok: !!ids,
      shopId: ids?.shopId || null,
      itemId: ids?.itemId || null,
      original_url: url,
      final_url: finalUrl,
      was_short_link: needsResolve
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      original_url: url
    });
  }
});

// =======================
// POST /resolve/mercadolivre
// =======================
app.post("/resolve/mercadolivre", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ ok: false, error: "url_required" });
  }
  try {
    const needsResolve = isShortLink(url);
    const finalUrl = needsResolve ? await resolveUrl(url) : url;
    const mlbId = extractMercadoLivreId(finalUrl);
    return res.json({
      ok: !!mlbId,
      mlbId,
      original_url: url,
      final_url: finalUrl,
      was_short_link: needsResolve
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      original_url: url
    });
  }
});

// =======================
// POST /resolve/magalu
// =======================
app.post("/resolve/magalu", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ ok: false, error: "url_required" });
  }
  try {
    const needsResolve = isShortLink(url);
    const finalUrl = needsResolve ? await resolveUrl(url) : url;
    const magaluId = extractMagaluId(finalUrl);
    return res.json({
      ok: !!magaluId,
      magaluId,
      original_url: url,
      final_url: finalUrl,
      was_short_link: needsResolve
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      original_url: url
    });
  }
});

// =======================
// Iniciar servidor
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 URL Resolver rodando na porta ${PORT}`);
  console.log(`📦 Suporta: Amazon, Shopee, Mercado Livre, Magalu`);
  console.log(`🔗 Endpoints:`);
  console.log(`   POST /resolve              - Detecta plataforma automaticamente`);
  console.log(`   POST /resolve/amazon       - Apenas Amazon`);
  console.log(`   POST /resolve/shopee       - Apenas Shopee`);
  console.log(`   POST /resolve/mercadolivre - Apenas Mercado Livre`);
  console.log(`   POST /resolve/magalu       - Apenas Magalu`);
  console.log(`   POST /amazon/product       - Busca produto Amazon (Creators API v2.1)`);
  console.log(`   GET  /health               - Health check`);
});
