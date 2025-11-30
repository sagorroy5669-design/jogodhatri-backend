// server.js - Vercel-এর জন্য চূড়ান্ত এবং শক্তিশালী সংস্করণ

const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Firebase Admin SDK সেটআপ ---
try {
    // নিশ্চিত করুন যে আপনার Vercel Environment Variable-এ FIREBASE_SERVICE_ACCOUNT_KEY সঠিকভাবে সেট করা আছে
    if (admin.apps.length === 0) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin SDK initialized successfully.");
    }
} catch (error) {
    console.error("Firebase Admin SDK initialization failed:", error);
}

const db = admin.firestore();

// --- অ্যাপ্লিকেশনের মূল কনস্ট্যান্ট এবং নিয়ম ---
const LEVEL_COSTS = { 1: 6, 2: 12, 3: 25, 4: 40, 5: 50, 6: 65, 7: 80, 8: 100, 9: 125, 10: 160 };
const DISTRIBUTION_RULES = { 1: {admin: 3, refs: [2, 0.5, 0.5]}, 2: {admin: 6, refs: [4, 1, 1]}, 3: {admin: 12, refs: [8, 2, 2, 1]}, 4: {admin: 17, refs: [12, 4, 3, 2, 1]}, 5: {admin: 23, refs: [17, 4, 3, 2, 1]}, 6: {admin: 30, refs: [25, 4, 3, 2, 1]}, 7: {admin: 36, refs: [30, 5, 4, 3, 2]}, 8: {admin: 50, refs: [35, 5, 4, 3, 2, 1]}, 9: {admin: 70, refs: [40, 5, 4, 3, 2, 1]}, 10: {admin: 56, refs: [50, 10, 9, 8, 7, 6, 5, 4, 3, 2]} };
const MAX_REFERRAL_DEPTH = 10;
const ADMIN_UID = process.env.ADMIN_UID; // নিশ্চিত করুন যে ADMIN_UID এনভায়রনমেন্ট ভ্যারিয়েবলে সেট করা আছে

// --- Helper ফাংশন: আপলাইনদের মধ্যে কয়েন বিতরণ ---
async function distributeCoins(transaction, userRef, distributionRule) {
    if (!distributionRule) {
        console.warn("Distribution rule is undefined. Skipping coin distribution.");
        return;
    }
    // অ্যাডমিনকে তার অংশ দিন
    if (ADMIN_UID && distributionRule.admin > 0) {
        const adminRef = db.collection("users").doc(ADMIN_UID);
        transaction.update(adminRef, { coins: admin.firestore.FieldValue.increment(distributionRule.admin) });
    }
    
    // আপলাইনদের মধ্যে বিতরণ করুন
    const userData = (await transaction.get(userRef)).data();
    let currentReferrerId = userData.referrerId;

    for (let i = 0; i < distributionRule.refs.length && i < MAX_REFERRAL_DEPTH && currentReferrerId; i++) {
        const referrerRef = db.collection("users").doc(currentReferrerId);
        const referrerDoc = await transaction.get(referrerRef);
        
        if (referrerDoc.exists) {
            transaction.update(referrerRef, { coins: admin.firestore.FieldValue.increment(distributionRule.refs[i]) });
            currentReferrerId = referrerDoc.data().referrerId; // পরবর্তী আপলাইনের জন্য
        } else {
            console.warn(`Referrer with ID ${currentReferrerId} not found in chain. Stopping distribution.`);
            break;
        }
    }
}

// --- নিরাপত্তা Middleware: Firebase টোকেন যাচাই করা ---
async function verifyFirebaseToken(req, res, next) {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
        return res.status(401).send({ success: false, error: 'Unauthorized: No token provided.' });
    }
    try {
        req.user = await admin.auth().verifyIdToken(token);
        next(); // টোকেন সঠিক হলে পরবর্তী ধাপে যান
    } catch (error) {
        console.error("Invalid token error:", error);
        return res.status(401).send({ success: false, error: 'Unauthorized: Invalid token.' });
    }
}

// --- মূল রাউটার: সমস্ত কাজ (Action) পরিচালনা করার জন্য একটিমাত্র এন্ডপয়েন্ট ---
app.post('/api/server', verifyFirebaseToken, async (req, res) => {
    const { action, data } = req.body;
    const userId = req.user.uid;
    
    if (!action) {
        return res.status(400).send({ success: false, error: 'No action specified.' });
    }
    
    console.log(`Action received: '${action}' for User: ${userId}`);

    try {
        switch (action) {
            // --- অ্যাকাউন্ট অ্যাক্টিভেশন ---
            case 'ACTIVATE_ACCOUNT':
                const selectedLevel = data.level;
                if (!selectedLevel || !LEVEL_COSTS[selectedLevel]) {
                    return res.status(400).send({ success: false, error: "A valid level (1-10) must be provided." });
                }
                await db.runTransaction(async (t) => {
                    const userRef = db.collection("users").doc(userId);
                    const doc = await t.get(userRef);
                    if (!doc.exists) throw new Error("Your user profile was not found.");
                    
                    const userData = doc.data();
                    if (userData.status === "active") throw new Error("Account is already active.");
                    if (userData.coins < LEVEL_COSTS[selectedLevel]) throw new Error(`Insufficient coins. Required: ${LEVEL_COSTS[selectedLevel]}.`);

                    t.update(userRef, {
                        coins: admin.firestore.FieldValue.increment(-LEVEL_COSTS[selectedLevel]),
                        status: "active",
                        accountLevel: selectedLevel,
                    });
                    await distributeCoins(t, userRef, DISTRIBUTION_RULES[selectedLevel]);
                });
                return res.status(200).send({ success: true, message: "Account activated successfully!" });

            // --- লেভেল আপগ্রেড ---
            case 'UPGRADE_USER_LEVEL':
                const targetLevel = data.targetLevel;
                if (!targetLevel || targetLevel <= 1 || targetLevel > 10) {
                    return res.status(400).send({ success: false, error: "Invalid target level provided." });
                }
                await db.runTransaction(async (t) => {
                    const userRef = db.collection("users").doc(userId);
                    const doc = await t.get(userRef);
                    if (!doc.exists) throw new Error("User profile not found.");

                    const userData = doc.data();
                    if (targetLevel <= (userData.accountLevel || 0)) throw new Error("You can only upgrade to a higher level.");
                    if (userData.coins < LEVEL_COSTS[targetLevel]) throw new Error(`Insufficient coins. Required: ${LEVEL_COSTS[targetLevel]}.`);

                    t.update(userRef, {
                        coins: admin.firestore.FieldValue.increment(-LEVEL_COSTS[targetLevel]),
                        accountLevel: targetLevel,
                    });
                    await distributeCoins(t, userRef, DISTRIBUTION_RULES[targetLevel]);
                });
                return res.status(200).send({ success: true, message: "Level upgraded successfully!" });

            // --- প্রোফাইল তথ্য আপডেট ---
            case 'UPDATE_PROFILE_INFO':
                const { name, bio } = data;
                await db.collection("users").doc(userId).update({ name, bio });
                return res.status(200).send({ success: true, message: "Profile information updated." });

            // --- সোশ্যাল লিঙ্ক আপডেট ---
            case 'UPDATE_SOCIAL_LINKS':
                const { facebookLink, linkedInLink } = data;
                await db.collection("users").doc(userId).update({ facebookLink, linkedInLink });
                return res.status(200).send({ success: true, message: "Social links updated." });
                
            // --- প্রোফাইল ছবি আপডেট ---
            case 'UPDATE_PROFILE_IMAGE':
                 // data অবজেক্টটি হবে { "profileImageUrl": "new_url" } অথবা { "coverImageUrl": "new_url" }
                await db.collection("users").doc(userId).update(data);
                return res.status(200).send({ success: true, message: "Image updated successfully." });

            // --- ভুল অ্যাকশন ---
            default:
                return res.status(400).send({ success: false, error: 'Invalid action specified.' });
        }
    } catch (error) {
        console.error(`FAILURE ('${action}'): User ${userId}. Reason:`, error.message);
        return res.status(400).send({ success: false, error: error.message });
    }
});

// Vercel-এর জন্য Express অ্যাপটি এক্সপোর্ট করতে হয়
module.exports = app;