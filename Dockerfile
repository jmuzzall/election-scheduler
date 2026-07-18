FROM node:20-slim

WORKDIR /app

# Copy dependency files first (better layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy the rest of the source
COPY . .

# Create directories that must exist at runtime
RUN mkdir -p data uploads

# Fly.io sets PORT; our server.js already reads process.env.PORT
EXPOSE 3000

CMD ["node", "server.js"]
