#!/usr/bin/env node
/**
 * Ultra-Crawler: High-Performance Multi-Source Crawler
 *
 * Features:
 * - Filesystem: Uses fdir (1M+ files/sec)
 * - Web: Non-blocking concurrent HTTP with undici + cheerio
 * - S3: Parallel prefix-based listing
 * - Google Drive: Batched API calls with pagination
 *
 * Output: SQLite DB + JSON for Three.js visualization
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus, availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, basename } from 'node:path';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { program } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // Concurrency settings
  maxWorkers: availableParallelism?.() || cpus().length,
  webConcurrency: 50,           // Parallel HTTP requests
  s3Concurrency: 20,            // Parallel S3 API calls
  gdriveConcurrency: 10,        // Google API rate limit aware

  // Limits
  maxDepth: 10,                 // Max crawl depth
  maxNodes: 1_000_000,          // Max nodes to crawl
  requestTimeout: 30_000,       // 30s timeout

  // Output
  outputDir: './crawl-output',
  dbFile: 'crawl.db',
  jsonFile: 'crawl-graph.json',
};

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE LAYER (SQLite for speed + durability)
// ═══════════════════════════════════════════════════════════════════════════
class CrawlDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.insertNodeStmt = null;
    this.insertEdgeStmt = null;
    this.nodeCount = 0;
    this.edgeCount = 0;
  }

  async init() {
    const Database = (await import('better-sqlite3')).default;
    this.db = new Database(this.dbPath);

    // Optimize for bulk inserts
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000'); // 64MB cache
    this.db.pragma('temp_store = MEMORY');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER DEFAULT 0,
        depth INTEGER DEFAULT 0,
        parent_id INTEGER,
        ext TEXT,
        mime TEXT,
        created_at INTEGER,
        modified_at INTEGER,
        metadata TEXT,
        UNIQUE(path)
      );

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        type TEXT DEFAULT 'child',
        FOREIGN KEY(source_id) REFERENCES nodes(id),
        FOREIGN KEY(target_id) REFERENCES nodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    `);

    this.insertNodeStmt = this.db.prepare(`
      INSERT OR IGNORE INTO nodes (path, name, type, size, depth, parent_id, ext, mime, created_at, modified_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertEdgeStmt = this.db.prepare(`
      INSERT INTO edges (source_id, target_id, type) VALUES (?, ?, ?)
    `);

    return this;
  }

  insertNode(node) {
    const result = this.insertNodeStmt.run(
      node.path,
      node.name,
      node.type,
      node.size || 0,
      node.depth || 0,
      node.parentId || null,
      node.ext || null,
      node.mime || null,
      node.createdAt || null,
      node.modifiedAt || null,
      node.metadata ? JSON.stringify(node.metadata) : null
    );
    this.nodeCount++;
    return result.lastInsertRowid;
  }

  insertEdge(sourceId, targetId, type = 'child') {
    this.insertEdgeStmt.run(sourceId, targetId, type);
    this.edgeCount++;
  }

  // Batch insert for maximum performance
  insertNodesBatch(nodes) {
    const insert = this.db.transaction((nodes) => {
      for (const node of nodes) {
        this.insertNode(node);
      }
    });
    insert(nodes);
  }

  // Export to Three.js compatible JSON
  exportToJSON(outputPath) {
    const nodes = this.db.prepare(`
      SELECT id, path, name, type, size, depth, parent_id, ext, metadata
      FROM nodes ORDER BY id
    `).all();

    const edges = this.db.prepare(`
      SELECT source_id, target_id, type FROM edges
    `).all();

    // Format for Three.js force-directed graph or tree visualization
    const graph = {
      metadata: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        crawledAt: new Date().toISOString(),
        version: '1.0'
      },
      nodes: nodes.map(n => ({
        id: n.id,
        path: n.path,
        name: n.name,
        type: n.type,           // 'file', 'directory', 'url', 'bucket', etc.
        size: n.size,
        depth: n.depth,
        parentId: n.parent_id,
        ext: n.ext,
        // Visualization hints
        color: this.getColorForType(n.type, n.ext),
        radius: Math.log10(Math.max(n.size, 1)) + 1,
        metadata: n.metadata ? JSON.parse(n.metadata) : null
      })),
      edges: edges.map(e => ({
        source: e.source_id,
        target: e.target_id,
        type: e.type
      })),
      // Hierarchy for tree visualization
      hierarchy: this.buildHierarchy(nodes)
    };

    return writeFile(outputPath, JSON.stringify(graph, null, 2));
  }

  getColorForType(type, ext) {
    const colors = {
      directory: '#4a90d9',
      file: '#8bc34a',
      url: '#ff9800',
      bucket: '#9c27b0',
      // Extensions
      '.js': '#f7df1e',
      '.ts': '#3178c6',
      '.py': '#3776ab',
      '.html': '#e34c26',
      '.css': '#264de4',
      '.json': '#000000',
      '.md': '#083fa1',
      '.jpg': '#ff6b6b',
      '.png': '#ff6b6b',
      '.mp4': '#e91e63',
      '.pdf': '#f44336',
    };
    return colors[ext] || colors[type] || '#666666';
  }

  buildHierarchy(nodes) {
    // Build hierarchy from paths (more reliable than parentId which may be null)
    const root = {
      name: 'root',
      type: 'directory',
      size: 0,
      children: [],
      path: ''
    };

    // Find common path prefix to normalize
    const paths = nodes.map(n => n.path);
    const commonPrefix = this.findCommonPrefix(paths);

    // Group nodes by their parent directory
    for (const node of nodes) {
      const relativePath = node.path.replace(commonPrefix, '').replace(/^\//, '');
      const parts = relativePath.split('/').filter(Boolean);

      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;

        if (isLast) {
          // This is the actual node
          current.children.push({
            id: node.id,
            name: node.name,
            type: node.type,
            size: node.size || 0,
            ext: node.ext,
            path: node.path,
            children: node.type === 'directory' ? [] : undefined
          });
        } else {
          // Find or create intermediate directory
          let child = current.children.find(c => c.name === part && c.type === 'directory');
          if (!child) {
            child = {
              name: part,
              type: 'directory',
              size: 0,
              children: [],
              path: commonPrefix + '/' + parts.slice(0, i + 1).join('/')
            };
            current.children.push(child);
          }
          current = child;
        }
      }
    }

    // Merge directories that were created as intermediates with actual directory nodes
    this.mergeDirectories(root);

    // Calculate directory sizes
    this.calculateSizes(root);

    // Sort children: directories first, then by size
    this.sortChildren(root);

    // Return direct children if only one root, otherwise return root
    if (root.children.length === 1) {
      return root.children;
    }
    return [{ ...root, name: paths[0]?.split('/')[1] || 'crawl' }];
  }

  findCommonPrefix(paths) {
    if (!paths.length) return '';
    if (paths.length === 1) return paths[0].substring(0, paths[0].lastIndexOf('/'));

    const sorted = paths.slice().sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    let i = 0;
    while (i < first.length && first[i] === last[i]) i++;

    // Trim to last complete directory
    let prefix = first.substring(0, i);
    const lastSlash = prefix.lastIndexOf('/');
    return lastSlash >= 0 ? prefix.substring(0, lastSlash) : '';
  }

  mergeDirectories(node) {
    if (!node.children) return;

    // Group children by name
    const byName = new Map();
    for (const child of node.children) {
      const existing = byName.get(child.name);
      if (existing && existing.type === 'directory' && child.type === 'directory') {
        // Merge children
        existing.children.push(...(child.children || []));
        if (child.id) existing.id = child.id;
        if (child.size) existing.size = child.size;
      } else {
        byName.set(child.name, child);
      }
    }

    node.children = Array.from(byName.values());

    // Recurse
    for (const child of node.children) {
      this.mergeDirectories(child);
    }
  }

  calculateSizes(node) {
    if (!node.children || node.children.length === 0) {
      return node.size || 0;
    }

    let totalSize = node.size || 0;
    for (const child of node.children) {
      totalSize += this.calculateSizes(child);
    }
    node.size = totalSize;
    return totalSize;
  }

  sortChildren(node) {
    if (!node.children) return;

    node.children.sort((a, b) => {
      // Directories first
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (b.type === 'directory' && a.type !== 'directory') return 1;
      // Then by size (descending)
      return (b.size || 0) - (a.size || 0);
    });

    for (const child of node.children) {
      this.sortChildren(child);
    }
  }

  getStats() {
    return { nodes: this.nodeCount, edges: this.edgeCount };
  }

  close() {
    this.db.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FILESYSTEM CRAWLER (Fastest: uses fdir)
// ═══════════════════════════════════════════════════════════════════════════
async function crawlFilesystem(rootPath, db, options = {}) {
  const { fdir } = await import('fdir');
  const { maxDepth = CONFIG.maxDepth } = options;

  console.log(`🔍 Crawling filesystem: ${rootPath}`);
  const startTime = performance.now();

  // fdir is the fastest directory crawler for Node.js
  const crawler = new fdir()
    .withFullPaths()
    .withDirs()
    .withMaxDepth(maxDepth)
    .crawl(rootPath);

  const paths = await crawler.withPromise();

  console.log(`📊 Found ${paths.length} items in ${((performance.now() - startTime) / 1000).toFixed(2)}s`);

  // Build nodes with parent relationships
  const pathToId = new Map();
  const nodes = [];
  const edges = [];
  let id = 1;

  // Sort by path length to ensure parents are processed first
  paths.sort((a, b) => a.split('/').length - b.split('/').length);

  // Process in batches for memory efficiency
  const BATCH_SIZE = 10000;

  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    const batchNodes = [];

    for (const fullPath of batch) {
      try {
        const stat = statSync(fullPath);
        const parentPath = dirname(fullPath);
        const depth = fullPath.split('/').length - rootPath.split('/').length;

        const node = {
          path: fullPath,
          name: basename(fullPath),
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          depth,
          parentId: pathToId.get(parentPath) || null,
          ext: stat.isFile() ? extname(fullPath).toLowerCase() : null,
          createdAt: Math.floor(stat.birthtimeMs),
          modifiedAt: Math.floor(stat.mtimeMs),
        };

        const nodeId = db.insertNode(node);
        pathToId.set(fullPath, nodeId);

        // Create edge to parent
        if (node.parentId) {
          db.insertEdge(node.parentId, nodeId, 'child');
        }
      } catch (err) {
        // Skip inaccessible files
      }
    }

    if (i % 50000 === 0) {
      console.log(`  Processed ${i}/${paths.length} items...`);
    }
  }

  console.log(`✅ Filesystem crawl complete: ${db.getStats().nodes} nodes`);
}

// ═══════════════════════════════════════════════════════════════════════════
// WEB CRAWLER (Non-blocking concurrent HTTP)
// ═══════════════════════════════════════════════════════════════════════════
async function crawlWeb(startUrl, db, options = {}) {
  const { request } = await import('undici');
  const { load } = await import('cheerio');
  const pLimit = (await import('p-limit')).default;

  const {
    maxDepth = 3,
    maxPages = 1000,
    sameDomain = true,
    concurrency = CONFIG.webConcurrency
  } = options;

  console.log(`🌐 Crawling web: ${startUrl} (depth: ${maxDepth}, concurrency: ${concurrency})`);
  const startTime = performance.now();

  const limit = pLimit(concurrency);
  const visited = new Set();
  const urlToId = new Map();
  const baseUrl = new URL(startUrl);

  // Add root node
  const rootId = db.insertNode({
    path: startUrl,
    name: baseUrl.hostname,
    type: 'url',
    depth: 0
  });
  urlToId.set(startUrl, rootId);
  visited.add(startUrl);

  let queue = [{ url: startUrl, depth: 0, parentId: rootId }];
  let pagesProcessed = 0;

  while (queue.length > 0 && pagesProcessed < maxPages) {
    const batch = queue.splice(0, concurrency);

    const results = await Promise.allSettled(
      batch.map(item => limit(async () => {
        if (visited.has(item.url) || item.depth > maxDepth) return [];
        visited.add(item.url);

        try {
          const { statusCode, headers, body } = await request(item.url, {
            method: 'GET',
            headersTimeout: CONFIG.requestTimeout,
            bodyTimeout: CONFIG.requestTimeout,
            maxRedirections: 5,
            headers: {
              'User-Agent': 'UltraCrawler/1.0',
              'Accept': 'text/html,application/xhtml+xml'
            }
          });

          if (statusCode !== 200) return [];

          const contentType = headers['content-type'] || '';
          if (!contentType.includes('text/html')) return [];

          const html = await body.text();
          const $ = load(html);
          const title = $('title').text().trim() || item.url;

          // Update node with page info
          const nodeId = db.insertNode({
            path: item.url,
            name: title.substring(0, 200),
            type: 'url',
            size: html.length,
            depth: item.depth,
            parentId: item.parentId,
            metadata: {
              statusCode,
              contentType: contentType.split(';')[0]
            }
          });
          urlToId.set(item.url, nodeId);

          if (item.parentId) {
            db.insertEdge(item.parentId, nodeId, 'link');
          }

          pagesProcessed++;

          // Extract links
          const links = [];
          $('a[href]').each((_, el) => {
            try {
              const href = $(el).attr('href');
              if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

              const absoluteUrl = new URL(href, item.url).href;
              const urlObj = new URL(absoluteUrl);

              // Filter same domain if required
              if (sameDomain && urlObj.hostname !== baseUrl.hostname) return;

              // Skip already visited
              if (visited.has(absoluteUrl)) return;

              links.push({
                url: absoluteUrl,
                depth: item.depth + 1,
                parentId: nodeId
              });
            } catch {}
          });

          return links;
        } catch (err) {
          return [];
        }
      }))
    );

    // Collect new URLs
    for (const result of results) {
      if (result.status === 'fulfilled') {
        queue.push(...result.value);
      }
    }

    // Dedupe queue
    const seen = new Set(visited);
    queue = queue.filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });

    if (pagesProcessed % 50 === 0) {
      console.log(`  Crawled ${pagesProcessed} pages, queue: ${queue.length}`);
    }
  }

  console.log(`✅ Web crawl complete: ${pagesProcessed} pages in ${((performance.now() - startTime) / 1000).toFixed(2)}s`);
}

// ═══════════════════════════════════════════════════════════════════════════
// S3 CRAWLER (Parallel prefix-based listing)
// ═══════════════════════════════════════════════════════════════════════════
async function crawlS3(bucketName, db, options = {}) {
  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const pLimit = (await import('p-limit')).default;

  const {
    region = process.env.AWS_REGION || 'us-east-1',
    prefix = '',
    concurrency = CONFIG.s3Concurrency
  } = options;

  console.log(`☁️ Crawling S3: s3://${bucketName}/${prefix}`);
  const startTime = performance.now();

  const client = new S3Client({ region });
  const limit = pLimit(concurrency);

  // Add bucket as root
  const rootId = db.insertNode({
    path: `s3://${bucketName}`,
    name: bucketName,
    type: 'bucket',
    depth: 0
  });

  const pathToId = new Map([[`s3://${bucketName}`, rootId]]);
  let totalObjects = 0;

  // Parallel prefix-based listing for speed
  const listPrefix = async (prefix, parentId, depth) => {
    let continuationToken;
    const objects = [];

    do {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
        Delimiter: '/'
      });

      const response = await client.send(command);

      // Process folders (CommonPrefixes)
      for (const folder of response.CommonPrefixes || []) {
        const folderPath = `s3://${bucketName}/${folder.Prefix}`;
        const folderName = folder.Prefix.split('/').filter(Boolean).pop();

        const folderId = db.insertNode({
          path: folderPath,
          name: folderName,
          type: 'directory',
          depth,
          parentId
        });
        pathToId.set(folderPath, folderId);

        if (parentId) {
          db.insertEdge(parentId, folderId, 'child');
        }

        // Recurse into folder (will be batched)
        objects.push({ prefix: folder.Prefix, parentId: folderId, depth: depth + 1 });
      }

      // Process files
      for (const obj of response.Contents || []) {
        if (obj.Key.endsWith('/')) continue; // Skip folder markers

        const objPath = `s3://${bucketName}/${obj.Key}`;
        const objName = obj.Key.split('/').pop();

        const objId = db.insertNode({
          path: objPath,
          name: objName,
          type: 'file',
          size: obj.Size,
          depth,
          parentId,
          ext: extname(objName).toLowerCase(),
          modifiedAt: obj.LastModified?.getTime()
        });

        if (parentId) {
          db.insertEdge(parentId, objId, 'child');
        }

        totalObjects++;
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objects;
  };

  // Start crawl
  let queue = [{ prefix, parentId: rootId, depth: 1 }];

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);

    const results = await Promise.allSettled(
      batch.map(item => limit(() => listPrefix(item.prefix, item.parentId, item.depth)))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        queue.push(...result.value);
      }
    }

    if (totalObjects % 1000 === 0 && totalObjects > 0) {
      console.log(`  Listed ${totalObjects} objects...`);
    }
  }

  console.log(`✅ S3 crawl complete: ${totalObjects} objects in ${((performance.now() - startTime) / 1000).toFixed(2)}s`);
}

// ═══════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE CRAWLER (Batched API calls)
// ═══════════════════════════════════════════════════════════════════════════
async function crawlGoogleDrive(db, options = {}) {
  const { google } = await import('googleapis');
  const pLimit = (await import('p-limit')).default;

  const {
    credentialsPath = './credentials.json',
    tokenPath = './token.json',
    folderId = 'root',
    concurrency = CONFIG.gdriveConcurrency
  } = options;

  console.log(`📁 Crawling Google Drive: ${folderId}`);
  const startTime = performance.now();

  // Load credentials
  let credentials, token;
  try {
    credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
    token = JSON.parse(await readFile(tokenPath, 'utf8'));
  } catch (err) {
    console.error('❌ Missing credentials.json or token.json');
    console.log('   Run: npx google-drive-auth to generate credentials');
    return;
  }

  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oauth2Client.setCredentials(token);

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const limit = pLimit(concurrency);

  // Add root
  const rootId = db.insertNode({
    path: `gdrive://${folderId}`,
    name: folderId === 'root' ? 'My Drive' : folderId,
    type: 'directory',
    depth: 0
  });

  let totalFiles = 0;

  const listFolder = async (folderId, parentDbId, depth) => {
    let pageToken;
    const subfolders = [];

    do {
      const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime)',
        pageSize: 1000,
        pageToken
      });

      for (const file of response.data.files || []) {
        const isFolder = file.mimeType === 'application/vnd.google-apps.folder';

        const nodeId = db.insertNode({
          path: `gdrive://${file.id}`,
          name: file.name,
          type: isFolder ? 'directory' : 'file',
          size: parseInt(file.size) || 0,
          depth,
          parentId: parentDbId,
          ext: isFolder ? null : extname(file.name).toLowerCase(),
          mime: file.mimeType,
          createdAt: new Date(file.createdTime).getTime(),
          modifiedAt: new Date(file.modifiedTime).getTime()
        });

        db.insertEdge(parentDbId, nodeId, 'child');
        totalFiles++;

        if (isFolder) {
          subfolders.push({ folderId: file.id, parentDbId: nodeId, depth: depth + 1 });
        }
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken);

    return subfolders;
  };

  // BFS crawl
  let queue = [{ folderId, parentDbId: rootId, depth: 1 }];

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);

    const results = await Promise.allSettled(
      batch.map(item => limit(() => listFolder(item.folderId, item.parentDbId, item.depth)))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        queue.push(...result.value);
      }
    }

    if (totalFiles % 100 === 0 && totalFiles > 0) {
      console.log(`  Listed ${totalFiles} files...`);
    }
  }

  console.log(`✅ Google Drive crawl complete: ${totalFiles} files in ${((performance.now() - startTime) / 1000).toFixed(2)}s`);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI INTERFACE
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  program
    .name('ultra-crawler')
    .description('High-performance multi-source crawler with Three.js output')
    .version('1.0.0')
    .option('-m, --mode <mode>', 'Crawl mode: filesystem, web, s3, gdrive', 'filesystem')
    .option('-p, --path <path>', 'Filesystem path to crawl', '.')
    .option('-u, --url <url>', 'URL to crawl (web mode)')
    .option('-b, --bucket <bucket>', 'S3 bucket name')
    .option('-d, --depth <depth>', 'Max crawl depth', '10')
    .option('-c, --concurrency <num>', 'Concurrent requests', '50')
    .option('-o, --output <dir>', 'Output directory', CONFIG.outputDir)
    .option('--prefix <prefix>', 'S3 prefix filter', '')
    .option('--same-domain', 'Stay on same domain (web mode)', true)
    .parse();

  const opts = program.opts();

  // Ensure output directory exists
  if (!existsSync(opts.output)) {
    mkdirSync(opts.output, { recursive: true });
  }

  const dbPath = join(opts.output, CONFIG.dbFile);
  const jsonPath = join(opts.output, CONFIG.jsonFile);

  console.log('═'.repeat(60));
  console.log('  🚀 Ultra-Crawler - High Performance Multi-Source Crawler');
  console.log('═'.repeat(60));
  console.log(`Mode: ${opts.mode} | Workers: ${CONFIG.maxWorkers} | Output: ${opts.output}`);
  console.log('');

  const db = await new CrawlDatabase(dbPath).init();
  const startTime = performance.now();

  try {
    switch (opts.mode) {
      case 'filesystem':
      case 'fs':
        await crawlFilesystem(opts.path, db, {
          maxDepth: parseInt(opts.depth)
        });
        break;

      case 'web':
        if (!opts.url) {
          console.error('❌ --url required for web mode');
          process.exit(1);
        }
        await crawlWeb(opts.url, db, {
          maxDepth: parseInt(opts.depth),
          concurrency: parseInt(opts.concurrency),
          sameDomain: opts.sameDomain
        });
        break;

      case 's3':
        if (!opts.bucket) {
          console.error('❌ --bucket required for S3 mode');
          process.exit(1);
        }
        await crawlS3(opts.bucket, db, {
          prefix: opts.prefix,
          concurrency: parseInt(opts.concurrency)
        });
        break;

      case 'gdrive':
        await crawlGoogleDrive(db, {
          concurrency: parseInt(opts.concurrency)
        });
        break;

      default:
        console.error(`❌ Unknown mode: ${opts.mode}`);
        process.exit(1);
    }

    // Export to JSON
    console.log('\n📦 Exporting to JSON for Three.js...');
    await db.exportToJSON(jsonPath);

    const stats = db.getStats();
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

    console.log('');
    console.log('═'.repeat(60));
    console.log(`  ✅ Crawl Complete!`);
    console.log(`  📊 Nodes: ${stats.nodes.toLocaleString()} | Edges: ${stats.edges.toLocaleString()}`);
    console.log(`  ⏱️  Time: ${elapsed}s`);
    console.log(`  💾 DB: ${dbPath}`);
    console.log(`  📄 JSON: ${jsonPath}`);
    console.log('═'.repeat(60));

  } finally {
    db.close();
  }
}

main().catch(console.error);
