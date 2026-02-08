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

const { ObjectId } = require("mongodb");



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
  
  try {
    if (!usersCollection) {
      return res.status(500).json({ error: 'Database not initialized' });
    }
    const user = req.body;
    const result = await usersCollection.insertOne(user);
    res.json(result);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/users', async (req, res) => {
  
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
  
  const email = req.query.email;

  if (!email) {
    return res.status(400).json({ error: 'Email parameter required' });
  }

  try {
    if (!usersCollection) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

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
  
  const email = req.params.email;
  const updatedData = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email parameter required' });
  }

  try {
    if (!usersCollection) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

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


// Add asset (HR only for now)
app.post("/assets", async (req, res) => {
  try {
    const asset = req.body;

    asset.availableQuantity = asset.productQuantity;
    asset.dateAdded = new Date();

    const result = await client
      .db("assetverseDB")
      .collection("assets")
      .insertOne(asset);

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to add asset" });
  }
});


// Get assets by HR
app.get("/assets", async (req, res) => {
  const email = req.query.email;

  const assets = await client
    .db("assetverseDB")
    .collection("assets")
    .find({ hrEmail: email })
    .toArray();

  res.send(assets);
});

app.get("/assets/:id", async (req, res) => {
  const id = req.params.id;

  const asset = await client
    .db("assetverseDB")
    .collection("assets")
    .findOne({ _id: new ObjectId(id) });

  res.send(asset);
});


app.put("/assets/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const updatedData = req.body;

    // Validate ID
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid asset ID" });
    }

    const result = await client
      .db("assetverseDB")
      .collection("assets")
      .updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            productName: updatedData.productName,
            productType: updatedData.productType,
            productQuantity: updatedData.productQuantity,
            availableQuantity: updatedData.productQuantity,
          },
        }
      );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Asset not found" });
    }

    res.json({
      success: true,
      message: "Asset updated successfully",
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    console.error("Update error:", error.message);
    res.status(500).json({ error: error.message });
  }
});



app.delete("/assets/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const result = await client
      .db("assetverseDB")
      .collection("assets")
      .deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "Asset not found" });
    }

    res.send({
      success: true,
      message: "Asset deleted successfully",
    });
  } catch (error) {
    console.error("Delete asset error:", error);
    res.status(500).send({ message: "Failed to delete asset" });
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
