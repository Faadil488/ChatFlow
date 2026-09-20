# Node.js Webhook Server

An Express-based webhook server implementing subscription verification and event payload handling (compatible with Meta / WhatsApp / Messenger / Instagram webhooks).

## Features

- **Verification Route (`GET /webhook`)**: Verifies subscription against `VERIFY_TOKEN` and echoes back `hub.challenge`.
- **Event Route (`POST /webhook`)**: Logs full JSON payloads, extracts incoming messages, and automatically replies with "hello" if the sender says "hi".
- **Outbound WhatsApp Messaging**: Sends messages via the WhatsApp Cloud Graph API (`/messages`) using `axios`.
- **Environment Configuration**: Managed via `dotenv`.

---

## Setup & Running

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Update [`.env`](.env) with your credentials from the Meta App Dashboard:
```env
PORT=3000
VERIFY_TOKEN=BumBaDigaDiga
PHONE_NUMBER_ID=your_phone_number_id_here
WHATSAPP_TOKEN=your_whatsapp_access_token_here
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
