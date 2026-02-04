# 🚀 Ultra-Crawler

**High-performance, non-blocking, multi-threaded Node.js crawler with real-time Three.js visualization**

## Features

| Source | Speed | Method |
|--------|-------|--------|
| **Filesystem** | 1M+ files/sec | `fdir` (fastest FS crawler) |
| **Web** | 50+ concurrent | `undici` + `cheerio` |
| **AWS S3** | 35K+ objects/sec | Parallel prefix listing |
| **Google Drive** | Batched API | Paginated with rate limiting |

## Quick Start

```bash
cd ultra-crawler
npm install
npm start -- --mode=filesystem --path=/Users --depth=5
```

## Usage

### CLI Commands

```bash
# Filesystem crawl
node crawler.js --mode=filesystem --path=/path/to/crawl --depth=10

# Web crawl
node crawler.js --mode=web --url=https://example.com --depth=3 --concurrency=50

# S3 bucket
node crawler.js --mode=s3 --bucket=my-bucket --prefix=data/

# Google Drive (requires credentials.json + token.json)
node crawler.js --mode=gdrive
```

### Real-time Visualization

```bash
# Start the visualizer server
node visualizer-server.js

# Open http://localhost:3000
```

## Output

- **`crawl-output/crawl.db`** - SQLite database (fast queries)
- **`crawl-output/crawl-graph.json`** - Three.js-ready JSON graph

### JSON Schema

```json
{
  "metadata": { "totalNodes": 10000, "totalEdges": 9999 },
  "nodes": [
    {
      "id": 1,
      "path": "/path/to/file",
      "name": "file.js",
      "type": "file",       // file, directory, url, bucket
      "size": 1234,
      "depth": 3,
      "color": "#f7df1e",   // For Three.js
      "radius": 4.5         // Log-scaled size
    }
  ],
  "edges": [
    { "source": 1, "target": 2, "type": "child" }
  ],
  "hierarchy": [...]        // Nested tree for tree views
}
```

## Visualization Views

- **Force Graph** - 3D force-directed layout
- **Tree** - Radial tree by depth
- **Sunburst** - Spherical distribution

## Performance Tips

1. Use `--depth` to limit crawl depth
2. S3: Use `--prefix` to target specific folders
3. Web: Adjust `--concurrency` based on target server
4. Large datasets: Visualization caps at 5000 nodes for performance

## Requirements

- Node.js 20+
- macOS, Linux, or Windows

## Cloud Setup

### AWS S3
```bash
# Set credentials
export AWS_ACCESS_KEY_ID=xxx
export AWS_SECRET_ACCESS_KEY=xxx
export AWS_REGION=us-east-1
```

### Google Drive
1. Create OAuth credentials at https://console.cloud.google.com
2. Download as `credentials.json`
3. Run `npx google-drive-auth` to generate `token.json`

## License

MIT
