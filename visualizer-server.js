#!/usr/bin/env node
/**
 * Visualizer Server - Real-time Three.js visualization with live crawling
 * WebSocket for real-time updates, REST API for search
 *
 * STREAMING: Uses crawlEvents from crawler.js for real-time node emission
 */

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CRAWL_OUTPUT = './crawl-output';

// MIME types
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// In-memory graph cache
let graphData = null;
let db = null;

// Active crawl tracking
let activeCrawl = null;

// Load database
async function loadDatabase() {
  const dbPath = join(CRAWL_OUTPUT, 'crawl.db');
  if (!existsSync(dbPath)) return null;

  const Database = (await import('better-sqlite3')).default;
  return new Database(dbPath, { readonly: true });
}

// Load graph data
async function loadGraph() {
  const jsonPath = join(CRAWL_OUTPUT, 'crawl-graph.json');
  if (!existsSync(jsonPath)) return null;

  const data = await readFile(jsonPath, 'utf8');
  return JSON.parse(data);
}

// Search nodes
function searchNodes(query, limit = 100) {
  if (!db) return [];

  const stmt = db.prepare(`
    SELECT id, path, name, type, size, depth, ext
    FROM nodes
    WHERE name LIKE ? OR path LIKE ?
    LIMIT ?
  `);

  return stmt.all(`%${query}%`, `%${query}%`, limit);
}

// Get node by ID with children
function getNode(id) {
  if (!db) return null;

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  if (!node) return null;

  const children = db.prepare('SELECT * FROM nodes WHERE parent_id = ? LIMIT 1000').all(id);
  return { ...node, children };
}

// HTTP Server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // API Routes
  if (url.pathname === '/api/graph') {
    graphData = graphData || await loadGraph();
    res.writeHead(graphData ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(graphData || { error: 'No data. Run crawler first.' }));
  }

  if (url.pathname === '/api/search') {
    db = db || await loadDatabase();
    const query = url.searchParams.get('q') || '';
    const results = searchNodes(query);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(results));
  }

  if (url.pathname === '/api/node') {
    db = db || await loadDatabase();
    const id = parseInt(url.searchParams.get('id'));
    const node = getNode(id);
    res.writeHead(node ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(node || { error: 'Not found' }));
  }

  if (url.pathname === '/api/stats') {
    db = db || await loadDatabase();
    if (!db) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No database' }));
    }

    const stats = {
      totalNodes: db.prepare('SELECT COUNT(*) as count FROM nodes').get().count,
      totalEdges: db.prepare('SELECT COUNT(*) as count FROM edges').get().count,
      byType: db.prepare('SELECT type, COUNT(*) as count FROM nodes GROUP BY type').all(),
      byExt: db.prepare('SELECT ext, COUNT(*) as count FROM nodes WHERE ext IS NOT NULL GROUP BY ext ORDER BY count DESC LIMIT 20').all(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(stats));
  }

  // Serve static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = join(__dirname, 'public', filePath);

  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// WebSocket for real-time crawl updates
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`📡 Client connected (${clients.size} total)`);

  // Send current stats on connect
  (async () => {
    db = db || await loadDatabase();
    if (db) {
      const stats = {
        totalNodes: db.prepare('SELECT COUNT(*) as count FROM nodes').get().count,
        totalEdges: db.prepare('SELECT COUNT(*) as count FROM edges').get().count,
      };
      ws.send(JSON.stringify({ type: 'stats', data: stats }));
    }
  })();

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'crawl') {
        // Prevent multiple concurrent crawls
        if (activeCrawl) {
          ws.send(JSON.stringify({ type: 'error', data: 'Crawl already in progress' }));
          return;
        }

        // Build crawl command with streaming flag
        const args = ['crawler.js', '--mode', msg.mode, '--streaming'];
        if (msg.path) args.push('--path', msg.path);
        if (msg.url) args.push('--url', msg.url);
        if (msg.bucket) args.push('--bucket', msg.bucket);
        if (msg.depth) args.push('--depth', String(msg.depth));

        console.log(`🚀 Starting crawl: ${args.join(' ')}`);
        ws.send(JSON.stringify({ type: 'crawl-start', mode: msg.mode }));

        activeCrawl = spawn('node', args, { cwd: __dirname });

        activeCrawl.stdout.on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            // Parse progress from log output
            if (line.includes('Processing') || line.includes('Processed')) {
              broadcast({ type: 'log', data: line });
            } else if (line.includes('✅')) {
              broadcast({ type: 'log', data: line });
            } else {
              broadcast({ type: 'log', data: line });
            }
          }
        });

        activeCrawl.stderr.on('data', (chunk) => {
          broadcast({ type: 'error', data: chunk.toString() });
        });

        activeCrawl.on('close', async (code) => {
          activeCrawl = null;
          graphData = await loadGraph();
          db = await loadDatabase();

          broadcast({
            type: 'complete',
            success: code === 0,
            stats: graphData?.metadata || {},
          });

          // Send full graph for final render
          if (graphData) {
            broadcast({ type: 'graph', data: graphData });
          }
        });
      }

      if (msg.type === 'get-graph') {
        graphData = graphData || await loadGraph();
        ws.send(JSON.stringify({ type: 'graph', data: graphData }));
      }

      if (msg.type === 'cancel-crawl') {
        if (activeCrawl) {
          activeCrawl.kill('SIGTERM');
          activeCrawl = null;
          broadcast({ type: 'cancelled' });
        }
      }

    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', data: err.message }));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`📡 Client disconnected (${clients.size} remaining)`);
  });
});

// Broadcast to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// Ensure output directory exists
if (!existsSync(CRAWL_OUTPUT)) {
  mkdirSync(CRAWL_OUTPUT, { recursive: true });
}

server.listen(PORT, () => {
  console.log(`\n🎨 Ultra-Crawler Visualizer`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready for real-time streaming\n`);
});

