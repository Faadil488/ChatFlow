require('dotenv').config();
const express = require('express');

const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON payloads
app.use(express.json());

/**
 * Sends a WhatsApp text message using the WhatsApp Cloud Graph API.
 *
 * @param {string} to - Recipient phone number with country code (e.g. "15551234567")
 * @param {string} text - The message text to send
 */
async function sendMessage(to, text) {
  const { PHONE_NUMBER_ID, WHATSAPP_TOKEN } = process.env;

  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    console.warn('[sendMessage] Missing PHONE_NUMBER_ID or WHATSAPP_TOKEN in environment variables.');
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`[sendMessage] Message successfully sent to ${to}:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`[sendMessage] Failed to send message to ${to}:`, error.response?.data || error.message);
  }
}

/**
 * GET /webhook
 * Verification endpoint for webhook subscription
 * Checks hub.mode, hub.verify_token against process.env.VERIFY_TOKEN,
 * and responds with hub.challenge.
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Check if a token and mode were sent
  if (mode && token) {
    // Check mode is 'subscribe' and token matches the configured environment variable
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('[GET /webhook] Webhook verified successfully.');
      return res.status(200).send(challenge);
    } else {
      console.warn('[GET /webhook] Verification failed. Token or mode mismatch.');
      return res.sendStatus(403);
    }
  }

  // Missing query parameters
  return res.status(400).send('Missing required query parameters: hub.mode, hub.verify_token, hub.challenge');
});

/**
 * POST /webhook
 * Webhook event handler
 *
 * WhatsApp Cloud API Webhook JSON Payload Structure:
 * ----------------------------------------------------
 * {
 *   "object": "whatsapp_business_account",
 *   "entry": [
 *     {
 *       "id": "WHATSAPP_BUSINESS_ACCOUNT_ID",
 *       "changes": [
 *         {
 *           "value": {
 *             "messaging_product": "whatsapp",
 *             "metadata": {
 *               "display_phone_number": "15550253483",
 *               "phone_number_id": "PHONE_NUMBER_ID"
 *             },
 *             "contacts": [
 *               {
 *                 "profile": { "name": "John Doe" },
 *                 "wa_id": "15551234567"
 *               }
 *             ],
 *             "messages": [
 *               {
 *                 "from": "15551234567",       // Sender's phone number
 *                 "id": "wamid.HBgL...",       // Unique message ID
 *                 "timestamp": "1710000000",   // Unix timestamp
 *                 "type": "text",              // Type of message (text, image, etc.)
 *                 "text": {
 *                   "body": "hi"               // The actual text message content
 *                 }
 *               }
 *             ]
 *           },
 *           "field": "messages"
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
app.post('/webhook', async (req, res) => {
  // Always acknowledge receipt immediately with 200 OK to satisfy Meta's webhook timeout requirements
  res.sendStatus(200);

  console.log('[POST /webhook] Webhook event received:');
  console.log(JSON.stringify(req.body, null, 2));

  // Safely extract incoming message details using optional chaining
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (message) {
    const senderNumber = message.from;
    const messageType = message.type;

    // Check if the message is a text message
    if (messageType === 'text') {
      const messageText = message.text?.body;
      console.log(`[POST /webhook] Received text from ${senderNumber}: "${messageText}"`);

      // If the message is 'hi' (case-insensitive), reply with 'hello'
      if (messageText && messageText.trim().toLowerCase() === 'hi') {
        console.log(`[POST /webhook] Replying 'hello' to ${senderNumber}...`);
        await sendMessage(senderNumber, 'hello');
      } else {
        console.log(`[POST /webhook] Message "${messageText}" did not match 'hi' (case-insensitive). Skipping reply.`);
      }
    }
  } else {
    // Check if the webhook event was a delivery status update (sent, delivered, read)
    const status = req.body?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
    if (status) {
      console.log(`[POST /webhook] Delivery status update: "${status.status}" for message ${status.id}`);
    }
  }
});

// Start the server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`- Webhook verification: GET  http://localhost:${PORT}/webhook`);
    console.log(`- Webhook receiver:     POST http://localhost:${PORT}/webhook`);
  });
}

module.exports = app;

