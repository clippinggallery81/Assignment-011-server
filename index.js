const express = require('express');
const cors = require('cors');
const dns = require('dns');
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Force Google's DNS
dns.setServers(['8.8.8.8', '8.8.4.4']);

app.use(express.json());
app.use(cors());

const uri = `mongodb+srv://${process.env.DB_USERS}:${process.env.DB_PASS}@aslampracticefirstserve.ortqfo0.mongodb.net/?appName=AslamPracticeFirstServer`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  connectTimeoutMS: 5000,
  serverSelectionTimeoutMS: 5000,
});

let usersCollection;

// Routes BEFORE database connection
app.get('/', (req, res) => {
  console.log('✓ GET /');
  res.send('Asset server is running');
});

app.post('/users', async (req, res) => {
  console.log('✓ POST /users called');
  try {
    if (!usersCollection) {
      return res.status(500).json({ error: 'Database not initialized' });
    }
    const user = req.body;
    console.log('Inserting user:', user);
    const result = await usersCollection.insertOne(user);
    res.json(result);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/users', async (req, res) => {
  console.log('✓ GET /users called');
  try {
    if (!usersCollection) {
      return res.status(500).json({ error: 'Database not initialized' });
    }
    const users = await usersCollection.find().toArray();
    res.json(users);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


app.get("/user", async (req, res) => {
  console.log('✓ GET /user called with query:', req.query);
  
  const email = req.query.email;

  if (!email) {
    return res.status(400).json({ error: 'Email parameter required' });
  }

  try {
    if (!usersCollection) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    console.log('Searching user with email:', email);
    const user = await usersCollection.findOne({ email });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


app.put("/users/:email", async (req, res) => {
  console.log('✓ PUT /users/:email called');
  
  const email = req.params.email;
  const updatedData = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email parameter required' });
  }

  try {
    if (!usersCollection) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    console.log('Updating user with email:', email);
    console.log('Update data:', updatedData);

    const result = await usersCollection.updateOne(
      { email },
      { $set: updatedData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      message: 'User updated successfully',
      modifiedCount: result.modifiedCount,
      matchedCount: result.matchedCount
    });
  } catch (error) {
    console.error('Update error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// Start server immediately
app.listen(port, () => {
  console.log(`\n🚀 Server running on port ${port}`);
});

// Connect to database asynchronously
(async () => {
  try {
    console.log('Connecting to MongoDB...');
    await client.connect();
    const db = client.db("assetverseDB");
    usersCollection = db.collection("users");
    
    await client.db("admin").command({ ping: 1 });
    console.log('✅ MongoDB connected successfully!\n');
  } catch (error) {
    console.error('❌ MongoDB Error:', error.message);
  }
})();
