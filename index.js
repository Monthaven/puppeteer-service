const express = require('express');
const puppeteer = require('puppeteer');

const app = express();

app.get('/scrape', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  
  try {
    const browser = await puppeteer.launch({ 
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',  // Add this
        '--disable-gpu',             // Add this
      ]
    });
    
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    
    const images = await page.evaluate(() => {
      const imgs = [];
      document.querySelectorAll('img').forEach(img => {
        imgs.push({
          url: img.src,
          alt: img.alt || '',
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0
        });
      });
      return imgs;
    });
    
    await browser.close();
    res.json({ images });
  } catch (error) {
    console.error('Scraping error:', error);  // Add this
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper ready on :${PORT}`));