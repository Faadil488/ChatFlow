# Node.js Webhook Server

An Express-based webhook server implementing subscription verification and event payload handling (compatible with Meta / WhatsApp / Messenger / Instagram webhooks).

## Features

- **Verification Route (`GET /webhook`)**: Verifies subscription against `VERIFY_TOKEN` and echoes back `hub.challenge`.
- **AI Intent Parsing (`gemini-2.0-flash`)**: Extracts customer name, amount, and intent (`log_transaction`, `query_balance`, `mark_paid`).
- **Confirmation Flow**: Requires reply with `YES` before saving new transactions.
- **Ledger & Balance Queries**: Automatically tracks customer credits, payments, and calculates live net balances via PostgreSQL.
- **Outbound WhatsApp Messaging**: Sends messages via the WhatsApp Cloud Graph API (`/messages`) using `axios`.
- **Environment Configuration**: Managed via `dotenv`.

---

## Setup & Running

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Update [`.env`](.env) with your credentials:
```env
PORT=3000
VERIFY_TOKEN=BumBaDigaDiga
PHONE_NUMBER_ID=your_phone_number_id_here
WHATSAPP_TOKEN=your_whatsapp_access_token_here
DATABASE_URL=postgresql://user:password@hostname:5432/database_name
GEMINI_API_KEY=your_gemini_api_key_here
```

### 3. Start the Server
```bash
# Normal start
npm start

# Development mode with automatic reload on changes
npm run dev
```

---

## Testing Webhook Endpoints

### 1. Verify Webhook Subscription (`GET`)

**Valid request:**
```bash
curl -i "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=my_secure_verify_token&hub.challenge=1158201444"
```
*Expected Response:* `HTTP 200 OK` with body `1158201444`.

**Invalid request:**
```bash
curl -i "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=1158201444"
```
*Expected Response:* `HTTP 403 Forbidden`.

---

### 2. Receive Webhook Event (`POST`)

```bash
curl -i -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"object": "page", "entry": [{"id": "123", "messaging": [{"message": {"text": "Hello"}}]}]}'
```
*Expected Response:* `HTTP 200 OK`. The server logs the formatted JSON body to the console.
