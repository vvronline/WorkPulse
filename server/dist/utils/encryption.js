"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.maskAccountNumber = maskAccountNumber;
const crypto_1 = __importDefault(require("crypto"));
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
function getKey() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key || key.length < 32) {
        throw new Error("ENCRYPTION_KEY must be set (at least 32 hex characters)");
    }
    return Buffer.from(key.slice(0, 64), "hex");
}
function encrypt(plaintext) {
    if (!plaintext)
        return null;
    const key = getKey();
    const iv = crypto_1.default.randomBytes(IV_LENGTH);
    const cipher = crypto_1.default.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag();
    return iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted;
}
function decrypt(ciphertext) {
    if (!ciphertext)
        return null;
    const key = getKey();
    const parts = ciphertext.split(":");
    if (parts.length !== 3)
        throw new Error("Invalid encrypted value format");
    const iv = Buffer.from(parts[0], "hex");
    const tag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];
    const decipher = crypto_1.default.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}
function maskAccountNumber(accountNumber) {
    if (!accountNumber || accountNumber.length < 4)
        return "****";
    return "****" + accountNumber.slice(-4);
}
//# sourceMappingURL=encryption.js.map