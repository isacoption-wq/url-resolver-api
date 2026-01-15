const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

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
    /\/product\/([A-Z0-9]{10})/i,
    /\/ASIN\/([A-Z0-9]{10})/i,
    /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})/i,
    /amazon\.[a-z.]+\/([A-Z0-9]{10})(?:\/|$|\?)/i,
    /\?.*asin=([A-Z0-9]{10})/i
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1].toUpperCase();
    }
  }

  return null;
}

// =======================
// Detectar Plataforma
// =======================
function detectPlatform(url) {
  if (!url) return 'unknown';
  
  const lower = url.toLowerCase();
  
  // Amazon
  if (lower.includes('amazon.') || 
      lower.includes('amzn.to') || 
      lower.includes('amzn.com') ||
      lower.includes('a.co/')) {
    return 'amazon';
  }
  
  // Shopee
  if (lower.includes('shopee.') || 
      lower.includes('shp.ee') ||
      lower.includes('s.shopee.')) {
    return 'shopee';
  }
  
  return 'unknown';
}

// =======================
// Resolve URL curta
// =======================
async function resolveUrl(url) {
  try {
    const res = await axios.get(url, {
      maxRedirects: 10,
      timeout: 10000,
      validateStatus: null,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    // axios guarda a URL final aqui
    return res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl || url;
  } catch (err) {
    // Em caso de erro, tenta método HEAD
    try {
      const headRes = await axios.head(url, {
        maxRedirects: 10,
        timeout: 10000,
        validateStatus: null,
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      });
      return headRes.request?.res?.responseUrl || url;
    } catch {
      throw err;
    }
  }
}

// =======================
// POST /resolve (unificado)
// =======================
app.post("/resolve", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      ok: false,
      error: "url_required",
      platform: null
    });
  }

  try {
    // Detectar plataforma da URL original
    let platform = detectPlatform(url);
    
    // Resolver URL curta se necessário
    const isShortLink = url.includes('amzn.to') || 
                        url.includes('a.co/') || 
                        url.includes('shp.ee') || 
                        url.includes('s.shopee.');
    
    const finalUrl = isShortLink ? await resolveUrl(url) : url;
    
    // Re-detectar plataforma após resolver (mais preciso)
    platform = detectPlatform(finalUrl);

    // Extrair IDs baseado na plataforma
    if (platform === 'amazon') {
      const asin = extractAmazonAsin(finalUrl);
      
      return res.json({
        ok: !!asin,
        platform: 'amazon',
        url_original: url,
        url_resolved: finalUrl,
        was_short_link: isShortLink,
        asin: asin || null,
        // Manter compatibilidade com Shopee
        shopId: null,
        itemId: null
      });
    }
    
    if (platform === 'shopee') {
      const ids = extractShopeeIds(finalUrl);
      
      return res.json({
        ok: !!ids,
        platform: 'shopee',
        url_original: url,
        url_resolved: finalUrl,
        was_short_link: isShortLink,
        shopId: ids?.shopId || null,
        itemId: ids?.itemId || null,
        // Campo para compatibilidade
        asin: null
      });
    }

    // Plataforma desconhecida
    return res.json({
      ok: false,
      platform: 'unknown',
      url_original: url,
      url_resolved: finalUrl,
      was_short_link: isShortLink,
      error: 'platform_not_supported'
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      platform: detectPlatform(url),
      error: err.message,
      url_original: url,
      url_resolved: null
    });
  }
});

// =======================
// Rotas específicas (opcional)
// =======================

// POST /resolve/amazon - só Amazon
app.post("/resolve/amazon", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ ok: false, error: "url_required" });
  }

  try {
    const isShortLink = url.includes('amzn.to') || url.includes('a.co/');
    const finalUrl = isShortLink ? await resolveUrl(url) : url;
    const asin = extractAmazonAsin(finalUrl);

    return res.json({
      ok: !!asin,
      url_original: url,
      url_resolved: finalUrl,
      was_short_link: isShortLink,
      asin: asin || null
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      url_original: url
    });
  }
});

// POST /resolve/shopee - só Shopee
app.post("/resolve/shopee", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ ok: false, error: "url_required" });
  }

  try {
    const isShortLink = url.includes('shp.ee') || url.includes('s.shopee.');
    const finalUrl = isShortLink ? await resolveUrl(url) : url;
    const ids = extractShopeeIds(finalUrl);

    return res.json({
      ok: !!ids,
      url_original: url,
      url_resolved: finalUrl,
      was_short_link: isShortLink,
      shopId: ids?.shopId || null,
      itemId: ids?.itemId || null
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      url_original: url
    });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", services: ["amazon", "shopee"] });
});

app.listen(3000, () => {
  console.log("🚀 Universal URL Resolver rodando na porta 3000");
  console.log("📦 Suporta: Amazon, Shopee");
});
