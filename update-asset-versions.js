/**
 * 零依赖版本号脚本 —— 每次改完 public/assets/ 下任何 .js / .css 后，
 * 提交前跑一次 `node update-asset-versions.js`。
 *
 * 做的事：
 * - 给 public/assets/*.js|css 各算一个内容 hash(sha1 取前8位)
 * - 把这个 hash 作为 ?v= 查询串，写回所有引用了它的 public/*.html
 * - 幂等：内容没变 → hash 没变 → 文件不会被重写(用 content !== original 判断)
 *
 * 配合 public/_headers 里 /assets/* 的 `max-age=31536000, immutable`：
 * 内容不变时永久缓存，内容一变 URL(带的 ?v=)跟着变，浏览器自动重新拉取。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 8);
}

function collectAssetHashes() {
  const hashes = {};
  const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(js|css)$/i.test(entry.name)) continue;
    hashes[entry.name] = hashFile(path.join(ASSETS_DIR, entry.name));
  }
  return hashes;
}

function updateHtmlFile(filePath, hashes) {
  const original = fs.readFileSync(filePath, "utf8");
  let content = original;
  for (const [name, hash] of Object.entries(hashes)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`((?:src|href)=["'])/assets/${escapedName}(?:\\?v=[a-f0-9]+)?(["'])`, "g");
    content = content.replace(pattern, `$1/assets/${name}?v=${hash}$2`);
  }
  if (content !== original) {
    fs.writeFileSync(filePath, content, "utf8");
    return true;
  }
  return false;
}

function main() {
  const hashes = collectAssetHashes();
  const htmlFiles = fs
    .readdirSync(PUBLIC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".html"))
    .map((e) => path.join(PUBLIC_DIR, e.name));

  let changedCount = 0;
  for (const file of htmlFiles) {
    const changed = updateHtmlFile(file, hashes);
    if (changed) {
      changedCount++;
      console.log(`updated: ${path.relative(__dirname, file)}`);
    }
  }

  console.log(`\n${Object.keys(hashes).length} asset(s) hashed, ${changedCount} html file(s) updated.`);
  if (changedCount === 0) {
    console.log("(no changes — asset content unchanged since last run, or first run with no matching references yet)");
  }
}

main();
