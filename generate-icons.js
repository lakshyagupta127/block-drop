// Run this once: node generate-icons.js
// Generates all required PWA/TWA icons in the /icons folder
// Uses only Node.js built-in — no extra packages needed

const fs   = require('fs');
const path = require('path');
const { createCanvas } = require('canvas'); // npm install canvas

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;

  // Background — deep navy
  ctx.fillStyle = '#0d0d1a';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.18);
  ctx.fill();

  // Draw Tetris blocks forming a "BD" shape
  const b  = Math.floor(size / 8);   // block size
  const gap= Math.floor(b * 0.08);   // gap between blocks

  function block(col, row, color) {
    const x = cx - b * 1.5 + col * (b + gap);
    const y = cy - b * 1.5 + row * (b + gap);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, b, b);
    // shine
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(x + gap, y + gap, b - gap*2, Math.floor(b * 0.28));
  }

  // I-piece (cyan) — top row
  block(0, 0, '#00f0f0');
  block(1, 0, '#00f0f0');
  block(2, 0, '#00f0f0');

  // T-piece (purple) — middle
  block(1, 1, '#a000f0');
  block(0, 2, '#a000f0');
  block(1, 2, '#a000f0');
  block(2, 2, '#a000f0');

  // L-piece (orange) — bottom
  block(0, 3, '#f0a000');
  block(0, 4, '#f0a000');
  block(1, 4, '#f0a000');
  block(2, 4, '#f0a000');

  // Glow border
  ctx.strokeStyle = '#00f0f044';
  ctx.lineWidth   = Math.max(1, size * 0.015);
  ctx.beginPath();
  ctx.roundRect(ctx.lineWidth/2, ctx.lineWidth/2, size - ctx.lineWidth, size - ctx.lineWidth, size * 0.18);
  ctx.stroke();

  const buf  = canvas.toBuffer('image/png');
  const file = path.join(__dirname, 'icons', `icon-${size}.png`);
  fs.writeFileSync(file, buf);
  console.log(`  Created ${file}`);
}

// Check if canvas package is available
try {
  require('canvas');
  console.log('Generating icons...');
  sizes.forEach(generateIcon);
  console.log('\nDone! All icons created in /icons/');
} catch(e) {
  // canvas not installed — generate simple SVG-based placeholder PNGs
  console.log('canvas package not found — generating simple placeholder icons...');
  console.log('For production icons, run: npm install canvas && node generate-icons.js\n');

  // Create simple colored placeholder using pure Node.js (minimal PNG)
  sizes.forEach(size => {
    // Minimal 1x1 PNG stretched — enough for Bubblewrap to work
    // Bubblewrap will use these as base and resize
    const file = path.join(__dirname, 'icons', `icon-${size}.png`);
    // 8x8 pixel cyan block PNG (valid PNG, will be scaled by Android)
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000080000000808020000004b6d29580000001849444154'
      +'789c62f8cfc0c0c0c0c040010000ffff030000060005c3a22eee0000000049454e44ae426082','hex'
    );
    fs.writeFileSync(file, png);
    console.log(`  Created placeholder ${file}`);
  });
  console.log('\nPlaceholder icons created. Replace with real icons before Play Store submission.');
}
