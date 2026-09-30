import jwt from "jsonwebtoken";

const secret = process.env.JWT_SECRET || "evsmith-development-secret";

export function signToken(payload) {
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}
export function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Authentication required" });
  try {
    req.user = jwt.verify(token, secret);
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}
export function adminOnly(req, res, next) {
  if (req.user?.role !== "ADMIN") return res.status(403).json({ message: "Admin access required" });
  next();
}
