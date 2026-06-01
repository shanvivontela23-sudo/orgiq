# OrgIQ

Salesforce data migration SaaS scaffold with a React/Vite frontend, Express backend, BullMQ worker, Python migration engine, Redis, and Postgres.

## Prerequisites

- Node 18+
- Python 3.10+
- Docker Desktop

## Setup

```bash
# 1. Install and configure environment
cd orgiq
cp .env.example .env
cp frontend/.env.local.example frontend/.env.local
# Fill in .env and frontend/.env.local values

# 2. Start local services
docker-compose up -d

# 3. Install backend dependencies
cd backend
npm install
cd ..

# 4. Install frontend dependencies
cd frontend
npm install
cd ..

# 5. Install Python dependencies
cd engine
pip install -r requirements.txt
cd ..

# 6. Run backend
cd backend
npm run dev

# 7. Run frontend in a new terminal
cd frontend
npm run dev

# 8. Run migration worker in a new terminal
cd backend
node workers/migrationWorker.js
```

## URLs

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001
- Health check: http://localhost:3001/health

## Current Scope

This scaffold includes:

- Landing page with pricing
- Supabase-backed login UI
- Protected dashboard and migration pages
- New migration wizard
- Live migration status screen
- Validation report screen
- Express API route stubs
- BullMQ migration queue and worker
- Python mapping parser
- Python dependency graph resolver
- Docker Compose for local Redis and Postgres
- Supabase-ready SQL schema

Still to wire in a later implementation pass:

- End-to-end Salesforce OAuth persistence
- Backend upload and parsing of mapping files
- Real Salesforce schema fetch and Bulk API migration execution
- Stripe payment flow
- S3 migration working directory and report export
