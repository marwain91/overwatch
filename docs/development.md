# Development

## Local Development

```bash
# Install dependencies
npm install

# Generate .env from overwatch.yaml (interactive setup)
npm run setup

# Validate .env against config
npm run setup:check

# Start development server (with hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## Building Docker Image

```bash
# Build image
docker build -t overwatch .

# Run locally
docker run -p 3002:3002 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/overwatch.yaml:/app/overwatch.yaml:ro \
  -e JWT_SECRET=dev-secret \
  -e GOOGLE_CLIENT_ID=your-client-id \
  overwatch
```
