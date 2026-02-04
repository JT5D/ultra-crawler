#!/bin/bash
# Ultra-Crawler Quick Start
# Single command to install and run the crawler + visualization

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════════════════════════════"
echo "  🚀 Ultra-Crawler - High Performance Multi-Source Crawler"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js 20+ required. Current: $(node -v 2>/dev/null || echo 'not installed')"
    echo "   Install with: brew install node@20 (macOS) or nvm install 20"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install --silent
else
    echo "✅ Dependencies already installed"
fi

# Parse arguments
MODE="${1:-visualize}"
shift 2>/dev/null || true

case "$MODE" in
    visualize|viz|v)
        echo "🎨 Starting visualizer server..."
        echo "   Open: http://localhost:${PORT:-3000}"
        echo ""
        node visualizer-server.js
        ;;
    fs|filesystem)
        PATH_ARG="${1:-.}"
        echo "📁 Crawling filesystem: $PATH_ARG"
        node crawler.js --mode=filesystem --path="$PATH_ARG" "${@:2}"
        echo ""
        echo "🎨 Starting visualizer..."
        node visualizer-server.js
        ;;
    web)
        URL_ARG="${1:-https://example.com}"
        echo "🌐 Crawling web: $URL_ARG"
        node crawler.js --mode=web --url="$URL_ARG" "${@:2}"
        echo ""
        echo "🎨 Starting visualizer..."
        node visualizer-server.js
        ;;
    s3)
        BUCKET="${1:?S3 bucket name required}"
        echo "☁️ Crawling S3: s3://$BUCKET"
        node crawler.js --mode=s3 --bucket="$BUCKET" "${@:2}"
        echo ""
        echo "🎨 Starting visualizer..."
        node visualizer-server.js
        ;;
    gdrive)
        echo "📁 Crawling Google Drive"
        node crawler.js --mode=gdrive "$@"
        echo ""
        echo "🎨 Starting visualizer..."
        node visualizer-server.js
        ;;
    help|--help|-h)
        echo "Usage: ./start.sh [mode] [options]"
        echo ""
        echo "Modes:"
        echo "  visualize    Start visualizer server only (default)"
        echo "  fs <path>    Crawl filesystem then visualize"
        echo "  web <url>    Crawl website then visualize"
        echo "  s3 <bucket>  Crawl S3 bucket then visualize"
        echo "  gdrive       Crawl Google Drive then visualize"
        echo ""
        echo "Examples:"
        echo "  ./start.sh                          # Start visualizer"
        echo "  ./start.sh fs ~/Projects            # Crawl folder"
        echo "  ./start.sh web https://docs.dev     # Crawl website"
        echo "  ./start.sh fs . --depth=5           # Crawl with options"
        ;;
    *)
        echo "❌ Unknown mode: $MODE"
        echo "   Run: ./start.sh help"
        exit 1
        ;;
esac
