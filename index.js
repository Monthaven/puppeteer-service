

// index.js - Railway scraper API (heavy work)
// Run on Railway with Puppeteer + Cheerio

const express = require("express");
const puppeteer = require("puppeteer");
const dns = require("dns").promises;
const cheerio = require("cheerio");

const app = express();
app.use(express.json());

const CONFIG = {
  MAX_IMAGES: 20,
  MIN_IMAGE_WIDTH: 400,
  MIN_IMAGE_HEIGHT: 300,
  MIN_SCORE: 20,
  PUPPETEER_TIMEOUT_MS: 20000,
};

function isValidImageUrl(url) {
  if (!url || url.length < 10) return false;
  if (url.startsWith("data:")) return false;
  if (url.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)) return true;
  if (url.toLowerCase().includes("image") || url.toLowerCase().includes("photo")) return true;
  return false;
}

function isJunkImageUrl(url, alt = "") {
  const combined = (url + " " + alt).toLowerCase();
  const junkPatterns = [
    /logo/i,
    /icon/i,
    /favicon/i,
    /sprite/i,
    /badge/i,
    /button/i,
    /arrow/i,
    /social[-_]?media/i,
    /facebook|twitter|instagram|linkedin/i,
    /nav/i,
    /placeholder/i,
    /loading/i,
    /spacer/i,
    /pixel/i,
    /tracking/i,
    /1x1\./i,
    /\.(svg|gif)$/i,
    /data:image/i,
    /thumbnail/i,
    /watermark/i,
  ];
  return junkPatterns.some((re) => re.test(combined));
}

function categorizeImage(url, alt = "") {
  const s = (url + " " + alt).toLowerCase();
  if (s.match(/hero|banner|main|primary|cover/) && !s.match(/interior|unit/)) return "Hero";
  if (s.match(/exterior|building|facade|aerial|drone|property|entrance/)) return "Exterior";
  if (s.match(/interior|unit|apartment|bedroom|kitchen|bathroom|living/)) return "Unit";
  if (s.match(/amenity|amenities|pool|gym|fitness|clubhouse|lounge/)) return "Amenities";
  return "Other";
}

function scoreImage(url, alt, width, height) {
  let score = 50;

  if (width > 1200 || height > 800) score += 30;
  else if (width > 800 || height > 600) score += 20;
  else if (width > 400 || height > 300) score += 10;
  else if (width && width < CONFIG.MIN_IMAGE_WIDTH) score -= 40;

  const u = url.toLowerCase();
  if (u.includes("/upload/") || u.includes("/media/")) score += 10;
  if (u.match(/\d{4,}x\d{4,}/)) score += 15;
  if (u.includes("thumbnail")) score -= 20;
  if (alt && alt.length > 10) score += 10;
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) score += 5;
  if (u.endsWith(".webp")) score += 10;

  return Math.max(0, Math.min(100, score));
}

function dedupeAndSort(images) {
  const seen = new Set();
  const out = [];

  for (const img of images) {
    if (!seen.has(img.url)) {
      seen.add(img.url);
      out.push(img);
    }
  }

  return out
    .filter((img) => img.score == null || img.score >= CONFIG.MIN_SCORE)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, CONFIG.MAX_IMAGES);
}

// —————————————————————————————
// Strategy 1: Cheerio (static HTML)
// —————————————————————————————
async function scrapeWithCheerio(pageUrl) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!res.ok) {
      console.warn("Cheerio fetch non-OK:", res.status);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const images = [];
    const seen = new Set();

    function process(src, $el) {
      if (!src) return;
      let url;
      try {
        url = src.startsWith("http") ? src : new URL(src, pageUrl).toString();
      } catch {
        return;
      }
      if (!isValidImageUrl(url)) return;
      if (seen.has(url)) return;

      const alt = $el ? $el.attr("alt") || $el.attr("title") || "" : "";
      if (isJunkImageUrl(url, alt)) return;

      const width = $el ? parseInt($el.attr("width") || "0") : 0;
      const height = $el ? parseInt($el.attr("height") || "0") : 0;
      const score = scoreImage(url, alt, width, height);
      const category = categorizeImage(url, alt);

      seen.add(url);
      images.push({ url, alt, width, height, score, category });
    }

    // 1: img tags
    $("img").each((_, el) => {
      const $el = $(el);
      const src =
        $el.attr("src") ||
        $el.attr("data-src") ||
        $el.attr("data-lazy-src") ||
        $el.attr("data-original");
      process(src, $el);
    });

    // 2: picture
    $("picture source, picture img").each((_, el) => {
      const $el = $(el);
      const src = $el.attr("srcset")?.split(" ")[0] || $el.attr("src");
      process(src, $el);
    });

    // 3: meta tags (og:image etc.)
    $('meta[property^="og:image"], meta[name^="twitter:image"]').each((_, el) => {
      const $el = $(el);
      const content = $el.attr("content");
      process(content, null);
    });

    return dedupeAndSort(images);
  } catch (err) {
    console.error("Cheerio scrape failed:", err.message);
    return [];
  }
}

// —————————————————————————————
// Strategy 2: Puppeteer (JS rendered)
// —————————————————————————————
async function scrapeWithPuppeteer(pageUrl) {
  let url = pageUrl;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  // DNS pre-check
  const hostname = new URL(url).hostname;
  try {
    await dns.resolve4(hostname);
  } catch (err) {
    console.error("DNS failed:", err.message);
    return [];
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    let success = false;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: CONFIG.PUPPETEER_TIMEOUT_MS,
        });
        success = true;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!success) {
      console.error("Puppeteer navigation failed:", lastError?.message);
      return [];
    }

    await page.waitForTimeout(2000);

    const rawImages = await page.evaluate(() => {
      const imgs = [];
      const seen = new Set();

      // img tags
      document.querySelectorAll("img").forEach((img) => {
        const src = img.src || img.dataset.src || img.dataset.lazySrc || img.dataset.original;
        if (src && !seen.has(src)) {
          imgs.push({
            url: src,
            alt: img.alt || img.title || "",
            width: img.naturalWidth || parseInt(img.getAttribute("width") || "0"),
            height: img.naturalHeight || parseInt(img.getAttribute("height") || "0"),
          });
          seen.add(src);
        }
      });

      // picture
      document.querySelectorAll("picture source, picture img").forEach((el) => {
        const src = el.srcset?.split(" ")[0] || el.src;
        if (src && !seen.has(src)) {
          imgs.push({
            url: src,
            alt: el.alt || "",
            width: 0,
            height: 0,
          });
          seen.add(src);
        }
      });

      return imgs;
    });

    const images = [];
    for (const img of rawImages) {
      if (!isValidImageUrl(img.url)) continue;
      if (isJunkImageUrl(img.url, img.alt)) continue;

      const score = 50; // base; will be refined by server
      const category = categorizeImage(img.url, img.alt);
      images.push({
        url: img.url,
        alt: img.alt || "",
        width: img.width || 0,
        height: img.height || 0,
        score,
        category,
      });
    }

    // refine scores
    for (const img of images) {
      img.score = scoreImage(img.url, img.alt, img.width, img.height);
    }

    return dedupeAndSort(images);
  } finally {
    await browser.close();
  }
}

// —————————————————————————————
// "Ultimate" scraper orchestrator
// —————————————————————————————
async function scrapeImagesUltimate(pageUrl) {
  console.log("Scraping:", pageUrl);

  // Strategy 1: Cheerio
  let images = await scrapeWithCheerio(pageUrl);
  if (images.length >= 5) {
    console.log("Cheerio found enough images:", images.length);
    return images;
  }

  // Strategy 2: Puppeteer
  console.log("Cheerio insufficient, falling back to Puppeteer");
  const puppeteerImages = await scrapeWithPuppeteer(pageUrl);
  images = images.concat(puppeteerImages);

  return dedupeAndSort(images);
}

// —————————————————————————————
// Routes
// —————————————————————————————

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// Main endpoint Worker will call
app.get("/full-scrape", async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl) {
    return res.status(400).json({ success: false, error: "Missing url parameter" });
  }

  const start = Date.now();
  try {
    const images = await scrapeImagesUltimate(String(pageUrl));
    const duration = Date.now() - start;

    return res.json({
      success: true,
      url: pageUrl,
      count: images.length,
      duration_ms: duration,
      images,
    });
  } catch (err) {
    console.error("full-scrape error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Unknown error",
    });
  }
});

// Optional: legacy /scrape that just does Puppeteer
app.get("/scrape", async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl) {
    return res.status(400).json({ success: false, error: "Missing url parameter" });
  }

  try {
    const images = await scrapeWithPuppeteer(String(pageUrl));
    res.json({
      success: true,
      url: pageUrl,
      count: images.length,
      images,
    });
  } catch (err) {
    console.error("scrape error:", err);
    res.status(500).json({ success: false, error: err.message || "Unknown error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("========================================");
  console.log("Scraper Service v3.0 (Railway)");
  console.log(`Listening on port ${PORT}`);
  console.log("========================================");
});