const { classifyAndExtract } = require('./server');

async function test() {
  const messages = [
    'Alice took 500 rupees on credit',
    'Alice paid 200 rupees',
    'How much does Alice owe me?',
    'Alice has cleared all her dues'
  ];

  for (const message of messages) {
    console.log(`\nMessage: "${message}"`);

    const result = await classifyAndExtract(message);

    console.log('Gemini:', result);
  }

  process.exit();
}

test();
