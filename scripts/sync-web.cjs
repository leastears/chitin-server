"use strict";

const fs = require("fs");
const path = require("path");

const serverDir = path.join(__dirname, "..");
const src = path.join(serverDir, "..", "web_build");
const dst = path.join(serverDir, "public");

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (ent.name === ".git") continue;
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(src)) {
  console.error("[sync-web] web_build not found:", src);
  console.error("Export the Godot Web preset to ../web_build (repo sibling of server/), then run again.");
  process.exit(1);
}

rmrf(dst);
copyDir(src, dst);
console.log("[sync-web] Copied web export to", dst);
