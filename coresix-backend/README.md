# CoreSix Backend — The Brain

## Stack
- **Runtime:** Node.js on Render (free)
- **Database:** PostgreSQL on Supabase (free)
- **AI:** Groq (free tier)

## Setup — Step by Step

### 1. Supabase (Database)
1. Go to supabase.com → New project
2. Name it: coresix
3. Set a database password (save it!)
4. Go to Settings → Database → Connection string → URI
5. Copy the connection string — looks like:
   postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres

### 2. Render (Backend hosting)
1. Go to render.com → New → Web Service
2. Connect your GitHub repo: coresix-backend
3. Name: coresix-backend
4. Build command: npm install
5. Start command: node server.js
6. Add environment variables:
   - DATABASE_URL = (paste Supabase connection string)
   - GROQ_API_KEY = (your Groq key)
   - NODE_ENV = production
7. Click Deploy

### 3. Web App
1. Go to Vercel → coresix-app → Settings → Environment Variables
2. Add: REACT_APP_API_URL = https://coresix-backend.onrender.com
3. Redeploy

## API Endpoints
POST /api/user          — Create or get user
GET  /api/user/:id      — Get full user state
POST /api/ladder        — Update ladder rung
POST /api/checkin       — Log habit check-in
POST /api/streak        — Update streak
POST /api/impact        — Save weekly impact
GET  /api/impact/:id    — Get impact history
GET  /api/analytics/:id — Get analytics
POST /api/insight       — Generate AI insight
GET  /api/patterns/:id  — Get detected patterns
GET  /api/dashboard/:id — Full dashboard data
