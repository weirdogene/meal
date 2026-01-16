# Mealplan Share App (GitHub + Render + Neon)

Admin uploads your weekly mealplan Excel. The server parses it and saves it to Postgres. Everyone visits the same URL and browses meals by date.

## Local run

```bash
npm install
export ADMIN_TOKEN="your_admin_token"
export DATABASE_URL="postgresql://..."
npm start
```

Then open:
- User: http://localhost:3000/
- Admin: http://localhost:3000/upload.html

## Render deployment (high level)
1. Push this repo to GitHub.
2. Create a free Neon Postgres and copy the connection string.
3. Create a Render Web Service connected to the repo.
4. Set env vars on Render:
   - `ADMIN_TOKEN`
   - `DATABASE_URL`
5. Build command: `npm install`
6. Start command: `npm start`
