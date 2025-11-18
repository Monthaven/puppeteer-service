# Dockerfile for Railway Puppeteer + Cheerio service

FROM ghcr.io/puppeteer/puppeteer:latest

# Create app directory
WORKDIR /usr/src/app

# Copy package files first
COPY package.json package-lock.json* ./

# Fix permissions and install dependencies (uses the pre-installed Chromium)
USER root
RUN chown -R pptruser:pptruser /usr/src/app
USER pptruser
RUN npm install --omit=dev --unsafe-perm

# Copy the rest of the app
COPY . .

# Expose port Railway expects
EXPOSE 3000

# Start command
CMD [ "npm", "start" ]
