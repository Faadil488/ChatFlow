require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');

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
 * Classifies user intent and extracts transaction details using @google/generative-ai.
 * Keeps the Gemini API call completely isolated inside this function so the provider can be replaced later.
 *
 * @param {string} text - Incoming WhatsApp message text
 * @returns {Promise<{intent: "log_transaction"|"query_balance"|"mark_paid", customer_name: string|null, amount: number|null, type: "credit"|"payment"|null}|null>}
 */
async function classifyAndExtract(text) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error('[classifyAndExtract] Missing GEMINI_API_KEY in environment variables.');
    return null;
  }

  const prompt = `You are an AI assistant for a store ledger system.
Classify the following user message into exactly ONE of these intents:
- "log_transaction": The user wants to record a credit (borrowed money / goods taken on credit) or a payment.
- "query_balance": The user wants to check how much a customer owes or their current balance.
- "mark_paid": The user indicates a customer paid off their debt, settled their account, or cleared their dues.

Extract the following information where relevant:
- customer_name: The name of the customer (string), or null if not mentioned.
- amount: The monetary amount (number), or null if not mentioned.
- type: Either "credit" or "payment" (string), or null if not applicable.

You MUST respond ONLY with a valid JSON object matching this schema:
{
  "intent": "log_transaction" | "query_balance" | "mark_paid",
  "customer_name": string | null,
  "amount": number | null,
  "type": "credit" | "payment" | null
}

Do not include any explanations, markdown formatting, or text outside the JSON object.

User message: "${text}"`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      generationConfig: {
        responseMimeType: 'application/json'
      }
    });

    let result;
    try {
      result = await model.generateContent(prompt);
    } catch (apiErr) {
      if (apiErr.message && (apiErr.message.includes('503') || apiErr.message.includes('high demand'))) {
        console.warn('[classifyAndExtract] Temporary 503 spike, retrying once...');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        result = await model.generateContent(prompt);
      } else {
        throw apiErr;
      }
    }

    let rawText = result.response.text();

    // Strip markdown code fences if present (e.g. ```json ... ``` or ``` ... ```)
    rawText = rawText.replace(/```(?:json)?\n?/gi, '').replace(/```\s*$/gi, '').trim();

    try {
      const parsed = JSON.parse(rawText);
      return parsed;
    } catch (parseError) {
      console.error('[classifyAndExtract] Failed to parse JSON response:', parseError.message, 'Raw response:', rawText);
      return null;
    }
  } catch (error) {
    console.error('[classifyAndExtract] Error calling Gemini API:', error.message);
    return null;
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

      // 1. Keep existing "hi" -> "hello" behavior working
      if (messageText && messageText.trim().toLowerCase() === 'hi') {
        console.log(`[POST /webhook] Replying 'hello' to ${senderNumber}...`);
        await sendMessage(senderNumber, 'hello');
        return;
      }

      // 2. Classify intent and extract details
      const result = await classifyAndExtract(messageText);

      // 3. If null, send failure reply
      if (!result) {
        await sendMessage(senderNumber, "Sorry, I couldn't understand that. Please try again.");
        return;
      }

      const customerName = result.customer_name || 'customer';

      // 4. Branch based on intent
      switch (result.intent) {
        case 'log_transaction': {
          // DO NOT insert anything into the database yet
          if (!result.customer_name || result.amount == null || !result.type) {
            await sendMessage(
              senderNumber,
              "I need the customer name, amount, and whether this is a credit or payment. Please provide those details."
            );
            break;
          }

          const confirmationText = `Please confirm: Log a ${result.type} of ₹${result.amount} for ${result.customer_name}? Reply with YES to confirm.`;
          await sendMessage(senderNumber, confirmationText);
          break;
        }

        case 'query_balance': {
          // Just reply with the requested format
          await sendMessage(senderNumber, `Balance lookup received for ${customerName}.`);
          break;
        }

        case 'mark_paid': {
          // For now, do not insert anything into the database
          await sendMessage(senderNumber, `Payment/settlement request received for ${customerName}.`);
          break;
        }

        default: {
          await sendMessage(senderNumber, "Sorry, I couldn't understand that. Please try again.");
          break;
        }
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

module.exports = { app, sendMessage, classifyAndExtract };
