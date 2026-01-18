const express = require("express");
const axios = require("axios");
const aws4 = require("aws4");

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
// Extrator Mercado Livre ID (NOVO)
// =======================
function extractMercadoLivreId(url) {
  if (!url) return null;

  const patterns = [
    // /p/MLB1234567890
    /\/p\/(MLB\d{10,14})/i,
    // MLB-1234567890 ou MLB1234567890 no path
    /\/(MLB-?\d{10,14})/i,
    // produto/MLB1234567890
    /\/produto\/(MLB-?\d{10,14})/i,
    // item/MLB1234567890
    /\/item\/(MLB-?\d{10,14})/i,
    // ?id=MLB1234567890
    /[?&]id=(MLB-?\d{10,14})/i,
    // MLB no meio da URL com hífen ou não
    /(MLB-?\d{10,14})(?:[?#\/]|$)/i
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      // Normalizar: remover hífens e uppercase
      return match[1].replace(/-/g, '').toUpperCase();
    }
  }

  return null;
}

// =======================
// Extrator Magalu ID (NOVO)
// =======================
function extractMagaluId(url) {
  if (!url) return null;

  const patterns = [
    // /p/abc123def456/ ou /p/abc123def456
    /\/p\/([a-z0-9]{6,20})\/?(?:[?#]|$)/i,
    // /produto/abc123def456
    /\/produto\/([a-z0-9]{6,20})/i,
    // /{categoria}/p/{id}/
    /\/[^\/]+\/p\/([a-z0-9]{6,20})/i,
    // SKU no query string
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

  // Amazon
  if (lower.includes("amazon.") || lower.includes("amzn.to") || lower.includes("amzn.com") || lower.includes("a.co/")) {
    return "amazon";
  }
  
  // Shopee
  if (lower.includes("shopee.") || lower.includes("shp.ee") || lower.includes("s.shopee.")) {
    return "shopee";
  }
  
  // Mercado Livre
  if (lower.includes("mercadolivre.com") || lower.includes("mercadolibre.com") || lower.includes("meli.com") || lower.includes("produto.mercadolivre")) {
    return "mercadolivre";
  }
  
  // Magalu
  if (lower.includes("magazineluiza.com") || lower.includes("magazinevoce.com") || lower.includes("magalu.com")) {
    return "magalu";
  }

  return "unknown";
}

// =======================
// Resolver URL curta
// =======================
async function resolveUrl(url) {
  try {
    const res = await axios.get(url, {
      maxRedirects: 10,
      timeout: 15000,
      validateStatus: () => true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    const finalUrl = res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || res.config?.url || url;
    console.log(`[RESOLVE] ${url} -> ${finalUrl}`);
    return finalUrl;
  } catch (err) {
    // Fallback com HEAD
    try {
      const headRes = await axios.head(url, {
        maxRedirects: 10,
        timeout: 10000,
        validateStatus: () => true,
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      return headRes.request?.res?.responseUrl || url;
    } catch {
      console.error(`[RESOLVE ERROR] ${url}: ${err.message}`);
      throw err;
    }
  }
}

// =======================
// Verificar se é short link
// =======================
function isShortLink(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  
  const shortDomains = [
    // Amazon
    "amzn.to", "amzn.com/", "a.co/",
    // Shopee
    "shp.ee", "s.shopee.",
    // Mercado Livre
    "mercadolivre.com/sec/", "mercadolibre.com/sec/", "meli.com/",
    // Magalu
    "magalu.com/", "mglu.me/",
    // Genéricos
    "bit.ly", "tinyurl.", "t.co/", "goo.gl/"
  ];
  
  return shortDomains.some(d => lower.includes(d));
}

// =======================
// POST /amazon/sign - Gera assinatura AWS V4 para PA-API
// =======================
app.post("/amazon/sign", (req, res) => {
  const { accessKey, secretKey, partnerTag, asin } = req.body;

  if (!accessKey || !secretKey || !partnerTag || !asin) {
    return res.status(400).json({
      ok: false,
      error: "missing_params",
      message: "Campos obrigatórios: accessKey, secretKey, partnerTag, asin"
    });
  }

  try {
    const host = 'webservices.amazon.com.br';
    const region = 'us-east-1';
    const service = 'ProductAdvertisingAPI';

    const payload = {
      "PartnerTag": partnerTag,
      "PartnerType": "Associates",
      "Marketplace": "www.amazon.com.br",
      "ItemIds": [asin],
      "Resources": [
        "ItemInfo.Title",
        "ItemInfo.Features",
        "Offers.Listings.Price",
        "Offers.Listings.SavingBasis",
        "Offers.Listings.Promotions",
        "Images.Primary.Large",
        "Images.Primary.Medium"
      ]
    };

    const body = JSON.stringify(payload);

    const opts = {
      host: host,
      path: '/paapi5/getitems',
      method: 'POST',
      service: service,
      region: region,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'amz-1.0',
        'X-Amz-Target': 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems',
        'Host': host
      },
      body: body
    };

    const credentials = {
      accessKeyId: accessKey,
      secretAccessKey: secretKey
    };

    const signedRequest = aws4.sign(opts, credentials);

    console.log(`[SIGN] ASIN: ${asin}, Partner: ${partnerTag}`);

    return res.json({
      ok: true,
      asin: asin,
      endpoint: `https://${host}/paapi5/getitems`,
      payload: body,
      headers: {
        'Content-Type': signedRequest.headers['Content-Type'],
        'Content-Encoding': signedRequest.headers['Content-Encoding'],
        'Host': signedRequest.headers['Host'],
        'X-Amz-Date': signedRequest.headers['X-Amz-Date'],
        'X-Amz-Target': signedRequest.headers['X-Amz-Target'],
        'Authorization': signedRequest.headers['Authorization']
      }
    });

  } catch (err) {
    console.error(`[SIGN ERROR] ${err.message}`);
    return res.status(500).json({
      ok: false,
      error: "sign_failed",
      message: err.message
    });
  }
});

// =======================
// POST /amazon/product - Busca produto direto
// =======================
app.post("/amazon/product", async (req, res) => {
  const { accessKey, secretKey, partnerTag, asin } = req.body;

  if (!accessKey || !secretKey || !partnerTag || !asin) {
    return res.status(400).json({
      ok: false,
      error: "missing_params",
      message: "Campos obrigatórios: accessKey, secretKey, partnerTag, asin"
    });
  }

  try {
    const host = 'webservices.amazon.com.br';
    const region = 'us-east-1';
    const service = 'ProductAdvertisingAPI';

    const payload = {
      "PartnerTag": partnerTag,
      "PartnerType": "Associates",
      "Marketplace": "www.amazon.com.br",
      "ItemIds": [asin],
      "Resources": [
        "ItemInfo.Title",
        "ItemInfo.Features",
        "Offers.Listings.Price",
        "Offers.Listings.SavingBasis",
        "Offers.Listings.Promotions",
        "Images.Primary.Large",
        "Images.Primary.Medium"
      ]
    };

    const body = JSON.stringify(payload);

    const opts = {
      host: host,
      path: '/paapi5/getitems',
      method: 'POST',
      service: service,
      region: region,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'amz-1.0',
        'X-Amz-Target': 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems',
        'Host': host
      },
      body: body
    };

    const credentials = {
      accessKeyId: accessKey,
      secretAccessKey: secretKey
    };

    const signedRequest = aws4.sign(opts, credentials);

    console.log(`[PRODUCT] Fetching ASIN: ${asin}`);

    const response = await axios({
      method: 'POST',
      url: `https://${host}/paapi5/getitems`,
      headers: signedRequest.headers,
      data: body,
      timeout: 30000
    });

    console.log(`[PRODUCT] Success for ASIN: ${asin}`);

    return res.json({
      ok: true,
      asin: asin,
      data: response.data
    });

  } catch (err) {
    console.error(`[PRODUCT ERROR] ${err.message}`);
    
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
      // Campos de compatibilidade
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
// POST /resolve/amazon (específico)
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
// POST /resolve/shopee (específico)
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
// POST /resolve/mercadolivre (NOVO)
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
// POST /resolve/magalu (NOVO)
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
  console.log(`   POST /resolve/mercadolivre - Apenas Mercado Livre (NOVO)`);
  console.log(`   POST /resolve/magalu       - Apenas Magalu (NOVO)`);
  console.log(`   POST /amazon/sign          - Gera assinatura AWS V4 para PA-API`);
  console.log(`   POST /amazon/product       - Busca produto Amazon direto`);
  console.log(`   GET  /health               - Health check`);
});
