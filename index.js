
// index.js
// Railway Puppeteer Service
//
// Responsibilities:
// - Accept GET /scrape?url=...
// - DNS pre-check domain
// - Launch headless Chromium with Puppeteer
// - Render page, extract image URLs + metadata
// - Return JSON for the Worker to post-process

const express = require("express");
const puppeteer = require("puppeteer");
const dns = require("dns").promises;

const app = express();

// Optional: JSON body parsing if you later add POST endpoints
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Main scraping endpoint with DNS pre-check
app.get("/scrape", async (req, res) => {
  let url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // Normalize URL
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Scraping request: ${url}`);

  try {
    // Extract hostname for DNS check
    const hostname = new URL(url).hostname;

    // DNS pre-flight check
    console.log(`[DNS] Checking ${hostname}...`);
    try {
      await dns.resolve4(hostname);
      console.log(`[DNS] ✓ Resolved ${hostname}`);
    } catch (dnsError) {
      console.error(`[DNS] ✗ Failed to resolve ${hostname}:`, dnsError.message);
      return res.status(400).json({
        error: "DNS resolution failed",
        hostname,
        suggestion: "Check if the domain exists and is accessible",
      });
    }

    // Launch browser with production-friendly args
    console.log("[Puppeteer] Launching browser...");
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
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost",
        "--dns-prefetch-disable",
      ],
      dumpio: false,
      // If Railway needs custom executable, use:
      // executablePath: process.env.CHROME_EXECUTABLE_PATH,
    });

    console.log("[Puppeteer] Browser launched");

    const page = await browser.newPage();

    // Realistic viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0.0.0 Safari/537.36"
    );

    // Extra headers
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    console.log(`[Puppeteer] Navigating to ${url}...`);

    // Navigate with retries
    let navigationSuccess = false;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: 20000,
        });
        navigationSuccess = true;
        console.log(
          `[Puppeteer] ✓ Navigation successful (attempt ${attempt})`
        );
        break;
      } catch (navError) {
        lastError = navError;
        console.error(
          `[Puppeteer] ✗ Navigation failed (attempt ${attempt}):`,
          navError.message
        );
        if (attempt < 3) {
          console.log("[Puppeteer] Retrying in 2s...");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    if (!navigationSuccess) {
      await browser.close();
      return res.status(500).json({
        error: "Navigation failed after 3 attempts",
        details: lastError ? lastError.message : "Unknown error",
      });
    }

    // Wait for dynamic content
    await page.waitForTimeout(2000);

    console.log("[Puppeteer] Extracting images...");

    const images = await page.evaluate(() => {
      const imgs = [];
      const seenUrls = new Set();

      // Strategy 1: img tags
      document.querySelectorAll("img").forEach((img) => {
        const src =
          img.src ||
          img.dataset?.src ||
          img.dataset?.lazySrc ||
          img.dataset?.original;
        if (src && !seenUrls.has(src)) {
          imgs.push({
            url: src,
            alt: img.getAttribute("alt") || img.getAttribute("title") || "",
            width:
              img.naturalWidth ||
              parseInt(img.getAttribute("width") || "0") ||
              0,
            height:
              img.naturalHeight ||
              parseInt(img.getAttribute("height") || "0") ||
              0,
            source: "img-tag",
          });
          seenUrls.add(src);
        }
      });

      // Strategy 2: background-image
      document.querySelectorAll("*").forEach((el) => {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg !== "none") {
          const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (match && !seenUrls.has(match[1])) {
            imgs.push({
              url: match[1],
              alt: el.getAttribute("aria-label") || "",
              width: el.offsetWidth || 0,
              height: el.offsetHeight || 0,
              source: "background-image",
            });
            seenUrls.add(match[1]);
          }
        }
      });

      // Strategy 3: picture sources
      document
        .querySelectorAll("picture source, picture img")
        .forEach((el) => {
          const src = el.srcset?.split(" ")[0] || el.src;
          if (src && !seenUrls.has(src)) {
            imgs.push({
              url: src,
              alt: el.alt || "",
              width: 0,
              height: 0,
              source: "picture-element",
            });
            seenUrls.add(src);
          }
        });

      // Filter tiny / data URLs
      return imgs.filter(
        (img) =>
          img.url &&
          !img.url.startsWith("data:") &&
          (/\.(jpg|jpeg|png|webp)/i.test(img.url) ||
            img.url.toLowerCase().includes("image"))
      );
    });

    await browser.close();

    const duration = Date.now() - startTime;
    console.log(
      `[Puppeteer] ✓ Found ${images.length} images in ${duration}ms`
    );

    return res.json({
      success: true,
      url,
      images,
      count: images.length,
      duration_ms: duration,
    });
  } catch (error) {
    console.error("[ERROR]", error);
    return res.status(500).json({
      error: (error && error.message) || "Unknown error",
      stack:
        process.env.NODE_ENV === "development"
          ? error.stack
          : undefined,
    });
  }
});

// Optional: simple non-JS fallback
app.get("/scrape-simple", async (req, res) => {
  let url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url" });

  if (!url.startsWith("http")) url = "https://" + url;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const html = await response.text();

    const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    const images = [];
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
      images.push({ url: match[1], source: "regex" });
    }

    res.json({
      images,
      count: images.length,
      method: "simple-fetch",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("========================================");
  console.log("Scraper Service v2.0 (Production)");
  console.log(`Listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log("========================================");
});