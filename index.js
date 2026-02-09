const express = require('express');
const cors = require('cors');
const dns = require('dns');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
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

// Database collections
let usersCollection;
let assetsCollection;
let requestsCollection;
let assetAssignmentsCollection;
let affiliationsCollection;
let packagesCollection;
let paymentsCollection;

const db_name = "assetverseDB";
const jwtSecret = process.env.JWT_SECRET || 'dev-secret';
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

// ===================== UTILITY FUNCTIONS =====================

/**
 * Send error response in consistent format
 */
const sendError = (res, statusCode, message, code = 'ERROR') => {
  res.status(statusCode).json({
    error: message,
    code: code,
    statusCode: statusCode
  });
};

/**
 * Validate email format
 */
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Sanitize string input
 */
const sanitize = (str) => {
  if (typeof str !== 'string') return str;
  return str.trim();
};

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.decoded = decoded;
    next();
  } catch (error) {
    return sendError(res, 401, 'Invalid token', 'INVALID_TOKEN');
  }
};

const verifyHR = async (req, res, next) => {
  const email = req.decoded?.email;
  if (!email) {
    return sendError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  }

  const user = await usersCollection.findOne({ email });
  if (!user || user.role !== 'hr') {
    return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
  }

  next();
};

// ===================== ROOT ENDPOINT =====================

app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 AssetVerse Server is running',
    version: '1.0.0',
    status: 'OK'
  });
});

/**
 * GET /payments - Get HR payment history
 */
app.get('/payments', verifyToken, verifyHR, async (req, res) => {
  try {
    const { hrEmail } = req.query;

    if (!hrEmail) {
      return sendError(res, 400, 'hrEmail required', 'MISSING_EMAIL');
    }

    if (req.decoded?.email !== hrEmail) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }

    const payments = await paymentsCollection
      .find({ hrEmail: sanitize(hrEmail) })
      .sort({ paymentDate: -1 })
      .toArray();

    res.json(payments);
  } catch (error) {
    console.error('Get payments error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * GET /packages - Get all subscription packages
 */
app.get('/packages', async (req, res) => {
  try {
    const packages = await packagesCollection.find({}).toArray();
    res.json(packages);
  } catch (error) {
    console.error('Get packages error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * POST /create-checkout-session - Create Stripe checkout session
 */
app.post('/create-checkout-session', verifyToken, verifyHR, async (req, res) => {
  try {
    if (!stripe) {
      return sendError(res, 500, 'Stripe not configured', 'STRIPE_NOT_CONFIGURED');
    }

    const { packageId, hrEmail } = req.body;

    if (!packageId || !hrEmail) {
      return sendError(res, 400, 'packageId and hrEmail required', 'MISSING_FIELDS');
    }

    if (req.decoded?.email !== hrEmail) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }

    const hasPayment = await paymentsCollection.findOne({ hrEmail: hrEmail });
    if (hasPayment) {
      return sendError(res, 409, 'Package already upgraded', 'ALREADY_UPGRADED');
    }

    const pkg = await packagesCollection.findOne({ _id: new ObjectId(packageId) });
    if (!pkg) {
      return sendError(res, 404, 'Package not found', 'PACKAGE_NOT_FOUND');
    }

    const successUrl =
      process.env.STRIPE_SUCCESS_URL ||
      'http://localhost:5173/dashboard/upgrade?success=1&session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl =
      process.env.STRIPE_CANCEL_URL ||
      'http://localhost:5173/dashboard/upgrade?canceled=1';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: hrEmail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: pkg.name },
            unit_amount: Math.round(Number(pkg.price) * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        packageId: pkg._id.toString(),
        packageName: pkg.name,
        employeeLimit: String(pkg.employeeLimit),
        hrEmail,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Create checkout session error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * POST /confirm-payment - Confirm payment and update package
 */
app.post('/confirm-payment', verifyToken, verifyHR, async (req, res) => {
  try {
    if (!stripe) {
      return sendError(res, 500, 'Stripe not configured', 'STRIPE_NOT_CONFIGURED');
    }

    const { sessionId } = req.body;
    if (!sessionId) {
      return sendError(res, 400, 'sessionId required', 'MISSING_SESSION');
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') {
      return sendError(res, 400, 'Payment not completed', 'PAYMENT_INCOMPLETE');
    }

    const metadata = session.metadata || {};
    const hrEmail = metadata.hrEmail;

    if (req.decoded?.email !== hrEmail) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }

    const employeeLimit = parseInt(metadata.employeeLimit || '0', 10);
    const packageName = metadata.packageName || 'Unknown';

    const baseEmployees = 5;
    const totalLimit = baseEmployees + employeeLimit;

    await usersCollection.updateOne(
      { email: hrEmail },
      {
        $set: {
          packageLimit: totalLimit,
          subscription: packageName.toLowerCase(),
          updatedAt: new Date(),
        },
      }
    );

    await paymentsCollection.insertOne({
      hrEmail,
      packageName,
      employeeLimit,
      amount: session.amount_total ? session.amount_total / 100 : 0,
      transactionId: session.payment_intent || session.id,
      paymentDate: new Date(),
      status: 'completed',
      createdAt: new Date(),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Confirm payment error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * POST /jwt - Issue JWT for valid user
 */
app.post('/jwt', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return sendError(res, 400, 'Valid email required', 'INVALID_EMAIL');
    }

    const user = await usersCollection.findOne({ email: sanitize(email) });
    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const token = jwt.sign(
      { email: user.email, role: user.role },
      jwtSecret,
      { expiresIn: '7d' }
    );

    res.json({ token });
  } catch (error) {
    console.error('JWT error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

// ===================== USER ENDPOINTS =====================

/**
 * GET /user/:email - Get user information by email
 */
app.get('/user/:email', async (req, res) => {
  try {
    const email = sanitize(req.params.email);

    if (!isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format', 'INVALID_EMAIL');
    }

    const user = await usersCollection.findOne({ email });

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    // Remove password from response
    delete user.password;
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * GET /users-by-emails - Get users by email list
 */
app.get('/users-by-emails', verifyToken, async (req, res) => {
  try {
    const { emails } = req.query;

    if (!emails) {
      return sendError(res, 400, 'emails query parameter required', 'MISSING_EMAILS');
    }

    const emailList = emails
      .split(',')
      .map((email) => sanitize(email))
      .filter((email) => isValidEmail(email));

    if (emailList.length === 0) {
      return sendError(res, 400, 'No valid emails provided', 'INVALID_EMAILS');
    }

    const users = await usersCollection
      .find({ email: { $in: emailList } })
      .toArray();

    users.forEach((u) => delete u.password);
    res.json(users);
  } catch (error) {
    console.error('Get users by emails error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * POST /users - Create user in database
 */
app.post('/users', async (req, res) => {
  try {
    const { name, email, password, role, companyName, profileImage, packageLimit, photoURL, companyLogo } = req.body;

    // Validation
    if (!name || !email || !role) {
      return sendError(res, 400, 'Missing required fields: name, email, role', 'MISSING_FIELDS');
    }

    if (!isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format', 'INVALID_EMAIL');
    }

    if (!['hr', 'employee'].includes(role)) {
      return sendError(res, 400, 'Role must be "hr" or "employee"', 'INVALID_ROLE');
    }

    if (role === 'hr' && !companyName) {
      return sendError(res, 400, 'Company name is required for HR', 'MISSING_COMPANY');
    }

    // Check if email already exists
    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return sendError(res, 400, 'Email already exists', 'EMAIL_EXISTS');
    }

    const newUser = {
      name: sanitize(name),
      email: sanitize(email),
      password: password || '', // In production, hash the password
      role,
      companyName: role === 'hr' ? sanitize(companyName) : undefined,
      companyLogo: role === 'hr' ? (companyLogo || profileImage || null) : undefined,
      photoURL: role === 'employee' ? (photoURL || profileImage || null) : undefined,
      currentEmployees: role === 'hr' ? 0 : undefined,
      packageLimit: role === 'hr' ? (packageLimit || 0) : undefined,
      joinDate: new Date(),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await usersCollection.insertOne(newUser);

    res.status(201).json({
      _id: result.insertedId,
      ...newUser,
      password: undefined
    });
  } catch (error) {
    console.error('Create user error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * PUT /users/:email - Update user profile
 */
app.put('/users/:email', verifyToken, async (req, res) => {
  try {
    const email = sanitize(req.params.email);
    const { name, profileImage, currentEmployees, photoURL, companyLogo, dob, companyName } = req.body;

    if (!isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format', 'INVALID_EMAIL');
    }

    if (req.decoded?.email !== email) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }

    const updateData = { updatedAt: new Date() };
    const unsetData = {};
    if (name) updateData.name = sanitize(name);
    if (profileImage) updateData.profileImage = profileImage;
    if (photoURL) {
      updateData.photoURL = photoURL;
      unsetData.profileImage = "";
      unsetData.companyLogo = "";
    }
    if (companyLogo) {
      updateData.companyLogo = companyLogo;
      unsetData.profileImage = "";
      unsetData.photoURL = "";
    }
    if (dob) updateData.dob = dob;
    if (companyName) updateData.companyName = sanitize(companyName);
    if (currentEmployees !== undefined) updateData.currentEmployees = currentEmployees;

    const updateDoc = { $set: updateData };
    if (Object.keys(unsetData).length > 0) {
      updateDoc.$unset = unsetData;
    }

    const result = await usersCollection.updateOne({ email }, updateDoc);

    if (result.matchedCount === 0) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    const updatedUser = await usersCollection.findOne({ email });
    delete updatedUser.password;
    
    res.json(updatedUser);
  } catch (error) {
    console.error('Update user error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

// ===================== ASSET ENDPOINTS =====================

/**
 * POST /assets - Create new asset (HR only)
 */
app.post('/assets', verifyToken, verifyHR, async (req, res) => {
  try {
    const { productName, productImage, productType, productQuantity, hrEmail, companyName } = req.body;
    const tokenEmail = req.decoded?.email;

    // Validation
    if (!productName || !productImage || !productType || !productQuantity) {
      return sendError(res, 400, 'Missing required fields', 'MISSING_FIELDS');
    }

    if (!['Returnable', 'Non-returnable'].includes(productType)) {
      return sendError(res, 400, 'Product type must be "Returnable" or "Non-returnable"', 'INVALID_TYPE');
    }

    const quantity = Number(productQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return sendError(res, 400, 'Product quantity must be greater than 0', 'INVALID_QUANTITY');
    }

    if (!tokenEmail || !isValidEmail(tokenEmail)) {
      return sendError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    }

    if (hrEmail && hrEmail !== tokenEmail) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }

    // Verify HR exists and has HR role
    const hr = await usersCollection.findOne({ email: tokenEmail });
    if (!hr) {
      return sendError(res, 404, 'HR user not found', 'HR_NOT_FOUND');
    }

    if (hr.role !== 'hr') {
      return sendError(res, 403, 'User is not an HR', 'NOT_HR');
    }

    const resolvedCompanyName = hr.companyName || companyName;
    if (!resolvedCompanyName) {
      return sendError(res, 400, 'Company name is required for HR', 'MISSING_COMPANY');
    }

    const asset = {
      productName: sanitize(productName),
      productImage: productImage,
      productType,
      productQuantity: quantity,
      availableQuantity: quantity,
      hrEmail: tokenEmail,
      companyName: sanitize(resolvedCompanyName),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await assetsCollection.insertOne(asset);

    res.status(201).json({
      _id: result.insertedId,
      ...asset
    });
  } catch (error) {
    console.error('Create asset error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * GET /assets - Get all assets created by specific HR
 */
app.get('/assets', verifyToken, verifyHR, async (req, res) => {
  try {
    const { email, page, limit } = req.query;

    if (!email) {
      return sendError(res, 400, 'Email query parameter required', 'MISSING_EMAIL');
    }

    if (!isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format', 'INVALID_EMAIL');
    }

    const query = { hrEmail: email };

    if (page || limit) {
      const pageNum = Math.max(parseInt(page || '1', 10), 1);
      const limitNum = Math.max(parseInt(limit || '10', 10), 1);
      const skip = (pageNum - 1) * limitNum;

      const [items, total] = await Promise.all([
        assetsCollection.find(query).skip(skip).limit(limitNum).toArray(),
        assetsCollection.countDocuments(query),
      ]);

      return res.json({
        data: items,
        total,
        page: pageNum,
        limit: limitNum,
      });
    }

    const assets = await assetsCollection.find(query).toArray();
    res.json(assets);
  } catch (error) {
    console.error('Get assets error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * GET /available-assets - Get all available assets in a company
 */
app.get('/available-assets', verifyToken, async (req, res) => {
  try {
    const { companyName } = req.query;

    const query = { availableQuantity: { $gt: 0 } };
    if (companyName) {
      query.companyName = sanitize(companyName);
    }

    const assets = await assetsCollection.find(query).toArray();

    res.json(assets);
  } catch (error) {
    console.error('Get available assets error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * GET /assigned-assets - Get assets assigned to an employee
 */
app.get('/assigned-assets', verifyToken, async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return sendError(res, 400, 'Email query parameter required', 'MISSING_EMAIL');
    }

    if (!isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format', 'INVALID_EMAIL');
    }

    if (req.decoded?.email !== email) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }

    const assignments = await assetAssignmentsCollection.find({
      employeeEmail: email,
      status: 'assigned'
    }).toArray();

    const normalizedAssignments = assignments.map((assignment) => ({
      ...assignment,
      assetId: assignment.assetId?.toString?.() || assignment.assetId,
    }));

    res.json(normalizedAssignments);
  } catch (error) {
    console.error('Get assigned assets error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * PUT /assets/:assetId - Update asset
 */
app.put('/assets/:assetId', verifyToken, verifyHR, async (req, res) => {
  try {
    const assetId = req.params.assetId;
    const { productName, productType, productQuantity } = req.body;

    if (!ObjectId.isValid(assetId)) {
      return sendError(res, 400, 'Invalid asset ID', 'INVALID_ID');
    }

    const asset = await assetsCollection.findOne({ _id: new ObjectId(assetId) });
    if (!asset) {
      return sendError(res, 404, 'Asset not found', 'ASSET_NOT_FOUND');
    }

    // If productQuantity is updated, validate it's >= assigned quantity
    if (productQuantity !== undefined && productQuantity > 0) {
      const assignedCount = await assetAssignmentsCollection.countDocuments({
        assetId: new ObjectId(assetId),
        status: 'assigned'
      });

      if (productQuantity < assignedCount) {
        return sendError(res, 400, `Cannot reduce quantity below assigned count (${assignedCount})`, 'INVALID_QUANTITY');
      }

      // Calculate available quantity change
      const oldAvailable = asset.availableQuantity;
      const quantityDifference = productQuantity - asset.productQuantity;
      const newAvailable = oldAvailable + quantityDifference;

      const updateData = {
        productQuantity,
        availableQuantity: Math.max(0, newAvailable),
        updatedAt: new Date()
      };

      if (productName) updateData.productName = sanitize(productName);
      if (productType) updateData.productType = productType;

      await assetsCollection.updateOne(
        { _id: new ObjectId(assetId) },
        { $set: updateData }
      );
    } else {
      const updateData = { updatedAt: new Date() };
      if (productName) updateData.productName = sanitize(productName);
      if (productType) updateData.productType = productType;

      await assetsCollection.updateOne(
        { _id: new ObjectId(assetId) },
        { $set: updateData }
      );
    }

    const updatedAsset = await assetsCollection.findOne({ _id: new ObjectId(assetId) });
    res.json(updatedAsset);
  } catch (error) {
    console.error('Update asset error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * DELETE /assets/:assetId - Delete asset (only if not assigned)
 */
app.delete('/assets/:assetId', verifyToken, verifyHR, async (req, res) => {
  try {
    const assetId = req.params.assetId;

    if (!ObjectId.isValid(assetId)) {
      return sendError(res, 400, 'Invalid asset ID', 'INVALID_ID');
    }

    const asset = await assetsCollection.findOne({ _id: new ObjectId(assetId) });
    if (!asset) {
      return sendError(res, 404, 'Asset not found', 'ASSET_NOT_FOUND');
    }

    // Check if asset is assigned
    if (asset.availableQuantity !== asset.productQuantity) {
      return sendError(res, 400, 'Cannot delete asset that has assignments', 'ASSET_ASSIGNED');
    }

    const result = await assetsCollection.deleteOne({ _id: new ObjectId(assetId) });

    res.json({
      success: true,
      message: 'Asset deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Delete asset error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

// ===================== REQUEST ENDPOINTS =====================

/**
 * GET /requests - Get requests based on query
 */
app.get('/requests', verifyToken, async (req, res) => {
  try {
    const { hrEmail, employeeEmail } = req.query;

    let query = {};
    if (hrEmail) query.hrEmail = hrEmail;
    if (employeeEmail) query.employeeEmail = employeeEmail;

    if (!hrEmail && !employeeEmail) {
      return sendError(res, 400, 'Either hrEmail or employeeEmail query parameter required', 'MISSING_PARAM');
    }

    if (hrEmail && req.decoded?.email !== hrEmail) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }
    if (employeeEmail && req.decoded?.email !== employeeEmail) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }

    const requests = await requestsCollection.find(query).toArray();
    res.json(requests);
  } catch (error) {
    console.error('Get requests error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * POST /requests - Create new asset request (Employee only)
 */
app.post('/requests', verifyToken, async (req, res) => {
  try {
    const {
      assetId,
      assetName,
      assetImage,
      assetType,
      employeeEmail,
      employeeName,
      hrEmail,
      companyName,
      note,
    } = req.body;

    // Validation
    if (!assetId || !employeeEmail || !employeeName || !hrEmail || !companyName) {
      return sendError(res, 400, 'Missing required fields', 'MISSING_FIELDS');
    }

    if (!ObjectId.isValid(assetId)) {
      return sendError(res, 400, 'Invalid asset ID', 'INVALID_ID');
    }

    if (req.decoded?.email !== employeeEmail) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }

    if (!isValidEmail(employeeEmail) || !isValidEmail(hrEmail)) {
      return sendError(res, 400, 'Invalid email format', 'INVALID_EMAIL');
    }

    // Verify asset exists and has available quantity
    const asset = await assetsCollection.findOne({ _id: new ObjectId(assetId) });
    if (!asset) {
      return sendError(res, 404, 'Asset not found', 'ASSET_NOT_FOUND');
    }

    if (asset.availableQuantity <= 0) {
      return sendError(res, 400, 'Asset not available', 'NO_AVAILABLE_QUANTITY');
    }

    // Check for duplicate pending request
    const existingRequest = await requestsCollection.findOne({
      assetId: new ObjectId(assetId),
      employeeEmail,
      status: 'pending'
    });

    if (existingRequest) {
      return sendError(res, 400, 'Employee already has a pending request for this asset', 'DUPLICATE_REQUEST');
    }

    const newRequest = {
      assetId: new ObjectId(assetId),
      assetName: assetName || asset.productName,
      assetImage: assetImage || asset.productImage,
      assetType: assetType || asset.productType,
      employeeEmail,
      employeeName: sanitize(employeeName),
      hrEmail,
      companyName: sanitize(companyName),
      requestDate: new Date(),
      status: 'pending',
      requestStatus: 'pending',
      note: sanitize(note || ''),
      approvalDate: null,
      rejectionReason: null,
      updatedAt: new Date()
    };

    const result = await requestsCollection.insertOne(newRequest);

    res.status(201).json({
      _id: result.insertedId,
      ...newRequest
    });
  } catch (error) {
    console.error('Create request error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * PATCH /requests/:requestId - Update request status (approve/reject)
 */
app.patch('/requests/:requestId', verifyToken, verifyHR, async (req, res) => {
  try {
    const requestId = req.params.requestId;
    const { status, rejectionReason } = req.body;

    if (!ObjectId.isValid(requestId)) {
      return sendError(res, 400, 'Invalid request ID', 'INVALID_ID');
    }

    if (!['approved', 'rejected'].includes(status)) {
      return sendError(res, 400, 'Status must be "approved" or "rejected"', 'INVALID_STATUS');
    }

    const request = await requestsCollection.findOne({ _id: new ObjectId(requestId) });
    if (!request) {
      return sendError(res, 404, 'Request not found', 'REQUEST_NOT_FOUND');
    }

    if (request.status !== 'pending') {
      return sendError(res, 400, 'Only pending requests can be updated', 'INVALID_STATE');
    }

    if (status === 'approved') {
      // Verify asset still has available quantity
      const asset = await assetsCollection.findOne({ _id: request.assetId });
      if (!asset || asset.availableQuantity <= 0) {
        return sendError(res, 400, 'Asset no longer available', 'NO_AVAILABLE_QUANTITY');
      }

      // Ensure affiliation exists for employee and company
      const hrUser = await usersCollection.findOne({ email: request.hrEmail });
      if (!hrUser) {
        return sendError(res, 404, 'HR user not found', 'HR_NOT_FOUND');
      }

      const affiliationFilter = {
        employeeEmail: request.employeeEmail,
        companyName: request.companyName,
      };

      const existingAffiliation = await affiliationsCollection.findOne({
        ...affiliationFilter,
        status: 'active'
      });

      if (!existingAffiliation) {
        const packageLimit = hrUser.packageLimit || 0;
        const currentEmployees = hrUser.currentEmployees || 0;

        if (packageLimit > 0 && currentEmployees >= packageLimit) {
          return sendError(res, 403, 'Package limit reached', 'PACKAGE_LIMIT');
        }

        await affiliationsCollection.insertOne({
          employeeEmail: request.employeeEmail,
          employeeName: sanitize(request.employeeName),
          hrEmail: request.hrEmail,
          companyName: sanitize(request.companyName),
          companyLogo: hrUser.companyLogo || null,
          affiliationDate: new Date(),
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await usersCollection.updateOne(
          { email: request.hrEmail },
          { $set: { currentEmployees: currentEmployees + 1 } }
        );
      } else {
        await affiliationsCollection.updateOne(
          affiliationFilter,
          { $set: { updatedAt: new Date() } }
        );
      }

      // Create asset assignment
      const assignment = {
        assetId: request.assetId,
        productName: request.assetName,
        productImage: request.assetImage,
        productType: asset.productType,
        employeeEmail: request.employeeEmail,
        employeeName: request.employeeName,
        companyName: request.companyName,
        requestDate: request.requestDate || new Date(),
        approvalDate: new Date(),
        assignedDate: new Date(),
        returnDate: null,
        status: 'assigned',
        notes: '',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const assignmentResult = await assetAssignmentsCollection.insertOne(assignment);

      // Decrease available quantity
      await assetsCollection.updateOne(
        { _id: request.assetId },
        {
          $set: {
            availableQuantity: asset.availableQuantity - 1,
            updatedAt: new Date()
          }
        }
      );

      // Update request
      const updateData = {
        status: 'approved',
        approvalDate: new Date(),
        updatedAt: new Date()
      };

      await requestsCollection.updateOne(
        { _id: new ObjectId(requestId) },
        { $set: updateData }
      );

      const updatedRequest = await requestsCollection.findOne({ _id: new ObjectId(requestId) });
      res.json(updatedRequest);
    } else if (status === 'rejected') {
      // Update request
      const updateData = {
        status: 'rejected',
        rejectionReason: rejectionReason || '',
        updatedAt: new Date()
      };

      await requestsCollection.updateOne(
        { _id: new ObjectId(requestId) },
        { $set: updateData }
      );

      const updatedRequest = await requestsCollection.findOne({ _id: new ObjectId(requestId) });
      res.json(updatedRequest);
    }
  } catch (error) {
    console.error('Update request error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

// ===================== ASSET ASSIGNMENT ENDPOINTS =====================

/**
 * GET /assigned-assets/:assetId - Get all employees who have this asset
 */
app.get('/assigned-assets/:assetId', verifyToken, verifyHR, async (req, res) => {
  try {
    const assetId = req.params.assetId;

    if (!ObjectId.isValid(assetId)) {
      return sendError(res, 400, 'Invalid asset ID', 'INVALID_ID');
    }

    const assignments = await assetAssignmentsCollection.find({
      assetId: new ObjectId(assetId)
    }).toArray();

    res.json(assignments);
  } catch (error) {
    console.error('Get asset assignments error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * PATCH /assigned-assets/:assignmentId/return - Return asset
 */
app.patch('/assigned-assets/:assignmentId/return', verifyToken, async (req, res) => {
  try {
    const assignmentId = req.params.assignmentId;
    const { employeeEmail } = req.body;

    if (!ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Invalid assignment ID', 'INVALID_ID');
    }

    if (!employeeEmail) {
      return sendError(res, 400, 'Employee email required', 'MISSING_EMAIL');
    }

    const assignment = await assetAssignmentsCollection.findOne({ _id: new ObjectId(assignmentId) });
    if (!assignment) {
      return sendError(res, 404, 'Assignment not found', 'ASSIGNMENT_NOT_FOUND');
    }

    if (assignment.status !== 'assigned') {
      return sendError(res, 400, 'Only assigned assets can be returned', 'INVALID_STATE');
    }

    if (req.decoded?.email !== employeeEmail || assignment.employeeEmail !== employeeEmail) {
      return sendError(res, 403, 'You can only return your own assets', 'FORBIDDEN');
    }

    // Find the asset
    const asset = await assetsCollection.findOne({ _id: assignment.assetId });
    if (!asset) {
      return sendError(res, 404, 'Asset not found', 'ASSET_NOT_FOUND');
    }

    // Increase available quantity
    await assetsCollection.updateOne(
      { _id: assignment.assetId },
      {
        $set: {
          availableQuantity: asset.availableQuantity + 1,
          updatedAt: new Date()
        }
      }
    );

    // Update assignment
    const updateData = {
      status: 'returned',
      returnDate: new Date(),
      updatedAt: new Date()
    };

    await assetAssignmentsCollection.updateOne(
      { _id: new ObjectId(assignmentId) },
      { $set: updateData }
    );

    const updatedAssignment = await assetAssignmentsCollection.findOne({ _id: new ObjectId(assignmentId) });
    res.json(updatedAssignment);
  } catch (error) {
    console.error('Return asset error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

// ===================== TEAM ENDPOINTS =====================

/**
 * GET /affiliations - Get affiliations by employee or company
 */
app.get('/affiliations', verifyToken, async (req, res) => {
  try {
    const { employeeEmail, companyName } = req.query;

    if (!employeeEmail && !companyName) {
      return sendError(res, 400, 'employeeEmail or companyName is required', 'MISSING_PARAM');
    }

    const query = { status: 'active' };
    if (employeeEmail) query.employeeEmail = sanitize(employeeEmail);
    if (companyName) query.companyName = sanitize(companyName);

    if (employeeEmail && req.decoded?.email !== employeeEmail) {
      return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
    }
    if (companyName) {
      const requesterEmail = req.decoded?.email;
      if (!requesterEmail) {
        return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
      }

      const requester = await usersCollection.findOne({ email: requesterEmail });
      const isHrUser = requester?.role === 'hr';

      if (!isHrUser) {
        const hasAffiliation = await affiliationsCollection.findOne({
          employeeEmail: sanitize(requesterEmail),
          companyName: sanitize(companyName),
          status: 'active',
        });

        if (!hasAffiliation) {
          return sendError(res, 403, 'Forbidden', 'FORBIDDEN');
        }
      }
    }

    const affiliations = await affiliationsCollection.find(query).toArray();
    res.json(affiliations);
  } catch (error) {
    console.error('Get affiliations error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * PATCH /affiliations/remove - Remove employee from company and return assets
 */
app.patch('/affiliations/remove', verifyToken, verifyHR, async (req, res) => {
  try {
    const { employeeEmail, companyName } = req.body;

    if (!employeeEmail || !companyName) {
      return sendError(res, 400, 'employeeEmail and companyName required', 'MISSING_FIELDS');
    }

    const affiliation = await affiliationsCollection.findOne({
      employeeEmail: sanitize(employeeEmail),
      companyName: sanitize(companyName),
      status: 'active'
    });

    if (!affiliation) {
      return sendError(res, 404, 'Affiliation not found', 'AFFILIATION_NOT_FOUND');
    }

    const assignments = await assetAssignmentsCollection.find({
      employeeEmail: sanitize(employeeEmail),
      companyName: sanitize(companyName),
      status: 'assigned'
    }).toArray();

    const now = new Date();

    for (const assignment of assignments) {
      await assetAssignmentsCollection.updateOne(
        { _id: assignment._id },
        { $set: { status: 'returned', returnDate: now, updatedAt: now } }
      );

      await assetsCollection.updateOne(
        { _id: assignment.assetId },
        { $inc: { availableQuantity: 1 }, $set: { updatedAt: now } }
      );
    }

    await affiliationsCollection.updateOne(
      { _id: affiliation._id },
      { $set: { status: 'inactive', updatedAt: now } }
    );

    if (affiliation.hrEmail) {
      const hrUser = await usersCollection.findOne({ email: affiliation.hrEmail });
      const currentEmployees = hrUser?.currentEmployees || 0;
      await usersCollection.updateOne(
        { email: affiliation.hrEmail },
        { $set: { currentEmployees: Math.max(0, currentEmployees - 1) } }
      );
    }

    res.json({ success: true, returnedAssets: assignments.length });
  } catch (error) {
    console.error('Remove affiliation error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * GET /team-members - Get all employees in a company
 */
app.get('/team-members', async (req, res) => {
  try {
    const { companyName, role } = req.query;

    const query = {};
    if (companyName) query.companyName = sanitize(companyName);
    if (role) query.role = role;

    // If no filters provided, still allow the request
    const teamMembers = await usersCollection.find(query).toArray();

    // Remove passwords from response
    teamMembers.forEach(member => delete member.password);

    res.json(teamMembers);
  } catch (error) {
    console.error('Get team members error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * POST /assign-asset - Directly assign asset to employee (HR only)
 */
app.post('/assign-asset', verifyToken, verifyHR, async (req, res) => {
  try {
    const { assetId, productName, productImage, productType, employeeEmail, employeeName, companyName } = req.body;

    // Validation
    if (!assetId || !employeeEmail || !employeeName || !companyName) {
      return sendError(res, 400, 'Missing required fields', 'MISSING_FIELDS');
    }

    if (!ObjectId.isValid(assetId)) {
      return sendError(res, 400, 'Invalid asset ID', 'INVALID_ID');
    }

    if (!isValidEmail(employeeEmail)) {
      return sendError(res, 400, 'Invalid email format', 'INVALID_EMAIL');
    }

    const affiliation = await affiliationsCollection.findOne({
      employeeEmail,
      companyName: sanitize(companyName),
      status: 'active'
    });

    if (!affiliation) {
      return sendError(res, 403, 'Employee is not affiliated with this company', 'NOT_AFFILIATED');
    }

    // Verify asset exists and has available quantity
    const asset = await assetsCollection.findOne({ _id: new ObjectId(assetId) });
    if (!asset) {
      return sendError(res, 404, 'Asset not found', 'ASSET_NOT_FOUND');
    }

    if (asset.availableQuantity <= 0) {
      return sendError(res, 400, 'Asset not available', 'NO_AVAILABLE_QUANTITY');
    }

    // Check if employee already has this asset assigned
    const existingAssignment = await assetAssignmentsCollection.findOne({
      assetId: new ObjectId(assetId),
      employeeEmail,
      status: 'assigned'
    });

    if (existingAssignment) {
      return sendError(res, 400, 'Employee already has this asset assigned', 'ALREADY_ASSIGNED');
    }

    // Create assignment
    const assignment = {
      assetId: new ObjectId(assetId),
      productName: productName || asset.productName,
      productImage: productImage || asset.productImage,
      productType: productType || asset.productType,
      employeeEmail,
      employeeName: sanitize(employeeName),
      companyName: sanitize(companyName),
      assignedDate: new Date(),
      returnDate: null,
      status: 'assigned',
      notes: '',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const assignmentResult = await assetAssignmentsCollection.insertOne(assignment);

    // Decrease available quantity
    await assetsCollection.updateOne(
      { _id: new ObjectId(assetId) },
      {
        $set: {
          availableQuantity: asset.availableQuantity - 1,
          updatedAt: new Date()
        }
      }
    );

    res.status(201).json({
      _id: assignmentResult.insertedId,
      ...assignment
    });
  } catch (error) {
    console.error('Assign asset error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

/**
 * GET /company-assignments - Get all assignments in a company
 */
app.get('/company-assignments', verifyToken, verifyHR, async (req, res) => {
  try {
    const { companyName } = req.query;

    if (!companyName) {
      return sendError(res, 400, 'Company name query parameter required', 'MISSING_COMPANY');
    }

    const assignments = await assetAssignmentsCollection.find({
      companyName: sanitize(companyName),
      status: 'assigned'
    }).toArray();

    const normalizedAssignments = assignments.map((assignment) => ({
      ...assignment,
      assetId: assignment.assetId?.toString?.() || assignment.assetId,
    }));

    res.json(normalizedAssignments);
  } catch (error) {
    console.error('Get company assignments error:', error.message);
    sendError(res, 500, error.message, 'SERVER_ERROR');
  }
});

// ===================== ERROR HANDLING =====================

/**
 * 404 handler
 */
app.use((req, res) => {
  sendError(res, 404, 'Endpoint not found', 'NOT_FOUND');
});

// ===================== SERVER STARTUP =====================

const server = app.listen(port, () => {
  console.log(`\n🚀 AssetVerse Server running on port ${port}`);
});

// Connect to database asynchronously
(async () => {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await client.connect();
    const database = client.db(db_name);
    
    // Initialize collections
    usersCollection = database.collection('users');
    assetsCollection = database.collection('assets');
    requestsCollection = database.collection('requests');
    assetAssignmentsCollection = database.collection('assetassignments');
    affiliationsCollection = database.collection('employeeAffiliations');
    packagesCollection = database.collection('packages');
    paymentsCollection = database.collection('payments');

    // Create indexes
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await usersCollection.createIndex({ companyName: 1, role: 1 });
    
    await assetsCollection.createIndex({ hrEmail: 1 });
    await assetsCollection.createIndex({ companyName: 1 });
    
    await requestsCollection.createIndex({ hrEmail: 1, status: 1 });
    await requestsCollection.createIndex({ employeeEmail: 1 });
    await requestsCollection.createIndex({ companyName: 1 });
    
    await assetAssignmentsCollection.createIndex({ employeeEmail: 1, status: 1 });
    await assetAssignmentsCollection.createIndex({ assetId: 1 });
    await assetAssignmentsCollection.createIndex({ companyName: 1 });

    await affiliationsCollection.createIndex({ employeeEmail: 1, companyName: 1 }, { unique: true });
    await affiliationsCollection.createIndex({ companyName: 1, status: 1 });

    await packagesCollection.createIndex({ name: 1 }, { unique: true });
    await paymentsCollection.createIndex({ hrEmail: 1, paymentDate: -1 });

    const packageCount = await packagesCollection.countDocuments();
    if (packageCount === 0) {
      await packagesCollection.insertMany([
        {
          name: 'Basic',
          employeeLimit: 5,
          price: 5,
          features: ['Asset Tracking', 'Employee Management', 'Basic Support'],
        },
        {
          name: 'Standard',
          employeeLimit: 10,
          price: 8,
          features: ['All Basic features', 'Advanced Analytics', 'Priority Support'],
        },
        {
          name: 'Premium',
          employeeLimit: 20,
          price: 15,
          features: ['All Standard features', 'Custom Branding', '24/7 Support'],
        },
      ]);
    }

    await client.db('admin').command({ ping: 1 });
    console.log('✅ MongoDB connected successfully!\n');
  } catch (error) {
    console.error('❌ MongoDB Error:', error.message);
    server.close();
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⛔ Shutting down gracefully...');
  await client.close();
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
