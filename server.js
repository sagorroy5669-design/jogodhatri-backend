// server.js (Heroku Version)

// ধাপ ১: প্রয়োজনীয় প্যাকেজ ইম্পোর্ট করুন
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

// ধাপ ২: Express অ্যাপ এবং Firebase Admin SDK চালু করুন
const app = express();
app.use(cors()); // CORS চালু করুন
app.use(express.json()); // JSON অনুরোধ পড়ার জন্য

// Service Account Key সেটআপ
// এই key ফাইলটি Heroku তে সরাসরি আপলোড না করে, এর কন্টেন্ট Environment Variable এ রাখা ভালো
// কিন্তু সহজ করার জন্য, আপাতত আমরা ফাইল হিসেবে রাখছি
const serviceAccount = require('./path/to/your/serviceAccountKey.json'); // আপনার ডাউনলোড করা কী ফাইলের পাথ দিন

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ধাপ ৩: আপনার মূল লজিক (Constants এবং Helper Functions) কপি করুন
const LEVEL_COSTS = {
  1: 6, 2: 12, 3: 25, 4: 40, 5: 50,
  6: 65, 7: 80, 8: 100, 9: 125, 10: 160,
};

const DISTRIBUTION_RULES = {
    1: {admin: 3, refs: [2, 0.5, 0.5]},
    2: {admin: 6, refs: [4, 1, 1]},
    3: {admin: 12, refs: [8, 2, 2, 1]},
    4: {admin: 17, refs: [12, 4, 3, 2, 1]},
    5: {admin: 23, refs: [17, 4, 3, 2, 1]},
    6: {admin: 30, refs: [25, 4, 3, 2, 1]},
    7: {admin: 36, refs: [30, 5, 4, 3, 2]},
    8: {admin: 50, refs: [35, 5, 4, 3, 2, 1]},
    9: {admin: 70, refs: [40, 5, 4, 3, 2, 1]},
    10: {admin: 56, refs: [50, 10, 9, 8, 7, 6, 5, 4, 3, 2]},
};

const MAX_REFERRAL_DEPTH = 10;
const ADMIN_UID = process.env.ADMIN_UID; // Heroku Environment Variable থেকে অ্যাডমিন UID নিন

async function distributeCoins(transaction, userRef, distributionRule) {
    if (ADMIN_UID && distributionRule.admin > 0) {
        const adminRef = db.collection("users").doc(ADMIN_UID);
        transaction.update(adminRef, { coins: admin.firestore.FieldValue.increment(distributionRule.admin) });
    }

    const userData = (await transaction.get(userRef)).data();
    let currentReferrerId = userData.referrerId;
    const ruleRefs = distributionRule.refs;

    for (let i = 0; i < ruleRefs.length && i < MAX_REFERRAL_DEPTH && currentReferrerId; i++) {
        const referrerRef = db.collection("users").doc(currentReferrerId);
        const referrerDoc = await transaction.get(referrerRef);

        if (referrerDoc.exists) {
            transaction.update(referrerRef, { coins: admin.firestore.FieldValue.increment(ruleRefs[i]) });
            currentReferrerId = referrerDoc.data().referrerId;
        } else {
            console.warn(`Referrer with ID ${currentReferrerId} not found.`);
            break;
        }
    }
}

// ধাপ ৪: নিরাপত্তা নিশ্চিত করার জন্য Middleware তৈরি করুন
async function verifyToken(req, res, next) {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
        return res.status(401).send({ success: false, error: 'Unauthorized: No token provided.' });
    }
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        return res.status(401).send({ success: false, error: 'Unauthorized: Invalid token.' });
    }
}

// ধাপ ৫: API Endpoints তৈরি করুন
app.post('/activateAccount', verifyToken, async (req, res) => {
    const userId = req.user.uid;
    const selectedLevel = req.body.level;

    if (!selectedLevel || !LEVEL_COSTS[selectedLevel]) {
        return res.status(400).send({ success: false, error: "A valid level (1-10) must be provided." });
    }

    const requiredCoins = LEVEL_COSTS[selectedLevel];
    const userRef = db.collection("users").doc(userId);

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new Error("Your user profile was not found.");
            
            const userData = userDoc.data();
            if (userData.status === "active") throw new Error("Account is already active.");
            if (userData.coins < requiredCoins) throw new Error(`Insufficient coins. Required: ${requiredCoins}.`);

            transaction.update(userRef, {
                coins: admin.firestore.FieldValue.increment(-requiredCoins),
                status: "active",
                accountLevel: selectedLevel,
            });

            const rule = DISTRIBUTION_RULES[selectedLevel];
            await distributeCoins(transaction, userRef, rule);
        });

        console.log(`SUCCESS: User ${userId} activated to level ${selectedLevel}.`);
        res.status(200).send({ success: true, message: "Account activated successfully!" });

    } catch (error) {
        console.error(`FAILURE: Account activation for user ${userId} failed.`, error);
        res.status(500).send({ success: false, error: error.message || "An internal error occurred." });
    }
});

// upgradeUserLevel এর জন্যও একই রকম API Endpoint তৈরি করতে হবে
// ... (একইভাবে upgradeUserLevel এর জন্য কোড লিখুন)

// ধাপ ৬: সার্ভার চালু করুন
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

