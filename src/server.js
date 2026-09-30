import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import { readDb, updateDb, id } from "./store.js";
import { signToken, auth, adminOnly } from "./auth.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Cloudinary setup
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dewdakkvj",
  api_key: process.env.CLOUDINARY_API_KEY || "885692934117445",
  api_secret: process.env.CLOUDINARY_API_SECRET || "3Klx9NQywZsF6KdV8_3wlxf9rr0"
});

// Multer setup with strict file filter and size protection
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, "../uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/jpg", "application/pdf"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("INVALID_FILE_TYPE: Only JPEG, PNG, WEBP, and PDF files are allowed"));
    }
  }
});
app.use("/uploads", express.static(uploadDir));

// Cloudinary upload helper
async function uploadToCloudinary(file, folder = "evsmith") {
  if (!file || !file.path) return null;
  try {
    const res = await cloudinary.uploader.upload(file.path, { folder });
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.secure_url;
  } catch (err) {
    console.error("Cloudinary upload error:", err.message);
    return `/uploads/${file.filename}`;
  }
}

const now = () => new Date().toISOString();
const cleanStr = s => String(s || "").trim().toLowerCase();
const send = (res, data) => res.json(data);

// In-memory sliding-window rate limiter
function createRateLimiter({ windowMs = 60000, max = 15, message = "Too many requests. Please try again later." } = {}) {
  const hits = new Map();
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, record] of hits.entries()) {
      if (record.resetTime < cutoff) hits.delete(key);
    }
  }, 5 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  return (req, res, next) => {
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "global";
    const curNow = Date.now();
    let record = hits.get(ip);
    if (!record || curNow > record.resetTime) {
      record = { count: 1, resetTime: curNow + windowMs };
      hits.set(ip, record);
    } else {
      record.count += 1;
    }

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - record.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(record.resetTime / 1000));

    if (record.count > max) {
      res.setHeader("Retry-After", Math.ceil((record.resetTime - curNow) / 1000));
      return res.status(429).json({
        message,
        retryAfterSeconds: Math.ceil((record.resetTime - curNow) / 1000)
      });
    }
    next();
  };
}

const authLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20, message: "Too many authentication attempts. Please try again in 1 minute." });
const otpLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10, message: "Too many OTP requests. Please wait 1 minute before requesting again." });

// Seed default user (evsmith@gmail.com / 9515362625) and admin if missing
function ensureSeedData() {
  updateDb(db => {
    if (!db.banners) {
      db.banners = [
        { id: "banner_main", type: "MAIN", imageUrl: "https://res.cloudinary.com/demo/image/upload/v1689000000/ev_scooter_main.jpg", title: "Ride Green Ride Smart", subtitle: "Affordable | Safe | Reliable" },
        { id: "banner_secondary", type: "SECONDARY", imageUrl: "https://res.cloudinary.com/demo/image/upload/v1689000001/ev_scooter_secondary.jpg", title: "Clean Energy Better Tomorrow" }
      ];
    }
    if (!db.agreement) {
      db.agreement = {
        title: "EV SCOOTER RENTAL AGREEMENT",
        subtitle: "EVSMITH - RIDE ELECTRIC. RIDE SMART.",
        lessorName: "evsmith Mobility Solutions",
        lessorAddress: "Madhapur, Hyderabad, Telangana - 500081",
        supportHelpline: "+91 95153 62625",
        clauses: [
          {
            id: "c1",
            heading: "1. Customer Declaration",
            text: "I possess a valid Driving Licence, am medically fit to ride, will obey all traffic rules, will not ride under influence, will wear a helmet, and take responsibility for any traffic fines."
          },
          {
            id: "c2",
            heading: "2. Customer Responsibilities",
            text: "Return the scooter in same condition, inform owner immediately of accidents, do not tamper with GPS or battery, and keep vehicle safely parked."
          },
          {
            id: "c3",
            heading: "3. Accident Clause",
            text: "Immediate intimation to owner within 1 hour. Do not admit liability without authorization. Damage responsibility determined based on policy & facts."
          },
          {
            id: "c4",
            heading: "4. Traffic Challans & Theft",
            text: "Customer pays all traffic challans and fines. In case of vehicle theft, immediate police complaint and GPS tracking activation is mandatory."
          },
          {
            id: "c5",
            heading: "5. Prohibited Uses",
            text: "Racing, stunts, illegal activities, carrying hazardous materials, commercial courier overload, and riding outside permitted city limits."
          }
        ],
        updatedAt: new Date().toISOString()
      };
    }
    let user = db.users.find(u => cleanStr(u.email) === "evsmith@gmail.com" || cleanStr(u.mobile) === "9515362625" || cleanStr(u.email) === "demo@evsmith.in");
    if (!user) {
      db.users.push({
        id: "USR-001",
        name: "EV Smith",
        email: "evsmith@gmail.com",
        mobile: "9515362625",
        status: "ACTIVE",
        kycStatus: "VERIFIED",
        createdAt: new Date().toISOString()
      });
      console.log("Seeded static user evsmith@gmail.com / 9515362625");
    } else {
      user.name = "EV Smith";
      user.email = "evsmith@gmail.com";
      user.mobile = "9515362625";
      user.status = "ACTIVE";
      user.kycStatus = "VERIFIED";
    }

    if (!db.admins.find(a => cleanStr(a.email) === "admin@evsmith.in")) {
      db.admins.push({
        id: "ADM-001",
        name: "EVSmith Admin",
        email: "admin@evsmith.in",
        password: "admin123"
      });
    }
  });
}
ensureSeedData();

app.get("/api/health", (_, res) => send(res, { ok: true, service: "EVSmith API", time: now(), dbConnected: mongoose.connection.readyState === 1 }));

// ---------------- AUTH ----------------
app.get("/api/banners", (req, res) => send(res, { banners: readDb().banners || [] }));

app.post("/api/admin/banners/:id/upload", auth, adminOnly, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No image file provided" });
  try {
    let imageUrl = await uploadToCloudinary(req.file, "evsmith/banners");
    if (imageUrl && !imageUrl.startsWith("http")) {
      const host = req.get("host") || "localhost:5000";
      imageUrl = `${req.protocol}://${host}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`;
    }

    let updatedBanner;
    updateDb(db => {
      if (!db.banners) db.banners = [];
      const banner = db.banners.find(b => b.id === req.params.id);
      if (banner) {
        banner.imageUrl = imageUrl;
        updatedBanner = banner;
      }
    });

    send(res, { imageUrl, banner: updatedBanner, message: "Banner image uploaded successfully" });
  } catch (err) {
    console.error("Banner upload error:", err);
    res.status(500).json({ message: err.message || "Banner upload failed" });
  }
});

app.post("/api/upload", auth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No image file provided" });
  try {
    let url = await uploadToCloudinary(req.file, req.body.folder || "evsmith");
    if (url && !url.startsWith("http")) {
      const host = req.get("host") || "localhost:5000";
      url = `${req.protocol}://${host}${url.startsWith("/") ? "" : "/"}${url}`;
    }
    send(res, { url, message: "Image uploaded successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

app.put("/api/admin/banners", auth, adminOnly, (req, res) => {
  let updatedBanners;
  updateDb(db => {
    db.banners = req.body.banners;
    updatedBanners = db.banners;
  });
  send(res, { banners: updatedBanners });
});

// ---------------- CMS AGREEMENT ----------------
app.get("/api/cms/agreement", (req, res) => {
  const db = readDb();
  send(res, { agreement: db.agreement || {} });
});

app.put("/api/admin/cms/agreement", auth, adminOnly, (req, res) => {
  let updatedAgreement;
  updateDb(db => {
    db.agreement = {
      ...db.agreement,
      ...req.body,
      updatedAt: now()
    };
    updatedAgreement = db.agreement;
  });
  send(res, { agreement: updatedAgreement, message: "Agreement terms updated successfully" });
});

app.post("/api/auth/register", authLimiter, (req, res) => {
  const fields = ["name","email","mobile","alternateMobile","dob","gender","occupation","occupationId"];
  const email = cleanStr(req.body.email);
  const mobile = cleanStr(req.body.mobile || req.body.email);
  if (!req.body.name || (!email && !mobile)) return res.status(400).json({ message: "Name, email/mobile are required" });
  let user;
  try {
    updateDb(db => {
      const existing = db.users.find(u => cleanStr(u.email) === email || cleanStr(u.mobile) === mobile);
      if (existing) throw new Error("USER_EXISTS");
      user = { id: id("USR"), name: String(req.body.name).trim(), email: email || `${mobile}@evsmith.in`, mobile: mobile || "9515362625", status: "ACTIVE", kycStatus: "PENDING", createdAt: now() };
      fields.forEach(k => { if (k !== "name" && k !== "email" && k !== "mobile" && req.body[k] !== undefined) user[k] = req.body[k]; });
      db.users.push(user);
    });
  } catch (e) {
    if (e.message === "USER_EXISTS") return res.status(409).json({ message: "An account already exists for this mobile/email" });
    return res.status(500).json({ message: "Registration failed" });
  }
  send(res, { message: "Registration created", token: signToken({ id: user.id, role: "USER", registration: true }), user });
});

app.post("/api/auth/request-otp", otpLimiter, (req, res) => {
  const input = cleanStr(req.body.mobile || req.body.email || req.body.identifier);
  if (!input) return res.status(400).json({ message: "Mobile number or Email is required" });

  let user = readDb().users.find(u => cleanStr(u.mobile) === input || cleanStr(u.email) === input);
  if (!user) {
    updateDb(db => {
      user = {
        id: id("USR"),
        name: input === "evsmith@gmail.com" || input === "9515362625" ? "EV Smith" : `Rider ${input}`,
        email: input.includes("@") ? input : `evsmith@gmail.com`,
        mobile: input.includes("@") ? "9515362625" : input,
        status: "ACTIVE",
        kycStatus: "VERIFIED",
        createdAt: now()
      };
      db.users.push(user);
    });
  }
  console.log(`EVSmith OTP for ${input}: 123456`);
  send(res, { message: "OTP sent successfully", devOtp: "123456" });
});

app.post("/api/auth/verify-otp", authLimiter, (req, res) => {
  const input = cleanStr(req.body.mobile || req.body.email || req.body.identifier);
  const otp = String(req.body.otp || "").trim();
  if (!input || otp !== "123456") return res.status(401).json({ message: "Invalid OTP. Use 123456 for demo." });

  let user = readDb().users.find(u => cleanStr(u.mobile) === input || cleanStr(u.email) === input);
  if (!user) {
    updateDb(db => {
      user = {
        id: id("USR"),
        name: input === "evsmith@gmail.com" || input === "9515362625" ? "EV Smith" : `Rider ${input}`,
        email: input.includes("@") ? input : `evsmith@gmail.com`,
        mobile: input.includes("@") ? "9515362625" : input,
        status: "ACTIVE",
        kycStatus: "VERIFIED",
        createdAt: now()
      };
      db.users.push(user);
    });
  }
  send(res, { token: signToken({ id: user.id, role: "USER" }), user });
});

app.post("/api/auth/admin-login", authLimiter, (req, res) => {
  const email = cleanStr(req.body.email);
  const password = String(req.body.password || "");
  const admin = readDb().admins.find(a => cleanStr(a.email) === email && a.password === password);
  if (!admin) return res.status(401).json({ message: "Invalid admin credentials" });
  send(res, { token: signToken({ id: admin.id, role: "ADMIN" }), admin: { id: admin.id, name: admin.name, email: admin.email } });
});

// ---------------- USER PROFILE / KYC ----------------
app.get("/api/me", auth, (req, res) => {
  const db = readDb();
  if (req.user.role === "ADMIN") return send(res, { admin: db.admins.find(a => a.id === req.user.id) });
  send(res, { user: db.users.find(u => u.id === req.user.id) });
});

const userFields = ["name","email","mobile","alternateMobile","dob","gender","occupation","occupationId","currentAddress","permanentAddress","emergencyName","emergencyMobile","kycStatus", "avatar"];
app.put("/api/me", auth, (req, res) => {
  if (req.user.role !== "USER") return res.status(403).json({ message: "User only" });
  let updated;
  updateDb(db => {
    const u = db.users.find(x => x.id === req.user.id);
    if (!u) return;
    userFields.forEach(k => { if (req.body[k] !== undefined) u[k] = req.body[k]; });
    updated = u;
  });
  if (!updated) return res.status(404).json({ message: "User not found" });
  send(res, { user: updated });
});

app.post("/api/me/avatar", auth, upload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No image file provided" });
  const avatarUrl = await uploadToCloudinary(req.file, "evsmith/avatars");
  let user;
  updateDb(db => {
    user = db.users.find(u => u.id === req.user.id);
    if (user) user.avatar = avatarUrl;
  });
  if (!user) return res.status(404).json({ message: "User not found" });
  send(res, { avatar: avatarUrl, user });
});

app.post("/api/me/documents", auth, upload.fields([
  { name: "identity", maxCount: 1 },
  { name: "drivingLicence", maxCount: 1 }
]), async (req, res) => {
  let user;
  const identityUrl = req.files?.identity?.[0] ? await uploadToCloudinary(req.files.identity[0], "evsmith/documents") : null;
  const licenceUrl = req.files?.drivingLicence?.[0] ? await uploadToCloudinary(req.files.drivingLicence[0], "evsmith/documents") : null;

  updateDb(db => {
    user = db.users.find(x => x.id === req.user.id);
    if (!user) return;
    if (req.body.documentType) user.documentType = req.body.documentType;
    if (req.body.documentNumber) user.documentNumber = req.body.documentNumber;
    if (identityUrl) user.identityDocumentUrl = identityUrl;
    if (licenceUrl) user.drivingLicenceUrl = licenceUrl;
    user.kycStatus = "SUBMITTED";
  });
  if (!user) return res.status(404).json({ message: "User not found" });
  send(res, { message: "Documents submitted to Cloudinary", user });
});

// ---------------- BIKES ----------------
app.get("/api/bikes", auth, (req, res) => send(res, { bikes: readDb().bikes }));
app.get("/api/bikes/:id", auth, (req, res) => {
  const db = readDb();
  const bike = db.bikes.find(b => b.id === req.params.id);
  if (!bike) return res.status(404).json({ message: "Bike not found" });

  const bikeRentals = (db.rentals || []).filter(r => r.bikeId === bike.id);

  // Active / Ongoing Rental
  const activeRaw = bikeRentals.find(r => ["RESERVED", "ACTIVE", "OVERDUE"].includes(r.status));
  let activeRental = null;
  if (activeRaw) {
    const renter = (db.users || []).find(u => u.id === activeRaw.userId);
    activeRental = {
      ...activeRaw,
      user: renter ? { id: renter.id, name: renter.name, email: renter.email, mobile: renter.mobile } : null
    };
  }

  // Completed Rental History for this bike
  const rentalHistory = bikeRentals
    .filter(r => r.status === "COMPLETED")
    .map(r => {
      const renter = (db.users || []).find(u => u.id === r.userId);
      return {
        ...r,
        user: renter ? { id: renter.id, name: renter.name, email: renter.email, mobile: renter.mobile } : null
      };
    })
    .sort((a, b) => new Date(b.actualReturnAt || b.createdAt).getTime() - new Date(a.actualReturnAt || a.createdAt).getTime());

  // Weekly & Monthly Revenue Calculation
  const nowMs = Date.now();
  const sevenDaysAgo = nowMs - 7 * 86400000;
  const thirtyDaysAgo = nowMs - 30 * 86400000;

  let weeklyRevenue = 0;
  let monthlyRevenue = 0;
  let totalDistanceDriven = 0;

  bikeRentals.forEach(r => {
    if (["COMPLETED", "ACTIVE"].includes(r.status)) {
      const rTime = new Date(r.actualReturnAt || r.startAt || r.createdAt).getTime();
      const rev = Number(r.totalCharges || (Number(r.rentalAmount || 0) + Number(r.extraCharge || 0)));
      if (rTime >= sevenDaysAgo) weeklyRevenue += rev;
      if (rTime >= thirtyDaysAgo) monthlyRevenue += rev;
    }
    if (r.distanceKm) totalDistanceDriven += Number(r.distanceKm);
  });

  send(res, {
    bike,
    activeRental,
    rentalHistory,
    weeklyRevenue,
    monthlyRevenue,
    totalDistanceDriven
  });
});

const bikeFields = ["model","registrationNumber","chassisNumber","status","battery","odometer","rangeKm","topSpeed","rentalPerDay","extraHourRate","totalRentals","totalRevenue","extraHourRevenue","image"];
app.post("/api/admin/bikes", auth, adminOnly, upload.single("image"), async (req, res) => {
  let imageUrl = req.body.image || "";
  if (req.file) {
    const cloudUrl = await uploadToCloudinary(req.file, "bikes");
    if (cloudUrl) imageUrl = cloudUrl;
  }
  const bike = {
    id: id("B"),
    model: req.body.model || "EV Scooter",
    registrationNumber: req.body.registrationNumber || "",
    chassisNumber: req.body.chassisNumber || "",
    status: req.body.status || "AVAILABLE",
    battery: Number(req.body.battery ?? 100),
    odometer: Number(req.body.odometer ?? 0),
    rangeKm: Number(req.body.rangeKm ?? 0),
    topSpeed: Number(req.body.topSpeed ?? 0),
    rentalPerDay: Number(req.body.rentalPerDay ?? 0),
    extraHourRate: Number(req.body.extraHourRate ?? 0),
    totalRentals: Number(req.body.totalRentals ?? 0),
    totalRevenue: Number(req.body.totalRevenue ?? 0),
    extraHourRevenue: Number(req.body.extraHourRevenue ?? 0),
    image: imageUrl
  };
  updateDb(db => db.bikes.push(bike));
  send(res, { bike });
});
app.put("/api/admin/bikes/:id", auth, adminOnly, upload.single("image"), async (req, res) => {
  let bike;
  let newImageUrl = req.body.image;
  if (req.file) {
    const cloudUrl = await uploadToCloudinary(req.file, "bikes");
    if (cloudUrl) newImageUrl = cloudUrl;
  }
  updateDb(db => {
    bike = db.bikes.find(b => b.id === req.params.id);
    if (bike) {
      bikeFields.forEach(k => {
        if (req.body[k] !== undefined) {
          bike[k] = ["battery","odometer","rangeKm","topSpeed","rentalPerDay","extraHourRate","totalRentals","totalRevenue","extraHourRevenue"].includes(k)
            ? Number(req.body[k])
            : req.body[k];
        }
      });
      if (newImageUrl) bike.image = newImageUrl;
    }
  });
  if (!bike) return res.status(404).json({ message: "Bike not found" });
  send(res, { bike });
});

app.delete("/api/admin/bikes/:id", auth, adminOnly, (req, res) => {
  let deleted = false;
  updateDb(db => {
    const idx = db.bikes.findIndex(b => b.id === req.params.id);
    if (idx !== -1) {
      db.bikes.splice(idx, 1);
      deleted = true;
    }
  });
  if (!deleted) return res.status(404).json({ message: "Bike not found" });
  send(res, { ok: true, message: "Bike removed from fleet" });
});

// ---------------- RENTALS ----------------
function rentalCalc(bike, start, end) {
  const ms = Math.max(0, new Date(end) - new Date(start));
  const durationDays = Math.max(1, Math.ceil(ms / 86400000));
  return { durationDays, rentalAmount: durationDays * Number(bike.rentalPerDay || 0) };
}

function refreshOverdue(db) {
  const current = Date.now();
  db.rentals.forEach(r => {
    if (["ACTIVE", "OVERDUE"].includes(r.status) && new Date(r.expectedReturnAt).getTime() < current) {
      r.status = "OVERDUE";
      const extraMs = current - new Date(r.expectedReturnAt).getTime();
      const extraHours = Math.ceil(extraMs / 3600000);
      const bike = db.bikes.find(b => b.id === r.bikeId);
      r.extraHours = extraHours;
      r.extraCharge = extraHours * Number(bike?.extraHourRate || 40);
    }
  });
}

app.post("/api/rentals", auth, (req, res) => {
  console.log("POST /api/rentals called with body:", req.body);
  if (req.user.role !== "USER") return res.status(403).json({ message: "User only" });
  const { bikeId, startAt, expectedReturnAt, securityDeposit = 2000, customerSignature } = req.body;
  if (!bikeId || !startAt || !expectedReturnAt || !customerSignature) {
    console.log("Missing fields in request");
    return res.status(400).json({ message: "Bike, start time, return time, and signature are required" });
  }
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(expectedReturnAt).getTime();
  const nowMs = Date.now();

  // Validate start date is not in the past (15-min clock tolerance)
  if (startMs < nowMs - 15 * 60 * 1000) {
    return res.status(400).json({ message: "Rental start time cannot be in the past" });
  }

  if (endMs <= startMs) {
    return res.status(400).json({ message: "Return time must be after start time" });
  }

  const db = readDb();
  refreshOverdue(db);
  const bike = db.bikes.find(b => b.id === bikeId);
  if (!bike) return res.status(400).json({ message: "Bike not found" });

  const calc = rentalCalc(bike, startAt, expectedReturnAt);
  const rental = { 
    id: id("REN"), 
    userId: req.user.id, 
    bikeId, 
    startAt, 
    expectedReturnAt, 
    actualReturnAt: null, 
    durationDays: calc.durationDays, 
    rentalAmount: calc.rentalAmount, 
    securityDeposit: Number(securityDeposit), 
    customerSignature, 
    agreementSnapshot: db.agreement || null,
    extraHours: 0, 
    extraCharge: 0, 
    damageCharge: 0, 
    trafficFine: 0, 
    otherCharge: 0, 
    status: "RESERVED", 
    createdAt: now() 
  };

  try {
    updateDb(db2 => {
      // Transactional concurrency check: ensure bike is STILL available at time of write
      const targetBike = db2.bikes.find(x => x.id === bikeId);
      if (!targetBike || targetBike.status !== "AVAILABLE") {
        throw new Error("BIKE_UNAVAILABLE");
      }
      targetBike.status = "RESERVED";
      db2.rentals.push(rental);
      db2.notifications.unshift({
        id: id("NTF"),
        userId: req.user.id,
        title: "Booking Confirmed",
        message: `Your ${bike.model} rental is reserved.`,
        type: "RENTAL",
        read: false,
        createdAt: now()
      });
    });
  } catch (err) {
    if (err.message === "BIKE_UNAVAILABLE") {
      return res.status(409).json({ message: "This scooter was just reserved by another customer. Please choose another scooter." });
    }
    throw err;
  }

  send(res, { rental, totalDueNow: rental.rentalAmount + rental.securityDeposit });
});

app.get("/api/rentals", auth, (req, res) => {
  let rentals;
  updateDb(db => {
    refreshOverdue(db);
    const list = req.user.role === "ADMIN" ? db.rentals : db.rentals.filter(r => r.userId === req.user.id);
    rentals = list.map(r => {
      const bike = db.bikes.find(b => b.id === r.bikeId);
      const user = db.users.find(u => u.id === r.userId);
      return {
        ...r,
        bike,
        user: user ? { id: user.id, name: user.name, email: user.email, mobile: user.mobile } : null
      };
    });
  });
  send(res, { rentals });
});

app.post("/api/rentals/:id/return-request", auth, (req, res) => {
  let rental;
  updateDb(db => {
    rental = db.rentals.find(r => r.id === req.params.id && (req.user.role === "ADMIN" || r.userId === req.user.id));
    if (!rental) return;
    rental.returnRequested = true;
    rental.returnRequestedAt = now();
    db.notifications.unshift({
      id: id("NTF"),
      userId: rental.userId,
      title: "Return Request Submitted",
      message: `Return request received for ${rental.id}. Please visit hub for handover inspection.`,
      type: "RENTAL",
      read: false,
      createdAt: now()
    });
  });
  if (!rental) return res.status(404).json({ message: "Rental not found" });
  send(res, { rental, message: "Return request submitted successfully" });
});

app.get("/api/rentals/:id", auth, (req, res) => {
  const db = readDb();
  const rental = db.rentals.find(r => r.id === req.params.id);
  if (!rental) return res.status(404).json({ message: "Rental not found" });
  if (req.user.role !== "ADMIN" && rental.userId !== req.user.id) return res.status(403).json({ message: "Forbidden" });
  const bike = db.bikes.find(b => b.id === rental.bikeId);
  const user = db.users.find(u => u.id === rental.userId);
  send(res, {
    rental,
    bike,
    user: user ? { id: user.id, name: user.name, email: user.email, mobile: user.mobile } : null
  });
});

app.post("/api/rentals/:id/cancel", auth, (req, res) => {
  let rental;
  updateDb(db => {
    rental = db.rentals.find(r => r.id === req.params.id && (req.user.role === "ADMIN" || r.userId === req.user.id));
    if (!rental) return;
    if (rental.status !== "RESERVED") throw new Error("CANNOT_CANCEL");

    rental.status = "CANCELLED";
    rental.cancelledAt = now();
    const bike = db.bikes.find(b => b.id === rental.bikeId);
    if (bike && bike.status === "RESERVED") {
      bike.status = "AVAILABLE";
    }
    db.notifications.unshift({
      id: id("NTF"),
      userId: rental.userId,
      title: "Booking Cancelled",
      message: `Your booking for ${bike?.model || "EV Scooter"} has been cancelled.`,
      type: "RENTAL",
      read: false,
      createdAt: now()
    });
  });
  if (!rental) return res.status(404).json({ message: "Rental not found or cannot be cancelled" });
  send(res, { rental, message: "Booking cancelled successfully. Scooter released to available fleet." });
});

app.post("/api/admin/rentals/:id/handover", auth, adminOnly, (req, res) => {
  let rental;
  try {
    updateDb(db => {
      rental = db.rentals.find(r => r.id === req.params.id);
      if (!rental) return;
      if (!["RESERVED"].includes(rental.status)) throw new Error("INVALID_STATUS");

      const bike = db.bikes.find(b => b.id === rental.bikeId);
      const lastKnownKm = Number(bike?.odometer ?? 0);
      const startKm = Number(req.body.odometer ?? req.body.startKm ?? lastKnownKm);

      if (startKm < lastKnownKm) {
        throw new Error(`ODOMETER_ROLLBACK:${lastKnownKm}`);
      }

      const startBattery = Number(req.body.battery ?? bike?.battery ?? 100);

      rental.status = "ACTIVE";
      rental.startKm = startKm;
      rental.startBattery = startBattery;
      rental.handover = {
        ...req.body,
        odometer: startKm,
        battery: startBattery,
        at: now()
      };

      if (bike) {
        bike.status = "RENTED";
        bike.odometer = startKm;
        bike.battery = startBattery;
      }

      db.notifications.unshift({
        id: id("NTF"),
        userId: rental.userId,
        title: "Bike Handed Over",
        message: `Your ${bike?.model || "EV"} rental is active. Starting Odometer: ${startKm} km.`,
        type: "RENTAL",
        read: false,
        createdAt: now()
      });
    });
  } catch (e) {
    if (e.message.startsWith("ODOMETER_ROLLBACK")) {
      const min = e.message.split(":")[1];
      return res.status(400).json({ message: `Starting odometer cannot be less than scooter's last recorded odometer (${min} km).` });
    }
    if (e.message === "INVALID_STATUS") return res.status(400).json({ message: "Rental is not in RESERVED status" });
    throw e;
  }
  if (!rental) return res.status(404).json({ message: "Rental not found" });
  send(res, { rental });
});

app.post("/api/admin/rentals/:id/return", auth, adminOnly, (req, res) => {
  let result;
  try {
    updateDb(db => {
      const rental = db.rentals.find(r => r.id === req.params.id);
      if (!rental) return;
      if (!["ACTIVE", "OVERDUE"].includes(rental.status)) throw new Error("INVALID_STATUS");

      const bike = db.bikes.find(b => b.id === rental.bikeId);
      const actual = req.body.actualReturnAt || now();
      const extraMs = Math.max(0, new Date(actual) - new Date(rental.expectedReturnAt));
      const extraHours = Math.ceil(extraMs / 3600000);
      const extraCharge = extraHours * Number(bike?.extraHourRate || 40);

      // Starting and Ending KM tracking
      const startKm = Number(rental.startKm ?? rental.handover?.odometer ?? bike?.odometer ?? 0);
      const endKm = Number(req.body.odometer ?? req.body.endKm ?? startKm);

      if (endKm < startKm) {
        throw new Error(`INVALID_RETURN_ODO:${startKm}`);
      }

      const distanceKm = Math.max(0, endKm - startKm);
      const returnBattery = Number(req.body.battery ?? bike?.battery ?? 50);

      rental.actualReturnAt = actual;
      rental.extraHours = extraHours;
      rental.extraCharge = extraCharge;
      rental.damageCharge = Number(req.body.damageCharge || 0);
      rental.trafficFine = Number(req.body.trafficFine || 0);
      rental.otherCharge = Number(req.body.otherCharge || 0);
      rental.equipmentCharge = Number(req.body.equipmentCharge || 0);
      rental.helmetReturned = req.body.helmetReturned !== undefined ? Boolean(req.body.helmetReturned) : true;
      rental.chargerReturned = req.body.chargerReturned !== undefined ? Boolean(req.body.chargerReturned) : true;

      rental.startKm = startKm;
      rental.endKm = endKm;
      rental.distanceKm = distanceKm;
      rental.endBattery = returnBattery;

      rental.returnInspection = {
        ...req.body,
        odometer: endKm,
        battery: returnBattery,
        distanceKm,
        helmetReturned: rental.helmetReturned,
        chargerReturned: rental.chargerReturned,
        equipmentCharge: rental.equipmentCharge,
        at: now()
      };
      rental.status = "COMPLETED";
      rental.totalCharges = rental.rentalAmount + rental.extraCharge + rental.damageCharge + rental.trafficFine + rental.otherCharge + rental.equipmentCharge;
      rental.balance = rental.totalCharges - rental.securityDeposit;
      rental.settlementStatus = rental.balance <= 0 ? "REFUND_DUE" : "PAYMENT_DUE";

      if (bike) {
        bike.status = req.body.markMaintenance ? "MAINTENANCE" : "AVAILABLE";
        // CRITICAL: Set bike's current odometer to the returned endKm
        // so the NEXT user who rents this bike starts at this exact KM!
        bike.odometer = endKm;
        bike.battery = returnBattery;
        bike.totalRentals = Number(bike.totalRentals || 0) + 1;
        bike.totalRevenue = Number(bike.totalRevenue || 0) + rental.rentalAmount;
        bike.extraHourRevenue = Number(bike.extraHourRevenue || 0) + extraCharge;
      }

      db.notifications.unshift({
        id: id("NTF"),
        userId: rental.userId,
        title: "Rental Completed & Settled",
        message: `Trip distance: ${distanceKm} km. Final settlement: ₹${rental.totalCharges}.`,
        type: "PAYMENT",
        read: false,
        createdAt: now()
      });
      result = rental;
    });
  } catch (e) {
    if (e.message.startsWith("INVALID_RETURN_ODO")) {
      const s = e.message.split(":")[1];
      return res.status(400).json({ message: `Return odometer cannot be less than starting odometer (${s} km)` });
    }
    if (e.message === "INVALID_STATUS") return res.status(400).json({ message: "Rental is not active" });
    throw e;
  }
  if (!result) return res.status(404).json({ message: "Rental not found" });
  send(res, { rental: result });
});

app.post("/api/admin/rentals/:id/settle-balance", auth, adminOnly, (req, res) => {
  const { method = "UPI", transactionRef = "", notes = "" } = req.body;
  let rental;
  updateDb(db => {
    rental = db.rentals.find(r => r.id === req.params.id);
    if (!rental) return;
    if (rental.status !== "COMPLETED") throw new Error("NOT_COMPLETED");

    rental.settlementStatus = "SETTLED";
    rental.settlementDetails = {
      settledAt: now(),
      amount: Math.abs(rental.balance || 0),
      type: (rental.balance || 0) <= 0 ? "REFUND_DISBURSED" : "BALANCE_COLLECTED",
      method,
      transactionRef,
      notes
    };

    const isRefund = (rental.balance || 0) <= 0;
    db.notifications.unshift({
      id: id("NTF"),
      userId: rental.userId,
      title: isRefund ? "Deposit Refund Processed" : "Balance Payment Recorded",
      message: isRefund
        ? `Your deposit refund of ₹${Math.abs(rental.balance || 0)} has been processed via ${method} (Ref: ${transactionRef || "Hub Settlement"}).`
        : `Payment of outstanding balance of ₹${rental.balance} recorded via ${method}.`,
      type: "PAYMENT",
      read: false,
      createdAt: now()
    });
  });

  if (!rental) return res.status(404).json({ message: "Rental not found or not in completed status" });
  send(res, { rental, message: "Balance settlement recorded successfully" });
});

// ---------------- PAYMENTS ----------------
app.post("/api/payments", auth, upload.single("screenshot"), async (req, res) => {
  const { rentalId, amount, method = "QR", transactionId = "" } = req.body;
  const db = readDb(); const rental = db.rentals.find(r => r.id === rentalId);
  if (!rental || (req.user.role !== "ADMIN" && rental.userId !== req.user.id)) return res.status(404).json({ message: "Rental not found" });

  const screenshotUrl = req.file ? await uploadToCloudinary(req.file, "evsmith/payments") : null;
  const payment = { id: id("PAY"), rentalId, userId: rental.userId, amount: Number(amount), method, transactionId, screenshotUrl, status: req.user.role === "ADMIN" ? "APPROVED" : "PENDING", createdAt: now() };
  updateDb(db2 => { db2.payments.unshift(payment); db2.notifications.unshift({ id: id("NTF"), userId: rental.userId, title: "Payment Submitted", message: `Payment of ₹${payment.amount} submitted for verification.`, type: "PAYMENT", read: false, createdAt: now() }); });
  send(res, { payment });
});

app.get("/api/payments", auth, (req, res) => { 
  const db = readDb(); 
  const list = req.user.role === "ADMIN" ? db.payments : db.payments.filter(p => p.userId === req.user.id);
  const populated = (list || []).map(p => {
    const rent = (db.rentals || []).find(r => r.id === p.rentalId);
    const bike = rent ? (db.bikes || []).find(b => b.id === rent.bikeId) : null;
    const user = (db.users || []).find(u => u.id === p.userId);
    return {
      ...p,
      rental: rent ? { id: rent.id, status: rent.status, rentalAmount: rent.rentalAmount } : null,
      bike: bike ? { id: bike.id, model: bike.model, registrationNumber: bike.registrationNumber } : null,
      user: user ? { id: user.id, name: user.name, mobile: user.mobile } : null
    };
  });
  send(res, { payments: populated }); 
});

app.get("/api/admin/payments", auth, adminOnly, (req, res) => {
  const db = readDb();
  const list = db.payments || [];
  const populated = list.map(p => {
    const rent = (db.rentals || []).find(r => r.id === p.rentalId);
    const bike = rent ? (db.bikes || []).find(b => b.id === rent.bikeId) : null;
    const user = (db.users || []).find(u => u.id === p.userId);
    return {
      ...p,
      rental: rent ? { id: rent.id, status: rent.status, rentalAmount: rent.rentalAmount } : null,
      bike: bike ? { id: bike.id, model: bike.model, registrationNumber: bike.registrationNumber } : null,
      user: user ? { id: user.id, name: user.name, mobile: user.mobile } : null
    };
  });
  send(res, { payments: populated });
});

app.put("/api/admin/payments/:id", auth, adminOnly, (req, res) => {
  let payment;
  updateDb(db => { 
    payment = db.payments.find(p => p.id === req.params.id); 
    if (payment && ["PENDING","APPROVED","REJECTED"].includes(req.body.status)) {
      payment.status = req.body.status;
      if (payment.rentalId) {
        const rental = db.rentals.find(r => r.id === payment.rentalId);
        if (rental) {
          if (payment.status === "APPROVED") {
            rental.paymentStatus = "PAID";
            rental.paidAmount = (rental.paidAmount || 0) + Number(payment.amount || 0);
            db.notifications.unshift({
              id: id("NTF"),
              userId: rental.userId,
              title: "Payment Approved!",
              message: `Your payment of ₹${payment.amount} for booking ${rental.id} has been verified and approved.`,
              type: "PAYMENT",
              read: false,
              createdAt: now()
            });
          } else if (payment.status === "REJECTED") {
            rental.paymentStatus = "REJECTED";
            db.notifications.unshift({
              id: id("NTF"),
              userId: rental.userId,
              title: "Payment Rejected",
              message: `Payment of ₹${payment.amount} for booking ${rental.id} could not be verified. Please contact support.`,
              type: "PAYMENT",
              read: false,
              createdAt: now()
            });
          }
        }
      }
    }
  });
  if (!payment) return res.status(404).json({ message: "Payment not found" });
  send(res, { payment });
});

// ---------------- NOTIFICATIONS / ADMIN ----------------
app.get("/api/notifications", auth, (req, res) => { const db = readDb(); send(res, { notifications: req.user.role === "ADMIN" ? db.notifications : db.notifications.filter(n => n.userId === req.user.id) }); });

app.get("/api/admin/dashboard", auth, adminOnly, (req, res) => {
  const db = readDb(); 
  refreshOverdue(db); 
  const totalRevenue = (db.rentals || [])
    .filter(r => ["COMPLETED", "ACTIVE", "OVERDUE"].includes(r.status))
    .reduce((s, r) => s + Number(r.totalCharges || (Number(r.rentalAmount || 0) + Number(r.extraCharge || 0))), 0);

  send(res, {
    stats: {
      totalBikes: db.bikes.length,
      available: db.bikes.filter(b => b.status === "AVAILABLE").length,
      rented: db.bikes.filter(b => ["RENTED", "ACTIVE"].includes(b.status)).length,
      maintenance: db.bikes.filter(b => b.status === "MAINTENANCE").length,
      reserved: db.bikes.filter(b => b.status === "RESERVED").length,
      totalUsers: db.users.length,
      totalRentals: db.rentals.length,
      totalRevenue,
      pendingPayments: db.payments.filter(p => p.status === "PENDING").length,
      overdueRentals: db.rentals.filter(r => r.status === "OVERDUE").length
    }
  });
});
app.get("/api/admin/users", auth, adminOnly, (req,res)=>send(res,{users:readDb().users}));

app.put("/api/admin/users/:id/kyc", auth, adminOnly, (req, res) => {
  const { kycStatus, rejectionReason } = req.body;
  if (!["VERIFIED", "REJECTED", "PENDING", "SUBMITTED"].includes(kycStatus)) {
    return res.status(400).json({ message: "Invalid KYC status" });
  }
  let user;
  updateDb(db => {
    user = db.users.find(u => u.id === req.params.id);
    if (user) {
      user.kycStatus = kycStatus;
      if (rejectionReason) user.kycRejectionReason = rejectionReason;
      db.notifications.unshift({
        id: id("NTF"),
        userId: user.id,
        title: kycStatus === "VERIFIED" ? "KYC Approved! ✅" : "KYC Action Required ⚠️",
        message: kycStatus === "VERIFIED"
          ? "Your identity & driving licence have been verified. You can now rent any EV scooter!"
          : `KYC verification rejected: ${rejectionReason || "Uploaded documents were unclear. Please re-submit."}`,
        type: "KYC",
        read: false,
        createdAt: now()
      });
    }
  });
  if (!user) return res.status(404).json({ message: "User not found" });
  send(res, { user, message: `KYC marked as ${kycStatus}` });
});

// ---------------- BANNERS (CMS) ----------------
app.get("/api/banners", auth, (req, res) => {
  const db = readDb();
  send(res, { banners: db.banners || [] });
});

app.put("/api/admin/banners", auth, adminOnly, (req, res) => {
  const { banners } = req.body;
  if (!banners || !Array.isArray(banners)) return res.status(400).json({ message: "Invalid banners array" });
  updateDb(db => {
    db.banners = banners;
  });
  send(res, { banners });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`EVSmith API running on http://0.0.0.0:${PORT}`);

  // Connect MongoDB in background
  const MONGODB_URI = process.env.MONGODB_URI;
  if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
      .then(() => console.log("Connected to MongoDB Atlas successfully!"))
      .catch(err => console.warn("MongoDB connection warning:", err.message));
  }
});
