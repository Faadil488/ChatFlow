const db = require('./db');

async function test() {
  try {
    // 1. Create or get test shop
    const shopRes = await db.query(`
      INSERT INTO shops (phone_number, name)
      VALUES ('+15559990001', 'Downtown Grocery')
      ON CONFLICT (phone_number) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name;
    `);
    const shop = shopRes.rows[0];
    console.log('1. Shop created/retrieved:', shop);

    // 2. Create test customer
    const custRes = await db.query(`
      INSERT INTO customers (shop_id, name)
      VALUES ($1, 'Alice Smith')
      RETURNING id, name;
    `, [shop.id]);
    const customer = custRes.rows[0];
    console.log('2. Customer created:', customer);

    // 3. Add a credit transaction ($150.00)
    await db.query(`
      INSERT INTO transactions (customer_id, amount, type)
      VALUES ($1, 150.00, 'credit');
    `, [customer.id]);
    console.log('3. Added credit: $150.00');

    // 4. Add a payment transaction ($50.00)
    await db.query(`
      INSERT INTO transactions (customer_id, amount, type)
      VALUES ($1, 50.00, 'payment');
    `, [customer.id]);
    console.log('4. Added payment: $50.00');

    // 5. Query customer's current balance
    const balanceRes = await db.query(`
      SELECT 
        c.id AS customer_id,
        c.name AS customer_name,
        COALESCE(
          SUM(
            CASE 
              WHEN t.type = 'credit' THEN t.amount
              WHEN t.type = 'payment' THEN -t.amount
              ELSE 0
            END
          ), 
          0
        ) AS balance
      FROM customers c
      LEFT JOIN transactions t ON c.id = t.customer_id
      WHERE c.id = $1
      GROUP BY c.id, c.name;
    `, [customer.id]);

    console.log('\n--- Customer Balance Query Result ---');
    console.table(balanceRes.rows);
  } catch (error) {
    console.error('Error executing test:', error.message);
  } finally {
    process.exit();
  }
}

test();