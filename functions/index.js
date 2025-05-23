const { onCall } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const cloudinary = require("cloudinary").v2;

admin.initializeApp();

// Secrets
const ZOHO_USER = defineSecret("ZOHO_USER");
const ZOHO_PASS = defineSecret("ZOHO_PASS");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const CLOUDINARY_CLOUD_NAME = defineSecret("CLOUDINARY_CLOUD_NAME");
const CLOUDINARY_API_KEY = defineSecret("CLOUDINARY_API_KEY");
const CLOUDINARY_API_SECRET = defineSecret("CLOUDINARY_API_SECRET");

// Send password reset email
exports.sendResetEmail = onCall(
  { secrets: [ZOHO_USER, ZOHO_PASS], region: "us-central1" },
  async (req) => {
    const email = req.data?.email;
    if (!email) throw new Error("Email is required.");

    const resetLink = await admin.auth().generatePasswordResetLink(email);
    const transporter = nodemailer.createTransport({
      host: "smtp.zoho.com",
      port: 465,
      secure: true,
      auth: {
        user: ZOHO_USER.value(),
        pass: ZOHO_PASS.value(),
      },
    });

    const html = `
      <div style="font-family: 'Segoe UI', sans-serif;">
        <h1 style="color: #1E90FF;">Reset Your Clink Password</h1>
        <p>Click the button below to reset your password:</p>
        <a href="${resetLink}" style="background:#1E90FF;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Reset Password</a>
        <p>If you didn’t request this, you can ignore this email.</p>
      </div>
    `;

    await transporter.sendMail({
      from: `Clink Support <${ZOHO_USER.value()}>`,
      to: email,
      subject: "Reset Your Clink Password",
      html,
    });

    return { success: true };
  }
);

// Create Stripe PaymentIntent
exports.createPaymentIntent = onCall(
  { secrets: [STRIPE_SECRET_KEY], region: "us-central1" },
  async (req) => {
    const { amount, currency = "usd", creatorStripeAccountId } = req.data;
    if (!req.auth) throw new Error("User must be authenticated");
    if (!amount || !creatorStripeAccountId) throw new Error("Missing parameters");

    const stripe = require("stripe")(STRIPE_SECRET_KEY.value());

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      payment_method_types: ["card"],
      application_fee_amount: Math.round(amount * 0.07),
      transfer_data: {
        destination: creatorStripeAccountId,
      },
    });

    return { clientSecret: paymentIntent.client_secret };
  }
);

// Send receipt email and upload PDF to Cloudinary
exports.sendReceiptEmail = onCall(
  {
    secrets: [ZOHO_USER, ZOHO_PASS, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET],
    region: "us-central1",
  },
  async (req) => {
    const { hireRequestId } = req.data;
    if (!hireRequestId) throw new Error("Missing hireRequestId");

    const hireSnap = await admin.firestore().doc(`hireRequests/${hireRequestId}`).get();
    if (!hireSnap.exists) throw new Error("Hire request not found");
    const hireData = hireSnap.data();

    const [businessDoc, creatorDoc] = await Promise.all([
      admin.firestore().doc(`users/${hireData.businessId}`).get(),
      admin.firestore().doc(`users/${hireData.creatorId}`).get(),
    ]);

    if (!businessDoc.exists || !creatorDoc.exists) throw new Error("User not found");
    const businessEmail = businessDoc.data().email;
    const creatorEmail = creatorDoc.data().email;

    // Generate PDF
    const invoiceNumber = `CLINK-${Date.now().toString().slice(-6)}`;
    const filePath = path.join("/tmp", `receipt_${hireRequestId}.pdf`);
    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(filePath));
    doc.fontSize(20).text("Clink Receipt", { align: "center" });
    doc.moveDown();
    doc.fontSize(14).text(`Invoice #: ${invoiceNumber}`);
    doc.text(`Hire Request ID: ${hireRequestId}`);
    doc.text(`Amount Paid: $${(hireData.amount / 100).toFixed(2)}`);
    doc.text(`Creator Stripe Account: ${hireData.creatorStripeAccountId}`);
    doc.text(`Business Email: ${businessEmail}`);
    doc.text(`Creator Email: ${creatorEmail}`);
    doc.end();

    await new Promise((resolve) => doc.on("end", resolve));

    // Upload to Cloudinary
    cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME.value(),
      api_key: CLOUDINARY_API_KEY.value(),
      api_secret: CLOUDINARY_API_SECRET.value(),
    });

    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: "raw",
      folder: "receipts",
      public_id: hireRequestId,
      overwrite: true,
    });

    const receiptUrl = result.secure_url;

    // Save to Firestore
    await admin.firestore().collection("receipts").doc(hireRequestId).set({
      hireRequestId,
      invoiceNumber,
      amount: hireData.amount,
      createdAt: new Date(),
      businessId: hireData.businessId,
      creatorId: hireData.creatorId,
      downloadUrl: receiptUrl,
    });

    // Send Email
    const transporter = nodemailer.createTransport({
      host: "smtp.zoho.com",
      port: 465,
      secure: true,
      auth: {
        user: ZOHO_USER.value(),
        pass: ZOHO_PASS.value(),
      },
    });

    await transporter.sendMail({
      from: `Clink Receipts <${ZOHO_USER.value()}>`,
      to: businessEmail,
      cc: creatorEmail,
      subject: "Clink Receipt - Payment Confirmed",
      html: `
        <div style="font-family: Arial;">
          <h2>✅ Payment Receipt</h2>
          <p>Invoice #: <strong>${invoiceNumber}</strong></p>
          <p>Amount: <strong>$${(hireData.amount / 100).toFixed(2)}</strong></p>
          <p><a href="${receiptUrl}">View PDF Receipt</a></p>
        </div>
      `,
    });

    return { success: true, downloadUrl: receiptUrl };
  }
);

// Create Stripe account link for onboarding
exports.createStripeAccountLink = onCall(
  {
    secrets: [STRIPE_SECRET_KEY],
    region: "us-central1",
  },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new Error("Unauthorized");

    const stripe = require("stripe")(STRIPE_SECRET_KEY.value());
    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new Error("User not found");
    const user = userSnap.data();

    let stripeAccountId = user.stripeAccountId;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });

      stripeAccountId = account.id;
      await userRef.update({ stripeAccountId });
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: "https://clinkapp.org/stripe-refresh",
      return_url: "https://clinkapp.org/stripe-return",
      type: "account_onboarding",
    });

    return { url: accountLink.url };
  }
);

exports.verifyStripeAccount = onCall(
  {
    secrets: [STRIPE_SECRET_KEY],
    region: "us-central1",
  },
  async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new Error("Unauthorized");

    const stripe = require("stripe")(STRIPE_SECRET_KEY.value());
    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new Error("User not found");

    const { stripeAccountId } = userSnap.data();
    if (!stripeAccountId) throw new Error("No Stripe account found");

    const account = await stripe.accounts.retrieve(stripeAccountId);

    const verified = account.details_submitted && account.charges_enabled;

    await userRef.update({
      stripeVerified: verified,
    });

    return { stripeVerified: verified };
  }
);

