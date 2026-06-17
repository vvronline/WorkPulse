"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RazorpayPayoutService = void 0;
exports.getPayoutService = getPayoutService;
const encryption_1 = require("../utils/encryption");
const logger_1 = require("../utils/logger");
const RAZORPAY_BASE_URL = "https://api.razorpay.com/v1";
class RazorpayPayoutService {
    keyId;
    keySecret;
    accountNumber;
    authHeader;
    constructor(keyId, keySecret, accountNumber) {
        this.keyId = keyId;
        this.keySecret = keySecret;
        this.accountNumber = accountNumber;
        this.authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    }
    async _request(method, path, body = null) {
        const url = `${RAZORPAY_BASE_URL}${path}`;
        const headers = {
            "Authorization": this.authHeader,
            "Content-Type": "application/json",
        };
        const options = { method, headers };
        if (body) {
            options.body = JSON.stringify(body);
        }
        const response = await fetch(url, options);
        const data = (await response.json());
        if (!response.ok) {
            const errMsg = data?.error?.description || JSON.stringify(data);
            logger_1.logger.error({ status: response.status, data }, `Razorpay API error: ${path}`);
            throw new Error(`Razorpay API error (${response.status}): ${errMsg}`);
        }
        return data;
    }
    async createContact({ name, email, phone, type = "employee", referenceId }) {
        return this._request("POST", "/contacts", {
            name,
            email,
            contact: phone || undefined,
            type,
            reference_id: referenceId,
        });
    }
    async createFundAccount(contactId, { accountNumber, ifsc, name }) {
        return this._request("POST", "/fund_accounts", {
            contact_id: contactId,
            account_type: "bank_account",
            bank_account: {
                name,
                ifsc,
                account_number: accountNumber,
            },
        });
    }
    async validateFundAccount(fundAccountId, _opts) {
        return this._request("POST", "/fund_accounts/validations", {
            account_number: this.accountNumber,
            fund_account: {
                id: fundAccountId,
            },
            amount: 100,
            currency: "INR",
            notes: { purpose: "penny_drop_validation" },
        });
    }
    async createPayout({ fundAccountId, amount, currency = "INR", mode = "NEFT", purpose = "salary", referenceId, narration }) {
        return this._request("POST", "/payouts", {
            account_number: this.accountNumber,
            fund_account_id: fundAccountId,
            amount: Math.round(amount * 100),
            currency,
            mode,
            purpose,
            queue_if_low_balance: true,
            reference_id: referenceId,
            narration: narration || `Salary ${referenceId}`,
        });
    }
    async getPayout(payoutId) {
        return this._request("GET", `/payouts/${payoutId}`);
    }
    async testConnection() {
        const response = await fetch(`${RAZORPAY_BASE_URL}/balance?account_number=${this.accountNumber}`, {
            headers: { "Authorization": this.authHeader },
        });
        if (!response.ok) {
            const data = (await response.json());
            throw new Error(data?.error?.description || "Connection failed");
        }
        return { success: true, balance: (await response.json()).balance };
    }
}
exports.RazorpayPayoutService = RazorpayPayoutService;
async function getPayoutService(db, orgId) {
    const config = (await db.query(`SELECT * FROM org_payment_config WHERE org_id = $1 AND is_active = TRUE`, [orgId])).rows[0];
    if (!config)
        throw new Error("Payment configuration not found or disabled");
    const keyId = (0, encryption_1.decrypt)(config.api_key_id);
    const keySecret = (0, encryption_1.decrypt)(config.api_key_secret);
    if (!keyId || !keySecret || !config.account_number) {
        throw new Error("Incomplete payment configuration");
    }
    return new RazorpayPayoutService(keyId, keySecret, config.account_number);
}
//# sourceMappingURL=razorpayPayout.js.map