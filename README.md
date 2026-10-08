# 🎮 Block Drop

A fully-featured, production-ready Tetris-style puzzle game built with **Node.js**, **Express**, **SQLite**, and vanilla **JavaScript**. Designed for mobile and desktop with a global leaderboard, multilingual support, secure backend, and a complete onboarding experience.

---

## ✨ Features

### Game
- Classic Tetris gameplay with all 7 tetrominoes
- Ghost piece (landing preview)
- Exponential speed curve — levels 1–15, max speed at 35ms/drop
- Line clear visual effects — particles, flash, score popup, TETRIS! label
- Background music (generative, no audio files) + SFX
- Volume controls, mute, music on/off

### Mobile
- Full touch controls — ◀ ↻ ▶ Soft Drop Hard Drop
- Swipe gestures on canvas (tap = rotate, swipe down = hard drop)
- Pause / Resume button
- Responsive layout for all screen sizes (320px → tablet)
- Landscape mode support

### Onboarding (new players)
- Language picker (20 languages, auto-detects browser language)
- Age gate (COPPA / GDPR compliant)
- Interactive demo — bot plays for 6 seconds, then player takes control
- Mandatory name entry — game cannot start without a name
- Country selection (130+ countries with flags)

### Player System
- Browser fingerprint identity (no login required)
- Personal best score, total games, last session stats
- "Welcome back!" greeting on return visits
- Display name with 10-day change cooldown (enforced server-side)

### Leaderboard
- Global top 10 scores
- Player flag + name display
- Scores saved instantly after every game (no post-game prompt)

### Security
- HMAC-signed game tokens — server rejects tampered/impossible scores
- Nonce replay prevention
- JWT-protected admin panel
- Rate limiting (API, score submission, login)
- Helmet.js security headers
- HSTS + HTTPS redirect (production)
- Fail-fast on missing secrets in production

### Compliance
- Privacy Policy, Terms of Service, Data Safety pages
- GDPR consent banner
- Data deletion (in-app + API)
- GDPR data export (JSON download)
- Content rating metadata

### i18n — 20 Languages
🇬🇧 English · 🇮🇳 Hindi · 🇪🇸 Spanish · 🇧🇷 Portuguese · 🇫🇷 French · 🇩🇪 German · 🇯🇵 Japanese · 🇰🇷 Korean · 🇸🇦 Arabic (RTL) · 🇹🇷 Turkish · 🇮🇹 Italian · 🇮🇩 Indonesian · 🇻🇳 Vietnamese · 🇹🇭 Thai · 🇵🇭 Filipino · 🇧🇩 Bengali · 🇰🇪 Swahili · 🇵🇱 Polish · 🇳🇱 Dutch · 🇷🇺 Russian

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Database | SQLite (via sql.js — pure JS, no native build) |
| Auth | JWT (admin) + HMAC (score signing) |
| Security | Helmet.js + express-rate-limit |
| Frontend | Vanilla JS + HTML5 Canvas |
| Audio | Web Audio API (generative, no files) |
| Deployment | Render.com |

---

## 🚀 Local Development

```bash
# Install dependencies
npm install

# Start server
npm start

# Open in browser
http://localhost:3000

# Admin panel
http://localhost:3000/admin
```

---

## ⚙️ Environment Variables

Create a `.env` file (never commit this):

```env
JWT_SECRET=your_jwt_secret_here
SCORE_SECRET=your_score_secret_here
ADMIN_PASSWORD=your_admin_password_here
NODE_ENV=development
PORT=3000
DB_FILE=./tetris.db
```

---

## 🌐 Deployment on Render

1. Push to GitHub
2. Create a new **Web Service** on [render.com](https://render.com)
3. Connect your GitHub repository
4. Set these environment variables in Render dashboard:

```
JWT_SECRET      = (your secret)
SCORE_SECRET    = (your secret)
ADMIN_PASSWORD  = (your password)
NODE_ENV        = production
DB_FILE         = /data/tetris.db
PORT            = 3000
```

5. After deploy, go to **Disks** → Add Disk:
   - Name: `blockdrop-db`
   - Mount Path: `/data`
   - Size: `1 GB`

6. Your app will be live at `https://your-app.onrender.com` with SSL automatically configured.

> SSL is fully automatic on Render — no configuration needed.

---

## 📁 Project Structure

```
block-drop/
├── server.js          # Express backend + SQLite API
├── game.js            # Game logic + onboarding + tutorial
├── i18n.js            # 20-language translation strings
├── index.html         # Game UI
├── style.css          # All styles (responsive)
├── admin.html         # Admin dashboard (JWT protected)
├── privacy.html       # Privacy Policy
├── terms.html         # Terms of Service
├── data-safety.html   # Data Safety disclosure
├── render.yaml        # Render deployment config
├── package.json
└── .nvmrc             # Node version pin
```

---

## 🔐 Admin Panel

Access at `/admin` with your `ADMIN_PASSWORD`.

Features:
- View all scores with device, duration, level, lines
- Delete individual scores
- Clear all scores
- View registered players

---

## 📱 Controls

| Action | Keyboard | Touch |
|--------|----------|-------|
| Move left/right | ← → | Swipe or buttons |
| Rotate | ↑ | Tap canvas or ↻ button |
| Soft drop | ↓ | ▼ button |
| Hard drop | Space | ⬇ button or swipe down |
| Pause | P | ⏸ button |

---

## 🌍 Availability

Available on Google Play Store in **190+ countries** across Americas, Europe, Asia-Pacific, Middle East and Africa.

Not available in: China, Russia, North Korea, Iran, Cuba, Syria (Google Play not available there).

---

## 📄 License

This project is proprietary. All rights reserved.

---

*Built with ❤️ — Block Drop*
