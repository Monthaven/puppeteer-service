# Dockerfile for Railway Puppeteer + Cheerio service

FROM ghcr.io/puppeteer/puppeteer:latest

# Create app directory
WORKDIR /usr/src/app

# Copy package files first
COPY package.json package-lock.json* ./

# Install dependencies (uses the pre-installed Chromium)
RUN npm install --production

# Copy the rest of the app
COPY . .

# Expose port Railway expects
EXPOSE 3000

# Start command
CMD [ "npm", "start" ]
